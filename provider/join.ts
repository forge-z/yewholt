import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configuredRelays, loadConfig } from "../src/config.js";
import { isPubkey } from "../src/control-protocol.js";
import { writePrivateJson } from "../src/control-files.js";
import { readPid } from "../src/daemon.js";
import { configureJoinedRelay, initializeDaemon } from "../src/daemon-join.js";
import { readKey } from "../src/keys.js";
import { pubkeyOf } from "../src/nostr.js";
import { addPairing } from "../src/pairing.js";
import { configPath, ownerKeyPath, yewholtHome } from "../src/paths.js";
import { discoverRelayPubkey, readRelayMembers } from "../src/relay-discovery.js";
import { claimInvite, consentToPolicy, inviteRelayPubkey, withInviteInput, type Invite, type JoinOptions } from "../src/relay-join.js";
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

function remoteShell(host: string, command: string, stdin: string, runner: Runner): Promise<string> {
  if (!validSshHost(host)) throw new Error("Invalid SSH host");
  return runner("ssh", ["-o", "BatchMode=yes", host, "bash -lc " + quote(command)], stdin);
}

export function remoteYh(host: string, args: string[], stdin = "", runner: Runner = runCommand): Promise<string> {
  return remoteShell(host, "yh " + args.map(quote).join(" "), stdin, runner);
}

async function remoteInstallState(host: string, runner: Runner): Promise<"installed" | "fresh"> {
  const inspect = `
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw Error("Yewholt requires Node.js 22.19 or newer");
    const home = process.env.YEWHOLT_HOME ?? require("node:os").homedir() + "/.yewholt";
    const config = require("node:fs").lstatSync(require("node:path").join(home, "config.json"), { throwIfNoEntry: false });
    console.log(config ? "yewholt:installed" : "yewholt:fresh");
  `;
  const result = await remoteShell(host,
    'command -v yh >/dev/null || { echo "yh not on the SSH login PATH; install it first" >&2; exit 1; }; ' +
    'command -v node >/dev/null || { echo "node not on the SSH login PATH; install Node.js 22.19+" >&2; exit 1; }; ' +
    "node --input-type=commonjs -e " + quote(inspect) + " && yh help >/dev/null", "", runner);
  const state = result.trim().split("\n").at(-1);
  if (state === "yewholt:installed") return "installed";
  if (state === "yewholt:fresh") return "fresh";
  throw new Error("Could not read SSH daemon installation state");
}

type StoredTarget = { id: string; target: Target };

export function updateJoinTarget(home: string, targets: StoredTarget[], daemonPubkey: string, relays: string[],
  preferredId: string, label: string, ssh?: string, onUpdated?: (target: StoredTarget) => void): StoredTarget {
  const matches = targets.filter(({ target }) => target.daemonPubkey === daemonPubkey);
  if (!matches.length) {
    let id = preferredId;
    let suffix = 2;
    while (targets.some((target) => target.id === id)) id = preferredId.slice(0, 70) + "-" + suffix++;
    const all: string[] = [];
    for (const relay of relays) if (!all.some((other) => sameRelay(other, relay))) all.push(relay);
    const [relay, ...additional] = all;
    const target = validateTarget(id, { id, label, transport: "relay", daemonPubkey, relay,
      ...(additional.length ? { relays: additional } : {}), ...(ssh === undefined ? {} : { ssh }) });
    const stored = { id, target };
    writePrivateJson(targetFile(id, home), { id, ...target });
    targets.push(stored);
    onUpdated?.(stored);
    return stored;
  }
  for (const existing of matches) {
    const all = targetRelays(existing.target);
    for (const relay of relays) if (!all.some((other) => sameRelay(other, relay))) all.push(relay);
    const changed = all.length !== targetRelays(existing.target).length || (ssh !== undefined && existing.target.ssh === undefined);
    if (!changed) continue;
    const [relay, ...additional] = all;
    const target = validateTarget(existing.id, { ...existing.target, id: existing.id, relay,
      ...(additional.length ? { relays: additional } : {}),
      ...(ssh === undefined ? {} : { ssh: existing.target.ssh ?? ssh }) });
    writePrivateJson(targetFile(existing.id, home), { id: existing.id, ...target });
    existing.target = target;
    onUpdated?.(existing);
  }
  return matches[0];
}

export type JoinSummary = { machine: string; status: "joined" | "already_member" | "failed"; reason?: string };
type Dependencies = {
  daemonHome: string; targetsHome: string; identity: () => string; runner: Runner;
  consent: typeof consentToPolicy; claim: typeof claimInvite; configure: typeof configureJoinedRelay;
  relayKey: typeof inviteRelayPubkey;
  running: typeof readPid; log: (line: string) => void;
  members: (relay: string, secret: string) => Promise<ReadonlySet<string>>;
};

type MachineOptions = JoinOptions & { local?: boolean };

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

export async function joinMachines(invite: Invite, hosts: string[], options: MachineOptions,
  ask: (question: string) => Promise<string>, overrides: Partial<Dependencies> = {}): Promise<JoinSummary[]> {
  const deps: Dependencies = {
    daemonHome: yewholtHome(), targetsHome: providerHome(), identity: () => new ProviderSecrets().identity(),
    runner: runCommand, consent: consentToPolicy, claim: claimInvite, configure: configureJoinedRelay, relayKey: inviteRelayPubkey,
    members: async (relay, secret) => readRelayMembers(relay, secret, await discoverRelayPubkey(relay, secret)),
    running: readPid, log: console.log, ...overrides,
  };
  const targets = targetIds(deps.targetsHome).map((id) => ({ id, target: loadTarget(id, deps.targetsHome) }));
  const sshHosts = [...new Set([...hosts, ...targets.flatMap(({ target }) => target.ssh ? [target.ssh] : [])])];
  if (!sshHosts.every(validSshHost)) throw new Error("Invalid SSH host");
  const installed = existsSync(configPath(deps.daemonHome));
  const local = installed || options.local === true;
  const localName = "My Mac daemon";
  const uses = 1 + Number(local) + sshHosts.length;
  deps.log(`Allow up to ${uses} invite uses (one per identity not yet admitted, including this Mac's provider).`);
  if (!local) deps.log("Local daemon not installed; skipping. Use yh join --local to initialize it.");
  const consent = await deps.consent(invite, options, ask);
  const summary: JoinSummary[] = [];
  const updatedTargets = new Set<string>();
  const onUpdated = ({ id }: StoredTarget) => { updatedTargets.add(id); };
  const handled = new Set<string>();
  const reasonOf = (error: unknown) => (error instanceof Error ? error.message : "Join failed")
    .replaceAll(invite.code, "[redacted]").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 400);
  const failed = new Map<string, string>();
  const prepare = async <T>(machine: string, operation: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      return await operation();
    } catch (error) {
      failed.set(machine, reasonOf(error));
      return undefined;
    }
  };
  const attempt = async (machine: string, operation: () => Promise<"joined" | "already_member">) => {
    const reason = failed.get(machine);
    if (reason !== undefined) {
      summary.push({ machine, status: "failed", reason });
      return;
    }
    try {
      summary.push({ machine, status: await operation() });
    } catch (error) {
      summary.push({ machine, status: "failed", reason: reasonOf(error) });
    }
  };
  const report = () => {
    for (const result of summary) deps.log(`${result.machine}: ${result.status === "already_member" ? "already member" : result.status}${result.reason ? ": " + result.reason : ""}`);
    for (const id of updatedTargets) deps.log(`Target ${id}: updated for ${invite.relayUrl}`);
    return summary;
  };
  let keyLookup: Promise<string> | undefined;
  const relayKey = () => keyLookup ??= deps.relayKey(invite);
  const localOwner = local ? await prepare(localName, async () => {
    if (!installed) {
      initializeDaemon(deps.daemonHome, { relayUrl: invite.relayUrl, externalRelayPubkey: await relayKey() });
    }
    loadConfig(deps.daemonHome);
    return readKey(ownerKeyPath(deps.daemonHome));
  }) : undefined;
  const prepareVm = (host: string) => prepare(host, async () => {
    const remote = (args: string[], stdin?: string) => remoteYh(host, args, stdin, deps.runner);
    const fresh = await remoteInstallState(host, deps.runner) === "fresh";
    const registered = targets.filter(({ target }) => target.ssh === host);
    if (fresh && registered.length) throw new Error("Registered SSH target has no daemon config; restore its existing home first");
    if (fresh) await remote(["install", "--relay", invite.relayUrl, "--relay-pubkey", await relayKey()]);
    const relays = remoteRelays(await remote(["relay", "list"]));
    const keys = await remote(["admin", "keys"]);
    const daemon = /^owner ([a-f0-9]{64})\s*$/m.exec(keys)?.[1];
    if (!isPubkey(daemon)) throw new Error("Could not read remote daemon public key (yh admin keys)");
    if (registered.length && !registered.some(({ target }) => target.daemonPubkey === daemon)) {
      throw new Error("SSH daemon identity changed; restore its existing home first");
    }
    return { remote, relays, daemon };
  });
  const vms: Awaited<ReturnType<typeof prepareVm>>[] = [];
  for (const host of sshHosts) vms.push(await prepareVm(host));
  if (failed.size > 0 && failed.size === uses - 1) {
    for (const [machine, reason] of failed) summary.push({ machine, status: "failed", reason });
    return report();
  }
  const secret = deps.identity();
  const provider = pubkeyOf(secret);
  await attempt("Mac provider", () => deps.claim(invite, consent, secret));
  if (local) await attempt(localName, async () => {
    const owner = localOwner!;
    const status = await deps.claim(invite, consent, owner);
    const added = await deps.configure(deps.daemonHome, invite.relayUrl, owner);
    const relays = configuredRelays(loadConfig(deps.daemonHome)).map(({ relayUrl }) => relayUrl);
    const { target } = updateJoinTarget(deps.targetsHome, targets, pubkeyOf(owner), [...relays, invite.relayUrl], "mac", "My Mac", undefined, onUpdated);
    handled.add(pubkeyOf(owner));
    addPairing(deps.daemonHome, provider, target.label);
    for (const relay of relays.slice(1)) addPairing(deps.daemonHome, provider, target.label, undefined, relay);
    if ((status !== "already_member" || added) && deps.running(deps.daemonHome)) {
      const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
      for (const command of ["stop", "start"]) await deps.runner(process.execPath, [cli, command, "--home", deps.daemonHome]);
    }
    return status;
  });
  for (const [i, host] of sshHosts.entries()) await attempt(host, async () => {
    const { remote, daemon, relays } = vms[i]!;
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
    updateJoinTarget(deps.targetsHome, targets, daemon, [...relays, invite.relayUrl], hostId(host), label, host, onUpdated);
    handled.add(daemon);
    return status;
  });
  const pending = targets.filter(({ target }) => !handled.has(target.daemonPubkey) &&
    !targetRelays(target).some((relay) => sameRelay(relay, invite.relayUrl)));
  if (pending.length && summary[0].status !== "failed") {
    try {
      const members = await deps.members(invite.relayUrl, secret);
      for (const { id, target } of pending) {
        if (members.has(target.daemonPubkey)) {
          updateJoinTarget(deps.targetsHome, targets, target.daemonPubkey, [invite.relayUrl], id, target.label, undefined, onUpdated);
        }
      }
    } catch (error) {
      summary.push({ machine: "Registered target membership check", status: "failed", reason: reasonOf(error) });
    }
  }
  return report();
}

export function joinExitCode(summary: JoinSummary[]): 0 | 1 {
  return summary.some(({ status }) => status === "failed") ? 1 : 0;
}

export async function joinCommunity(args: string[]): Promise<void> {
  const usage = "Usage: yh join [<invite-url>] [--local] [--ssh <host> ...] [--accept-policy] [--confirm-age]";
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      local: { type: "boolean" }, ssh: { type: "string", multiple: true },
      "accept-policy": { type: "boolean" }, "confirm-age": { type: "boolean" },
    } });
  } catch { throw new Error(usage); }
  if (parsed.positionals.length > 1) throw new Error(usage);
  await withInviteInput(parsed.positionals[0], async (invite, ask) => {
    const summary = await joinMachines(invite, parsed.values.ssh ?? [], {
      local: parsed.values.local, acceptPolicy: parsed.values["accept-policy"], confirmAge: parsed.values["confirm-age"],
    }, ask);
    process.exitCode = joinExitCode(summary);
  });
}
