import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configuredRelays, loadConfig } from "../src/config.js";
import { isPubkey } from "../src/control-protocol.js";
import { writePrivateJson } from "../src/control-files.js";
import { readPid } from "../src/daemon.js";
import { configureJoinedRelay } from "../src/daemon-join.js";
import { readKey } from "../src/keys.js";
import { pubkeyOf } from "../src/nostr.js";
import { addPairing } from "../src/pairing.js";
import { configPath, ownerKeyPath, yewholtHome } from "../src/paths.js";
import { claimInvite, consentToPolicy, withInviteInput, type Invite, type JoinOptions } from "../src/relay-join.js";
import { normalizeRelay, sameRelay } from "../src/relay-url.js";
import { targetIds } from "./install.js";
import { ProviderSecrets } from "./secrets.js";
import { loadTarget, providerHome, targetFile, targetRelays, validateTarget, validSshHost, type Target } from "./target.js";

export type Runner = (file: string, args: string[], stdin?: string) => Promise<string>;

export const runCommand: Runner = (file, args, stdin = "") => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const timer = setTimeout(() => { child.kill("SIGKILL"); }, 120_000);
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", () => {});
  child.once("error", () => { clearTimeout(timer); reject(new Error(`Could not run ${file}`)); });
  child.once("close", (code) => {
    clearTimeout(timer);
    if (code === 0) resolve(stdout);
    else reject(new Error(stderr.trim() || `${file} failed (exit ${code ?? "timeout"})`));
  });
  child.stdin.end(stdin);
});

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function remoteYh(host: string, args: string[], stdin = "", runner: Runner = runCommand): Promise<string> {
  if (!validSshHost(host)) throw new Error("Invalid SSH host");
  return runner("ssh", ["-o", "BatchMode=yes", host, "bash -lc " + quote("yh " + args.map(quote).join(" "))], stdin);
}

type StoredTarget = { id: string; target: Target };

export function updateJoinTarget(home: string, targets: StoredTarget[], daemonPubkey: string, relays: string[],
  preferredId: string, label: string, ssh?: string): StoredTarget {
  const existing = targets.find(({ target }) => target.daemonPubkey === daemonPubkey);
  let id = existing?.id ?? preferredId;
  if (!existing) {
    let suffix = 2;
    while (targets.some((target) => target.id === id)) id = preferredId.slice(0, 70) + "-" + suffix++;
  }
  const all = existing ? targetRelays(existing.target) : [];
  for (const relay of relays) if (!all.some((other) => sameRelay(other, relay))) all.push(relay);
  const [relay, ...additional] = all;
  const target = validateTarget(id, { ...existing?.target, id, label: existing?.target.label ?? label,
    transport: "relay", daemonPubkey, relay, ...(additional.length ? { relays: additional } : {}),
    ...(ssh === undefined ? {} : { ssh }) });
  writePrivateJson(targetFile(id, home), { id, ...target });
  const stored = { id, target };
  if (existing) existing.target = target;
  else targets.push(stored);
  return stored;
}

export type JoinSummary = { machine: string; status: "joined" | "already_member" | "failed"; reason?: string };
type Dependencies = {
  daemonHome: string; targetsHome: string; identity: () => string; runner: Runner;
  consent: typeof consentToPolicy; claim: typeof claimInvite; configure: typeof configureJoinedRelay;
  running: typeof readPid; log: (line: string) => void;
};

function hostId(host: string): string {
  return host.replace(/^.*@/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "").slice(0, 70) || "vm";
}

function remoteRelays(raw: string): string[] {
  const routes: unknown = JSON.parse(raw);
  if (!Array.isArray(routes) || !routes.length) throw new Error("Could not read remote relay configuration");
  return routes.map((route) => {
    const relay = normalizeRelay(route?.relayUrl);
    if (!relay) throw new Error("Invalid remote relay URL");
    return relay;
  });
}

export async function joinMachines(invite: Invite, hosts: string[], options: JoinOptions,
  ask: (question: string) => Promise<string>, overrides: Partial<Dependencies> = {}): Promise<JoinSummary[]> {
  const deps: Dependencies = {
    daemonHome: yewholtHome(), targetsHome: providerHome(), identity: () => new ProviderSecrets().identity(),
    runner: runCommand, consent: consentToPolicy, claim: claimInvite, configure: configureJoinedRelay,
    running: readPid, log: console.log, ...overrides,
  };
  const targets = targetIds(deps.targetsHome).map((id) => ({ id, target: loadTarget(id, deps.targetsHome) }));
  const sshHosts = [...new Set([...hosts, ...targets.flatMap(({ target }) => target.ssh ? [target.ssh] : [])])];
  if (!sshHosts.every(validSshHost)) throw new Error("Invalid SSH host");
  const installed = existsSync(configPath(deps.daemonHome));
  deps.log(`This invite needs ${1 + Number(installed) + sshHosts.length} uses (one per identity, including this Mac's provider).`);
  if (!installed) deps.log("Local daemon not installed; skipping. Install it first with yh install --relay <url> --relay-pubkey <pubkey>.");
  const consent = await deps.consent(invite, options, ask);
  const summary: JoinSummary[] = [];
  const attempt = async (machine: string, operation: () => Promise<"joined" | "already_member">) => {
    try {
      summary.push({ machine, status: await operation() });
    } catch (error) {
      const reason = (error instanceof Error ? error.message : "Join failed")
        .replaceAll(invite.code, "[redacted]").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 400);
      summary.push({ machine, status: "failed", reason });
    }
  };
  const secret = deps.identity();
  const provider = pubkeyOf(secret);
  await attempt("Mac provider", () => deps.claim(invite, consent, secret));
  if (installed) await attempt("My Mac daemon", async () => {
    const owner = readKey(ownerKeyPath(deps.daemonHome));
    const status = await deps.claim(invite, consent, owner);
    const added = await deps.configure(deps.daemonHome, invite.relayUrl, owner);
    const relays = configuredRelays(loadConfig(deps.daemonHome)).map(({ relayUrl }) => relayUrl);
    const { target } = updateJoinTarget(deps.targetsHome, targets, pubkeyOf(owner), relays, "mac", "My Mac");
    addPairing(deps.daemonHome, provider, target.label);
    for (const relay of relays.slice(1)) addPairing(deps.daemonHome, provider, target.label, undefined, relay);
    if ((status !== "already_member" || added) && deps.running(deps.daemonHome)) {
      const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
      for (const command of ["stop", "start"]) await deps.runner(process.execPath, [cli, command, "--home", deps.daemonHome]);
    }
    return status;
  });
  for (const host of sshHosts) await attempt(host, async () => {
    const remote = (args: string[], stdin?: string) => remoteYh(host, args, stdin, deps.runner);
    const keys = await remote(["admin", "keys"]);
    const daemon = /^owner ([a-f0-9]{64})\s*$/m.exec(keys)?.[1];
    if (!isPubkey(daemon)) throw new Error("Could not read remote daemon public key (yh admin keys)");
    const relays = remoteRelays(await remote(["relay", "list"]));
    const added = !relays.some((relay) => sameRelay(relay, invite.relayUrl));
    const flags = [...(consent.acceptPolicy ? ["--accept-policy"] : []), ...(consent.confirmAge ? ["--confirm-age"] : [])];
    const joined = await remote(["relay", "join", ...flags], `${invite.origin}/invite/${invite.code}\n`);
    const status = /Already a member of/.test(joined) ? "already_member" : "joined";
    const existing = targets.find(({ target }) => target.daemonPubkey === daemon);
    const label = existing?.target.label ?? host.slice(0, 120);
    await remote(["pair", "add", provider, "--label", label, "--relay", invite.relayUrl]);
    if ((status !== "already_member" || added) && /^daemon: running\b/m.test(await remote(["status"]))) {
      await remote(["stop"]);
      await remote(["start"]);
    }
    updateJoinTarget(deps.targetsHome, targets, daemon, [...relays, invite.relayUrl], hostId(host), label, host);
    return status;
  });
  for (const result of summary) deps.log(`${result.machine}: ${result.status === "already_member" ? "already member" : result.status}${result.reason ? ": " + result.reason : ""}`);
  return summary;
}

export function joinExitCode(summary: JoinSummary[]): 0 | 1 {
  return summary.some(({ status }) => status === "failed") ? 1 : 0;
}

export async function joinCommunity(args: string[]): Promise<void> {
  const usage = "Usage: yh join [<invite-url>] [--ssh <host> ...] [--accept-policy] [--confirm-age]";
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      ssh: { type: "string", multiple: true }, "accept-policy": { type: "boolean" }, "confirm-age": { type: "boolean" },
    } });
  } catch { throw new Error(usage); }
  if (parsed.positionals.length > 1) throw new Error(usage);
  await withInviteInput(parsed.positionals[0], async (invite, ask) => {
    const summary = await joinMachines(invite, parsed.values.ssh ?? [], {
      acceptPolicy: parsed.values["accept-policy"], confirmAge: parsed.values["confirm-age"],
    }, ask);
    process.exitCode = joinExitCode(summary);
  });
}
