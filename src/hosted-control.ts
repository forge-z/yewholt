import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadAgent, validateAgent, type AgentProvisioning } from "./agents.js";
import { readJson, record, syncDirectory, writePrivateJson } from "./control-files.js";
import { isModelReference, isPubkey, type Confirmation, type ControlEnvelope, type HostedOperation } from "./control-protocol.js";
import { parseModelLabel } from "./models.js";
import { signEvent, verifyAuthTag, type NostrEvent } from "./nostr.js";
import { agentsDir } from "./paths.js";

type Defaults = Pick<AgentProvisioning, "relayUrl" | "model">;
type Profile = { name: string; picture?: string };
type HostedState = {
  provider: string; owner: string; community: string;
  removed: boolean; activated: boolean; name?: string; activatedAt?: number;
  profile?: { request: string; issuedAt: number; eventId: string; createdAt: number; confirmed: boolean };
  model?: { choice: AgentProvisioning["model"]; issuedAt: number; eventId: string };
};
export type HostedEffects = {
  publishProfile: (agent: AgentProvisioning, event: NostrEvent) => Promise<void>;
  updateName: (pubkey: string, name: string) => Promise<void>;
  reconcileRemoval: (pubkey: string) => Promise<void>;
  reconcileModel?: () => Promise<void>;
  models?: () => string[] | Promise<string[]>;
  piLoginMissing?: () => Promise<boolean | undefined>;
  hasModel?: (choice: AgentProvisioning["model"]) => boolean | Promise<boolean>;
  paired?: () => Promise<void>;
};

const statePath = (home: string, pubkey: string) => join(home, "state", "hosted-agents", pubkey + ".json");
const readState = (home: string, pubkey: string) => readJson(statePath(home, pubkey)) as HostedState | undefined;

export function hostedLastDeploy(home: string, pubkey: string): number | undefined {
  return readState(home, pubkey)?.activatedAt;
}

function profile(value: unknown): Profile | undefined {
  if (!record(value) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 120 ||
      /[\x00-\x1f\x7f]/.test(value.name)) return;
  if (value.picture === undefined) return { name: value.name };
  if (typeof value.picture !== "string" || value.picture.length > 2048) return;
  try {
    const url = new URL(value.picture);
    if (url.protocol === "https:" && url.hostname && !url.username && !url.password) {
      return { name: value.name, picture: value.picture };
    }
  } catch { /* Invalid picture. */ }
}

export class HostedControl {
  constructor(private readonly home: string, private readonly defaults: Defaults) {}

  manages(pubkey: string): boolean {
    return lstatSync(statePath(this.home, pubkey), { throwIfNoEntry: false }) !== undefined;
  }

  reconcile(agent: AgentProvisioning): boolean {
    const state = readState(this.home, agent.pubkey);
    if (state?.removed) {
      this.unlinkAgent(join(agentsDir(this.home), agent.pubkey + ".json"));
      return false;
    }
    if (state?.name) agent.name = state.name;
    if (state?.model) agent.model = state.model.choice;
    return true;
  }

  private unlinkAgent(path: string): void {
    if (!lstatSync(path, { throwIfNoEntry: false })) return;
    unlinkSync(path);
    syncDirectory(agentsDir(this.home));
  }

  async apply(op: HostedOperation, event: NostrEvent, envelope: ControlEnvelope, body: unknown,
    reserved: boolean, now: number, effects: HostedEffects, authorize: () => boolean,
    confirmation: Confirmation): Promise<string | undefined> {
    const pubkey = envelope.agentPubkey;
    const path = join(agentsDir(this.home), pubkey + ".json");
    const pathToState = statePath(this.home, pubkey);
    if (reserved || !record(body) || typeof body.community !== "string" ||
        !isPubkey(body.owner) || !Array.isArray(body.authTag) ||
        !body.authTag.every((entry) => typeof entry === "string") || body.authTag[2] !== "" ||
        verifyAuthTag(body.authTag, pubkey, Math.floor(now / 1000), 0) !== body.owner) {
      return "invalid hosted agent authorization";
    }
    const { owner, community, authTag } = body;
    let state = readState(this.home, pubkey);
    if (state && (state.provider !== event.pubkey || state.owner !== owner || state.community !== community)) {
      return "hosted agent belongs to another provider or owner";
    }
    if (!state && lstatSync(path, { throwIfNoEntry: false })) return "agent is not managed by this provider";
    if (!authorize()) return "provider not paired";

    if (op === "hosted-remove") {
      if (!state?.removed) {
        writePrivateJson(pathToState, { provider: event.pubkey, owner, community, activated: false, removed: true,
          activatedAt: state?.activatedAt });
      }
      this.unlinkAgent(path);
      await effects.reconcileRemoval(pubkey);
      return;
    }
    if (state?.removed) return "hosted agent was removed";

    if (op === "hosted-model") {
      if (!state?.activated) return "hosted agent is not active in this provider";
      const agent = loadAgent(path, pubkey, this.defaults);
      if (!("nsec" in agent) || agent.ownerPubkey !== owner || agent.relayUrl !== this.defaults.relayUrl) {
        return "hosted provisioning is missing or invalid";
      }
      const current = state.model;
      let choice = current?.choice ?? agent.model;
      if (body.model !== undefined) {
        if (!isModelReference(body.model) || body.model.toLowerCase().includes(agent.nsec)) return "invalid model reference";
        if (!effects.reconcileModel) return "hosted model editing unavailable";
        if (current && current.eventId !== event.id && (envelope.issuedAt < current.issuedAt ||
            (envelope.issuedAt === current.issuedAt && event.id > current.eventId))) return "stale hosted model update";
        if (current?.eventId !== event.id) {
          choice = parseModelLabel(body.model);
          if (!await effects.hasModel?.(choice)) return "selected model is not available on the daemon";
          if (!authorize()) return "provider not paired";
          // Preserve the provisioning file version: replacing it can restart a stopped agent.
          writePrivateJson(pathToState, { ...state, model: { choice, issuedAt: envelope.issuedAt, eventId: event.id } });
        }
        await effects.reconcileModel();
      }
      const reference = `${choice.provider}/${choice.modelId}`;
      confirmation.model = isModelReference(reference) ? reference : null;
      return;
    }

    const metadata = profile(body);
    if (!metadata) return "invalid hosted agent profile";
    let agent: AgentProvisioning;
    if (op === "hosted-activate") {
      const provisioning = validateAgent(record(body.agent) ? { ...body.agent, relayUrl: this.defaults.relayUrl } : null,
        pubkey, this.defaults);
      if (!("nsec" in provisioning) || provisioning.name !== metadata.name ||
          provisioning.ownerPubkey !== owner ||
          JSON.stringify(provisioning.authTag) !== JSON.stringify(authTag) ||
          JSON.stringify(metadata).toLowerCase().includes(provisioning.nsec)) {
        return "invalid hosted provisioning";
      }
      if (state?.activated) {
        return lstatSync(path, { throwIfNoEntry: false }) ? undefined : "hosted provisioning is missing";
      }
      if (record(body.agent) && body.agent.model !== undefined && !await effects.hasModel?.(provisioning.model)) {
        return "selected model is not available on the daemon";
      }
      if (!authorize()) return "provider not paired";
      agent = provisioning;
      if (!state) {
        state = { provider: event.pubkey, owner, community, removed: false, activated: false };
        writePrivateJson(pathToState, state);
      }
    } else {
      if (!state?.activated) return "hosted agent is not active in this provider";
      const actual = loadAgent(path, pubkey, this.defaults);
      if (!("nsec" in actual) || actual.ownerPubkey !== owner || actual.relayUrl !== this.defaults.relayUrl ||
          JSON.stringify(metadata).toLowerCase().includes(actual.nsec)) return "hosted provisioning is missing or invalid";
      agent = actual;
    }
    const current = state.profile;
    if (current && current.request !== envelope.requestId && (envelope.issuedAt < current.issuedAt ||
        (envelope.issuedAt === current.issuedAt && event.id >= current.eventId))) return "stale hosted profile";
    if (current?.request === envelope.requestId && current.confirmed) return;
    const createdAt = current?.request === envelope.requestId ? current.createdAt
      : Math.max(Math.floor(now / 1000), (current?.createdAt ?? 0) + 1);
    if (createdAt > Math.floor(now / 1000) + 30) return "hosted profile updates are too frequent";
    const eventToPublish = signEvent(agent.nsec, 0,
      JSON.stringify({ ...metadata, display_name: metadata.name }), [agent.authTag], createdAt);
    const pending = { request: envelope.requestId, issuedAt: envelope.issuedAt, eventId: event.id, createdAt, confirmed: false };
    writePrivateJson(pathToState, { ...state, profile: pending });
    await effects.publishProfile(agent, eventToPublish);
    if (op === "hosted-activate" && !lstatSync(path, { throwIfNoEntry: false })) {
      const { pubkey: _pubkey, ownerPubkey: _owner, model, ...file } = agent;
      writePrivateJson(path, { ...file, model: record(body.agent) && body.agent.model !== undefined ? model : undefined });
    }
    await effects.updateName(pubkey, metadata.name);
    writePrivateJson(pathToState, { ...state, name: metadata.name, activated: true,
      activatedAt: state.activatedAt ?? now, profile: { ...pending, confirmed: true } });
  }
}
