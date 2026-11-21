import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { record, writePrivateJson } from "../src/control-files.js";
import { RelayClient } from "../src/nostr-client.js";
import { targetIds } from "./install.js";
import { InvalidTargetRelay, loadTarget, privateJson, providerHome, type Target } from "./target.js";
import { ProviderSecrets } from "./secrets.js";

const RECENT_MS = 10 * 60 * 1_000;
const failures = {
  package: "invalid package",
  deploy: "deploy failed",
  refused: "relay or daemon refused",
  timeout: "no confirmation",
  wake: "wake failed; no confirmation",
} as const;

type Outcome = { pubkey: string } | { failure: keyof typeof failures };

function directory(id: string, target: Target): string {
  const digest = createHash("sha256").update(JSON.stringify([target.transport, target.relay, target.daemonPubkey])).digest("hex");
  return join(providerHome(), "status", id, digest);
}

export function recordOutcome(id: string, target: Target, outcome: Outcome): void {
  try {
    const dir = directory(id, target);
    const time = Date.now();
    if ("pubkey" in outcome) writePrivateJson(join(dir, "agents", outcome.pubkey + ".json"), { time });
    else writePrivateJson(join(dir, "failure.json"), { time, failure: outcome.failure });
  } catch {
    // A diagnostic write must not turn an acknowledged deploy into a failure.
  }
}

function read(path: string) {
  try {
    const value = privateJson(path);
    if (record(value) && typeof value.time === "number" && Number.isSafeInteger(value.time) && value.time > 0 &&
        value.time <= 8.64e15) return { time: value.time, failure: value.failure };
  } catch {
    // Optional local diagnostic evidence.
  }
}

function evidence(id: string, target: Target) {
  const dir = directory(id, target);
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, "agents")).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  } catch {
    // No evidence has been recorded yet.
  }
  const receipts = names.map((name) => read(join(dir, "agents", name))).filter((receipt) => receipt !== undefined);
  const lastDeploy = receipts.reduce<number | undefined>((latest, { time }) => Math.max(latest ?? time, time), undefined);
  const failure = read(join(dir, "failure.json"));
  const lastFailure = failure && typeof failure.failure === "string" && Object.hasOwn(failures, failure.failure)
    ? date(failure.time) + " (" + failures[failure.failure as keyof typeof failures] + ")" : "—";
  return { agents: receipts.length, lastDeploy, lastFailure };
}

function date(time: number | undefined): string {
  return time === undefined ? "—" : new Date(time).toISOString();
}

function safeText(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function daemonEvidence(time: number | undefined): string {
  if (time === undefined) return "no confirmation";
  const age = Date.now() - time;
  return age >= 0 && age <= RECENT_MS ? "recent confirmation" : "historical confirmation";
}

export function listTargets(): void {
  console.log("TARGET\tRELAY\tDAEMON / REACHABILITY EVIDENCE\tLAST CONFIRMATION\tAGENTS DEPLOYED\tLAST DEPLOY\tLAST FAILURE");
  for (const id of targetIds()) {
    try {
      const target = loadTarget(id);
      const { agents, lastDeploy, lastFailure } = evidence(id, target);
      const daemon = target.daemonPubkey + " (" + daemonEvidence(lastDeploy) + ")";
      console.log([id + " (" + safeText(target.label) + ")", safeText(target.relay), daemon,
        date(lastDeploy), agents, date(lastDeploy), lastFailure].join("\t"));
    } catch (error) {
      console.log(id + "\t" + (error instanceof InvalidTargetRelay ? error.message : "invalid target configuration"));
    }
  }
}

async function probe(target: Target, secret: string | undefined): Promise<string> {
  if (!secret) return "not tested (run yewholt provider install)";
  const client = new RelayClient(target.relay, secret, undefined, false);
  const start = performance.now();
  let opened = false;
  try {
    await client.connect(4_000, () => { opened = true; });
    return "reachable, NIP-42 authenticated; connect + AUTH latency " +
      Math.round(performance.now() - start) + " ms";
  } catch {
    return opened ? "reachable, NIP-42 AUTH failed or timed out" : "unreachable or timed out";
  } finally {
    await client.close();
  }
}

export async function doctorTargets(id?: string): Promise<void> {
  const ids = id === undefined ? targetIds() : [id];
  if (!ids.length) return console.log("No configured targets.");
  let identity: string | undefined;
  let identityLoaded = false;
  const rows = await Promise.all(ids.map(async (id) => {
    let target: Target;
    try {
      target = loadTarget(id);
    } catch (error) {
      if (error instanceof InvalidTargetRelay) throw error;
      throw new Error("Invalid or missing target configuration");
    }
    const { lastDeploy } = evidence(id, target);
    if (!identityLoaded) {
      identityLoaded = true;
      try {
        identity = new ProviderSecrets().identity(false);
      } catch {
        // Report unavailable without printing the storage exception.
      }
    }
    return [
      id + ":",
      "  Relay: " + await probe(target, identity),
      "  Pairing / daemon: " + daemonEvidence(lastDeploy) + " (recorded evidence only; no live daemon probe)",
      "  Last confirmation: " + date(lastDeploy),
      "  Daemon version: unavailable (control v1 does not report it)",
    ];
  }));
  for (const row of rows) console.log(row.join("\n"));
}
