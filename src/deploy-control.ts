import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadAgent, validateAgent, type AgentProvisioning } from "./agents.js";
import { readJson, record, writePrivateJson } from "./control-files.js";
import { controlEvent, decryptControl, verifiedEnvelope, type Confirmation, type ControlEnvelope } from "./control-protocol.js";
import { pubkeyOf, type NostrEvent } from "./nostr.js";
import { readPairing } from "./pairing.js";
import { agentsDir } from "./paths.js";

type Defaults = Pick<AgentProvisioning, "relayUrl" | "model">;
type JobError = "invalid provisioning" | "stale deploy";
type Receipt = { agentPubkey: string; error?: JobError };
type Head = {
  key: string; eventId: string; issuedAt: number; lastDeploy: number; digest: string; pending: boolean;
};
type Ledger = { version: 1; jobs: Record<string, Receipt>; agents: Record<string, Head> };
const ledgerPath = (home: string) => join(home, "state", "control.json");

function loadLedger(home: string): Ledger {
  const value = readJson(ledgerPath(home));
  if (value === undefined) return { version: 1, jobs: {}, agents: {} };
  if (!record(value) || value.version !== 1 || !record(value.jobs) || !record(value.agents)) {
    throw new Error("Invalid control state");
  }
  for (const item of Object.values(value.jobs)) {
    if (!record(item) || typeof item.agentPubkey !== "string" ||
        (item.error !== undefined && item.error !== "invalid provisioning" && item.error !== "stale deploy")) {
      throw new Error("Invalid control receipt");
    }
  }
  for (const item of Object.values(value.agents)) {
    if (!record(item) || typeof item.key !== "string" || typeof item.eventId !== "string" ||
        !Number.isSafeInteger(item.issuedAt) || !Number.isSafeInteger(item.lastDeploy) ||
        typeof item.digest !== "string" || typeof item.pending !== "boolean") throw new Error("Invalid control deploy state");
  }
  return value as Ledger;
}

export function lastDeploys(home: string): Map<string, number> {
  try {
    return new Map(Object.entries(loadLedger(home).agents)
      .filter(([, head]) => !head.pending && head.lastDeploy > 0).map(([agent, head]) => [agent, head.lastDeploy]));
  } catch {
    return new Map();
  }
}

function provisioningFile({ name, nsec, authTag, relayUrl, model, permissions, respondTo, respondToAllowlist, channelId }: AgentProvisioning) {
  return {
    name, nsec, authTag, relayUrl, model: Object.values(model).every((value) => value.trim()) ? model : undefined,
    permissions, respondTo, respondToAllowlist, channelId,
  };
}

function digest(file: ReturnType<typeof provisioningFile>): string {
  return createHash("sha256").update(JSON.stringify(file)).digest("hex");
}

export class DeployControl {
  readonly pubkey: string;

  constructor(private readonly home: string, private readonly secret: string,
    private readonly defaults: Defaults, private readonly now = () => Date.now()) {
    this.pubkey = pubkeyOf(secret);
  }

  async handle(event: NostrEvent, reserved: (pubkey: string) => Promise<boolean>): Promise<NostrEvent | null> {
    const envelope = verifiedEnvelope(event, this.pubkey, "deploy");
    if (!envelope) return null;
    const confirmation: Confirmation = { job: envelope.requestId, agentPubkey: envelope.agentPubkey, ok: false };
    const now = this.now();
    try {
      const pairing = readPairing(this.home, event.pubkey);
      if (!pairing) confirmation.error = "provider not paired";
      else if (envelope.issuedAt < pairing.pairedAt || envelope.issuedAt > now + 60_000) {
        confirmation.error = "deploy outside pairing window";
      } else {
        let body: unknown;
        try {
          body = decryptControl(envelope, this.secret, event.pubkey);
        } catch {
          confirmation.error = "invalid ciphertext";
        }
        if (!confirmation.error) {
          const isReserved = envelope.agentPubkey === this.pubkey || await reserved(envelope.agentPubkey);
          const currentPairing = readPairing(this.home, event.pubkey);
          if (!currentPairing || currentPairing.pairedAt !== pairing.pairedAt) confirmation.error = "provider not paired";
          else confirmation.error = this.apply(event, envelope, body, isReserved, now);
        }
      }
    } catch {
      confirmation.error = "deploy could not be recorded";
    }
    confirmation.ok = confirmation.error === undefined;
    return controlEvent(this.secret, event.pubkey, "confirmation", envelope, confirmation, this.now());
  }

  private apply(event: NostrEvent, envelope: ControlEnvelope, body: unknown, reserved: boolean, now: number): JobError | undefined {
    const { agentPubkey, requestId, issuedAt } = envelope;
    const key = `${event.pubkey}:${requestId}`;
    const state = loadLedger(this.home);
    const path = join(agentsDir(this.home), `${agentPubkey}.json`);
    const actual = loadAgent(path, agentPubkey, this.defaults);
    const actualDigest = "nsec" in actual ? digest(provisioningFile(actual)) : undefined;
    let head = state.agents[agentPubkey];
    if (head?.pending && head.digest === actualDigest) {
      head = { ...head, pending: false };
      state.agents[agentPubkey] = head;
      state.jobs[head.key] = { agentPubkey };
      writePrivateJson(ledgerPath(this.home), state);
    }
    const prior = state.jobs[key];
    if (prior) return prior.agentPubkey === agentPubkey ? prior.error : "invalid provisioning";
    const recordResult = (error?: JobError) => {
      state.jobs[key] = { agentPubkey, error };
      writePrivateJson(ledgerPath(this.home), state);
      return error;
    };
    const parsed = record(body) && body.channelId === null ? { ...body, channelId: undefined } : body;
    const validated = validateAgent(parsed, agentPubkey, this.defaults);
    if (reserved || !("nsec" in validated)) {
      return recordResult("invalid provisioning");
    }
    const file = provisioningFile(validated);
    const nextDigest = digest(file);
    const retry = head?.pending && head.key === key && head.digest === nextDigest;
    if (head?.pending && head.key === key && !retry) return "invalid provisioning";
    if (head && !retry && (issuedAt < head.issuedAt || (issuedAt === head.issuedAt && event.id >= head.eventId))) {
      return recordResult("stale deploy");
    }
    const changed = actualDigest !== nextDigest;
    const nextHead: Head = retry ? head : {
      key, issuedAt, eventId: event.id, lastDeploy: changed ? now : head?.lastDeploy ?? 0, digest: nextDigest, pending: changed,
    };
    state.agents[agentPubkey] = nextHead;
    if (changed) {
      // The digest lets a replay distinguish an interrupted install from one already renamed.
      writePrivateJson(ledgerPath(this.home), state);
      writePrivateJson(path, file);
    }
    nextHead.pending = false;
    return recordResult();
  }
}
