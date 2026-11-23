import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { record, writePrivateJson } from "../src/control-files.js";
import { isModelReference } from "../src/control-protocol.js";
import { pubkeyOf } from "../src/nostr.js";
import { RelayClient } from "../src/nostr-client.js";
import { targetIds } from "./install.js";
import { probeModelCatalog, readDaemonWakeUrl } from "./relay.js";
import { InvalidTargetRelay, loadTarget, privateJson, providerHome, targetRelays, type Target } from "./target.js";
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
      for (const relay of targetRelays(target)) {
        const { agents, lastDeploy, lastFailure } = evidence(id, { ...target, relay });
        const daemon = target.daemonPubkey + " (" + daemonEvidence(lastDeploy) + ")";
        console.log([id + " (" + safeText(target.label) + ")", safeText(relay), daemon,
          date(lastDeploy), agents, date(lastDeploy), lastFailure].join("\t"));
      }
    } catch (error) {
      console.log(id + "\t" + (error instanceof InvalidTargetRelay ? error.message : "invalid target configuration"));
    }
  }
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export async function checkTargetModels(id: string, target: Target, secret: string | undefined):
  Promise<{ ok: boolean; message: string; needsLogin?: boolean }> {
  const fail = (message: string) => ({ ok: false, message });
  if (!secret) return fail("Provider identity missing; run yh provider install on this machine.");
  const client = new RelayClient(target.relay, secret, undefined, false);
  const start = performance.now();
  const host = target.ssh ? "target host (" + target.ssh + ")" : "target host";
  const login = `on the ${host}, run yh as the daemon user (same HOME and PI_CODING_AGENT_DIR), then enter /login`;
  const restart = "restart the daemon (yh stop && yh start for a CLI-managed daemon)";
  const admit = "ask the relay administrator to run buzz-admin add-member --pubkey " + pubkeyOf(secret) + " for this relay";
  const relayFix = `restore the relay at ${safeText(target.relay)} or rerun yh targets add ${id} --relay <reachable-url> --daemon ${target.daemonPubkey} with any other relay, label and wake options`;
  let opened = false;
  let authenticated = false;
  try {
    await client.connect(4_000, () => { opened = true; });
    authenticated = true;
    const latency = Math.round(performance.now() - start);
    const result = await probeModelCatalog(client, target, secret, randomUUID(), 4_000);
    if (result === "relay") return fail(`Relay control request not acknowledged; ${admit} and check that the relay allows kind 1059 traffic.`);
    if (result === "daemon") {
      if (await readDaemonWakeUrl(client, target.daemonPubkey)) {
        return fail("VM appears to be sleeping; send a message to one of its agents to wake it.");
      }
      return fail(`Daemon offline or not responding; on the ${host}, run yh start as the daemon user (or start its configured service). If already running, run yh status and verify this relay and daemon pubkey.`);
    }
    if (!result.ok && result.error === "provider not paired") {
      return fail(`Provider not paired; on the ${host}, run yh pair add ${pubkeyOf(secret)} --label ${id} --relay ${quote(new URL(target.relay).href)} as the daemon user.`);
    }
    const catalog = result.catalog;
    if (!result.ok || !record(catalog) || !Array.isArray(catalog.models) || !catalog.models.every(isModelReference) ||
        (catalog.next !== undefined && (!catalog.models.length || catalog.next !== catalog.models.length))) {
      return fail(`Model catalog unavailable; run yh update on the ${host}, ${restart}, then rerun yh targets doctor ${id}.`);
    }
    if (!catalog.models.length) {
      const message = result.piLoginMissing === true
        ? `Pi login missing for the daemon user (model catalog empty); ${login}; ${restart}.`
        : `Model catalog empty; ${login} and select a supported provider; ${restart}.`;
      return { ...fail(message), needsLogin: true };
    }
    return { ok: true, message: `OK — Relay reachable, NIP-42 authenticated; connect + AUTH latency ${latency} ms; daemon online, provider paired, models available.` };
  } catch {
    if (authenticated) return fail(`Relay control request failed; ${admit} and check that the relay allows kind 1059 traffic.`);
    if (opened) return fail(`Relay reachable, NIP-42 AUTH failed or timed out; ${admit}.`);
    return fail(`Relay unreachable or timed out; ${relayFix}.`);
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
      return [{ ok: false, configError: true, message: id + ": " + (error instanceof InvalidTargetRelay
        ? error.message : "Invalid or missing target configuration; run yh targets add " + id + " --relay <url> --daemon <pubkey>.") }];
    }
    if (!identityLoaded) {
      identityLoaded = true;
      try {
        identity = new ProviderSecrets().identity(false);
      } catch {
        // Report unavailable without printing the storage exception.
      }
    }
    const relays = targetRelays(target);
    return Promise.all(relays.map(async (relay) => {
      const { ok, message } = await checkTargetModels(id, { ...target, relay }, identity);
      return { ok, configError: false, message: id + (relays.length === 1 ? ": " : " (" + safeText(relay) + "): ") + message };
    }));
  }));
  for (const { ok, configError, message } of rows.flat()) {
    if (configError) console.error(message);
    else console.log(message);
    if (!ok) process.exitCode = 1;
  }
}
