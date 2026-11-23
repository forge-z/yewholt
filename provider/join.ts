import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configuredRelays, loadConfig } from "../src/config.js";
import { controlEvent, isPubkey } from "../src/control-protocol.js";
import { writePrivateJson } from "../src/control-files.js";
import { readPid } from "../src/daemon.js";
import { configureJoinedRelay, initializeDaemon } from "../src/daemon-join.js";
import { readKey } from "../src/keys.js";
import { addPairing } from "../src/pairing.js";
import { configPath, ownerKeyPath, yewholtHome } from "../src/paths.js";
import { discoverRelayPubkey, readRelayMembers } from "../src/relay-discovery.js";
import { RelayClient } from "../src/nostr-client.js";
import { pubkeyOf, verifyEvent, type NostrEvent } from "../src/nostr.js";
import { OFFER_TAG, OWNER_TAG, offerKey, offerTag, pairingProof, writePairingOffer } from "../src/pairing-offer.js";
import { waitForConfirmation } from "./relay.js";
import { claimInvite, consentToPolicy, inviteRelayPubkey, relayOperator, withInviteInput, type Invite, type JoinOptions } from "../src/relay-join.js";
import { normalizeRelay, sameRelay } from "../src/relay-url.js";
import { targetIds } from "./install.js";
import { ProviderSecrets } from "./secrets.js";
import { checkTargetModels } from "./status.js";
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
  relayKey: typeof inviteRelayPubkey; operator: typeof relayOperator;
  running: typeof readPid; log: (line: string) => void;
  members: (relay: string, secret: string) => Promise<ReadonlySet<string>>;
  checkModels: typeof checkTargetModels;
  offers: (relay: string, secret: string, key: string, members: () => Promise<ReadonlySet<string>>) => Promise<PairingOfferFound[]>;
  pair: (relay: string, daemon: string, secret: string, event: NostrEvent, requestId: string) =>
    Promise<{ result: "confirmed" | "refused" | "timeout"; error?: string }>;
};

export type PairingOfferFound = { daemon: string; label: string };

/** Newest kind 0 profile per member that carries a pairing tag only a holder of the invite could compute. */
export function matchingOffers(events: Iterable<NostrEvent>, members: ReadonlySet<string>, key: string): PairingOfferFound[] {
  return offeringProfiles(events, members, (event) => event.tags.some((tag) => tag[0] === OFFER_TAG && tag[1] === offerTag(key, event.pubkey)));
}

/** Newest kind 0 profile per member whose open offer names this owner. */
export function ownerOffers(events: Iterable<NostrEvent>, members: ReadonlySet<string>, owner: string): PairingOfferFound[] {
  return offeringProfiles(events, members, (event) => event.tags.some((tag) => tag[0] === OFFER_TAG) &&
    event.tags.some((tag) => tag[0] === OWNER_TAG && tag[1] === owner));
}

function offeringProfiles(events: Iterable<NostrEvent>, members: ReadonlySet<string>,
  offers: (event: NostrEvent) => boolean): PairingOfferFound[] {
  const newest = new Map<string, NostrEvent>();
  for (const event of events) {
    try {
      if (event.kind !== 0 || !members.has(event.pubkey) || !verifyEvent(event)) continue;
    } catch {
      continue;
    }
    const old = newest.get(event.pubkey);
    if (!old || event.created_at > old.created_at) newest.set(event.pubkey, event);
  }
  return [...newest.values()].flatMap((event) => {
    if (!offers(event)) return [];
    let label = "";
    try {
      const profile: unknown = JSON.parse(event.content);
      const name = profile && typeof profile === "object" ? (profile as Record<string, unknown>).name : undefined;
      if (typeof name === "string") label = name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 120);
    } catch { /* Unnamed daemons get a generic label. */ }
    return [{ daemon: event.pubkey, label: label || "Yewholt VM" }];
  });
}

async function readOffers(relay: string, secret: string, key: string,
  roster: () => Promise<ReadonlySet<string>>): Promise<PairingOfferFound[]> {
  const members = await roster();
  return matchingOffers(await readProfiles(relay, secret, members), members, key);
}

async function readProfiles(relay: string, secret: string, members: ReadonlySet<string>): Promise<NostrEvent[]> {
  const authors = [...members].filter((member) => member !== pubkeyOf(secret));
  if (!authors.length) return [];
  const client = new RelayClient(relay, secret, undefined, false);
  const events: NostrEvent[] = [];
  let timer: NodeJS.Timeout | undefined;
  try {
    await client.connect(15_000);
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Pairing offer lookup timed out for ${relay}`)), 15_000);
      client.subscribe("join-offers", [{ kinds: [0], authors }], (event) => { events.push(event); },
        (_id, reason) => reject(new Error(`Pairing offer lookup rejected: ${reason}`)), () => resolve());
    });
  } finally {
    clearTimeout(timer);
    client.unsubscribe("join-offers");
    await client.close();
  }
  return events;
}

type OwnerDiscovery = {
  operator: typeof relayOperator;
  members: (relay: string, secret: string) => Promise<ReadonlySet<string>>;
  profiles: (relay: string, secret: string, members: ReadonlySet<string>) => Promise<NostrEvent[]>;
};

/**
 * Adds a target for each VM in this community whose open offer names the relay operator. The VM pairs only when the
 * operator's Buzz signs the first agent created on it, so listing it here grants nothing by itself.
 */
export async function addOwnerOfferTargets(community: string, secret: string, home = providerHome(),
  overrides: Partial<OwnerDiscovery> = {}): Promise<string[]> {
  const deps: OwnerDiscovery = {
    operator: relayOperator, members: async (relay, key) => readRelayMembers(relay, key, await discoverRelayPubkey(relay, key)),
    profiles: readProfiles, ...overrides,
  };
  const relay = normalizeRelay(community);
  if (!relay) return [];
  const owner = await deps.operator(relay.replace(/^ws/, "http").replace(/\/$/, ""), secret);
  if (!owner) return [];
  const members = await deps.members(relay, secret);
  const offers = ownerOffers(await deps.profiles(relay, secret, members), members, owner);
  const targets = targetIds(home).map((id) => ({ id, target: loadTarget(id, home) }));
  const added: string[] = [];
  for (const { daemon, label } of offers) {
    if (targets.some(({ target }) => target.daemonPubkey === daemon && targetRelays(target).some((url) => sameRelay(url, relay)))) continue;
    added.push(updateJoinTarget(home, targets, daemon, [relay], hostId(label), label).id);
  }
  return added;
}

async function requestPairing(relay: string, daemon: string, secret: string, event: NostrEvent, requestId: string) {
  let error: string | undefined;
  const result = await waitForConfirmation({ label: "pairing", transport: "relay", relay, daemonPubkey: daemon },
    secret, event, requestId, daemon, 60_000, (body) => { if (typeof body.error === "string") error = body.error; });
  return { result, error };
}

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

async function activateDaemon(startStopped: boolean, reconnect: boolean, running: () => boolean | Promise<boolean>,
  run: (command: "start" | "stop") => Promise<string>): Promise<void> {
  if (!startStopped && !reconnect) return;
  if (await running()) {
    if (!reconnect) return;
    await run("stop");
  } else if (!startStopped) {
    return;
  }
  await run("start");
}

async function modelCheckMessage({ id, target }: StoredTarget, relay: string, secret: string,
  deps: Dependencies, host?: string): Promise<string> {
  const retest = `Re-test from the Mac: yh targets doctor ${id}.`;
  try {
    const result = await deps.checkModels(id, { ...target, relay, ssh: host }, secret);
    if (result.ok) return "Models available.";
    if (!result.needsLogin) return `${result.message} ${retest}`;
  } catch {
    return `Could not check the daemon's model catalog. ${retest}`;
  }
  let account = "the daemon's OS user";
  try {
    const username = host
      ? (await remoteShell(host, "id -un", "", deps.runner)).trim().split("\n").at(-1)
      : userInfo().username;
    if (username && /^[^\s\x00-\x1f\x7f-\x9f]+$/.test(username)) account = `OS user "${username}"`;
  } catch {
    // Still give the login steps if the account lookup fails.
  }
  const location = host ? `on ${host} (ssh -t ${quote(host)})` : "on this Mac";
  return `No models available. As ${account} ${location}, run yh and enter /login using the daemon's HOME and Pi agent directory. ` +
    `Then restart the daemon (yh stop && yh start for a CLI-managed daemon). ${retest}`;
}

export async function joinMachines(invite: Invite, hosts: string[], options: MachineOptions,
  ask: (question: string) => Promise<string>, overrides: Partial<Dependencies> = {}): Promise<JoinSummary[]> {
  const deps: Dependencies = {
    daemonHome: yewholtHome(), targetsHome: providerHome(), identity: () => new ProviderSecrets().identity(),
    runner: runCommand, consent: consentToPolicy, claim: claimInvite, configure: configureJoinedRelay, relayKey: inviteRelayPubkey, operator: relayOperator,
    members: async (relay, secret) => readRelayMembers(relay, secret, await discoverRelayPubkey(relay, secret)),
    running: readPid, log: console.log, checkModels: checkTargetModels, offers: readOffers, pair: requestPairing,
    ...overrides,
  };
  const targets = targetIds(deps.targetsHome).map((id) => ({ id, target: loadTarget(id, deps.targetsHome) }));
  const selectedHosts = new Set(hosts);
  const sshHosts = [...new Set([...selectedHosts, ...targets.flatMap(({ target }) => target.ssh ? [target.ssh] : [])])];
  if (!sshHosts.every(validSshHost)) throw new Error("Invalid SSH host");
  const installed = existsSync(configPath(deps.daemonHome));
  const local = installed || options.local === true;
  const localName = "My Mac daemon";
  const uses = 1 + Number(local) + sshHosts.length;
  // The provider key is created only once nothing earlier can fail; a Mac-only join needs it for the membership check.
  let secret = !local && !sshHosts.length ? deps.identity() : "";
  let roster: Promise<ReadonlySet<string>> | undefined;
  const members = () => roster ??= deps.members(invite.relayUrl, secret).catch((error: unknown) => {
    roster = undefined;
    throw error;
  });
  // Pairing an already-admitted Mac with a VM must not spend another use of a single-use invite.
  const providerMember = !local && !sshHosts.length && await members().then((set) => set.has(pubkeyOf(secret)), () => false);
  if (!providerMember) {
    deps.log(`Allow up to ${uses} invite uses (one per identity not yet admitted, including this Mac's provider).`);
  }
  if (!local) deps.log("Local daemon not installed; skipping. Use yh join --local to initialize it.");
  const consent = providerMember ? { acceptPolicy: false, confirmAge: false } : await deps.consent(invite, options, ask);
  const summary: JoinSummary[] = [];
  const updatedTargets = new Set<string>();
  const onUpdated = ({ id }: StoredTarget) => { updatedTargets.add(id); };
  const handled = new Set<string>();
  const modelChecks: { machine: string; target: StoredTarget; host?: string }[] = [];
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
  secret ||= deps.identity();
  const provider = pubkeyOf(secret);
  await attempt("Mac provider", async () => providerMember ? "already_member" : deps.claim(invite, consent, secret));
  if (local) await attempt(localName, async () => {
    const owner = localOwner!;
    const daemon = pubkeyOf(owner);
    const status = await deps.claim(invite, consent, owner);
    const added = await deps.configure(deps.daemonHome, invite.relayUrl, owner);
    const relays = configuredRelays(loadConfig(deps.daemonHome)).map(({ relayUrl }) => relayUrl);
    const label = targets.find(({ target }) => target.daemonPubkey === daemon)?.target.label ?? "My Mac";
    addPairing(deps.daemonHome, provider, label);
    for (const relay of relays.slice(1)) addPairing(deps.daemonHome, provider, label, undefined, relay);
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    await activateDaemon(options.local === true, status !== "already_member" || added,
      () => Boolean(deps.running(deps.daemonHome)),
      (command) => deps.runner(process.execPath, [cli, command, "--home", deps.daemonHome]));
    const target = updateJoinTarget(deps.targetsHome, targets, daemon, [...relays, invite.relayUrl], "mac", label, undefined, onUpdated);
    modelChecks.push({ machine: localName, target });
    handled.add(daemon);
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
    await activateDaemon(selectedHosts.has(host), status !== "already_member" || added,
      async () => /^daemon: running\b/m.test(await remote(["status"])), (command) => remote([command]));
    const target = updateJoinTarget(deps.targetsHome, targets, daemon, [...relays, invite.relayUrl], hostId(host), label, host, onUpdated);
    modelChecks.push({ machine: host, target, host });
    handled.add(daemon);
    return status;
  });
  if (summary[0].status !== "failed") {
    const key = offerKey(invite.code, invite.relayUrl);
    let offers: PairingOfferFound[] = [];
    try {
      offers = (await deps.offers(invite.relayUrl, secret, key, members)).filter(({ daemon }) => !handled.has(daemon));
    } catch (error) {
      deps.log(`Could not look for VMs waiting to pair: ${reasonOf(error)}`);
    }
    for (const { daemon, label } of offers) await attempt(label, async () => {
      const requestId = randomUUID();
      const event = controlEvent(secret, daemon, "pair", { requestId, agentPubkey: daemon },
        { proof: pairingProof(key, provider, daemon, requestId), label: hostname().slice(0, 120) || "My Mac" });
      const { result, error } = await deps.pair(invite.relayUrl, daemon, secret, event, requestId);
      if (result === "refused") throw new Error(`Pairing refused${error ? ": " + error : ""}`);
      if (result === "timeout") throw new Error("The VM did not answer; start its daemon with yh start and run yh join again");
      const existing = targets.find(({ target }) => target.daemonPubkey === daemon);
      const target = updateJoinTarget(deps.targetsHome, targets, daemon, [invite.relayUrl], hostId(label), existing?.target.label ?? label,
        undefined, onUpdated);
      modelChecks.push({ machine: label, target });
      handled.add(daemon);
      return "joined";
    });
  }
  const pending = targets.filter(({ target }) => !handled.has(target.daemonPubkey) &&
    !targetRelays(target).some((relay) => sameRelay(relay, invite.relayUrl)));
  if (pending.length && summary[0].status !== "failed") {
    try {
      const roster = await members();
      for (const { id, target } of pending) {
        if (roster.has(target.daemonPubkey)) {
          updateJoinTarget(deps.targetsHome, targets, target.daemonPubkey, [invite.relayUrl], id, target.label, undefined, onUpdated);
        }
      }
    } catch (error) {
      summary.push({ machine: "Registered target membership check", status: "failed", reason: reasonOf(error) });
    }
  }
  report();
  const modelMessages = await Promise.all(modelChecks.map(async ({ machine, target, host }) =>
    `${machine}: ${await modelCheckMessage(target, invite.relayUrl, secret, deps, host)}`));
  for (const message of modelMessages) deps.log(message);
  return summary;
}

export function joinExitCode(summary: JoinSummary[]): 0 | 1 {
  return summary.some(({ status }) => status === "failed") ? 1 : 0;
}

/** Joins this machine's daemon from the machine itself and leaves an invite-bound pairing offer for the provider. */
export async function joinDaemon(invite: Invite, options: JoinOptions, ask: (question: string) => Promise<string>,
  overrides: Partial<Dependencies> = {}): Promise<JoinSummary[]> {
  const deps: Dependencies = {
    daemonHome: yewholtHome(), targetsHome: providerHome(), identity: () => new ProviderSecrets().identity(),
    runner: runCommand, consent: consentToPolicy, claim: claimInvite, configure: configureJoinedRelay, relayKey: inviteRelayPubkey, operator: relayOperator,
    members: async (relay, secret) => readRelayMembers(relay, secret, await discoverRelayPubkey(relay, secret)),
    running: readPid, log: console.log, checkModels: checkTargetModels,
    offers: readOffers, pair: requestPairing, ...overrides,
  };
  const machine = "This daemon";
  try {
    const installed = existsSync(configPath(deps.daemonHome));
    if (!installed) {
      initializeDaemon(deps.daemonHome, { relayUrl: invite.relayUrl, externalRelayPubkey: await deps.relayKey(invite) });
    }
    loadConfig(deps.daemonHome);
    const owner = readKey(ownerKeyPath(deps.daemonHome));
    // A rerun (say, after the offer expired) must not spend a single-use invite again.
    const member = installed && await deps.members(invite.relayUrl, owner).then((set) => set.has(pubkeyOf(owner)), () => false);
    const status = member ? "already_member" : await deps.claim(invite, await deps.consent(invite, options, ask), owner);
    await deps.configure(deps.daemonHome, invite.relayUrl, owner);
    const operator = await deps.operator(invite.origin, owner);
    writePairingOffer(deps.daemonHome, invite.code, invite.relayUrl, undefined, undefined, operator);
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    await activateDaemon(true, true, () => Boolean(deps.running(deps.daemonHome)),
      (command) => deps.runner(process.execPath, [cli, command, "--home", deps.daemonHome]));
    deps.log(operator
      ? "Next, in Buzz on the relay operator's Mac: create a Yewholt agent and pick this machine as its target within 24 hours. " +
        "That first agent pairs the Mac's provider with this daemon; no invite is needed there."
      : "Next, on the Mac: run yh join and paste the same invite within 24 hours. The Mac pairs with this daemon over Buzz " +
        "without spending another invite use when its provider is already a member.");
    deps.log("Models: run yh here and enter /login, then restart the daemon (yh stop && yh start).");
    return [{ machine, status }];
  } catch (error) {
    return [{ machine, status: "failed", reason: error instanceof Error ? error.message : "Join failed" }];
  }
}

export async function joinCommunity(args: string[]): Promise<void> {
  const usage = "Usage: yh join [<invite-url>] [--daemon | --local] [--ssh <host> ...] [--accept-policy] [--confirm-age]";
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      daemon: { type: "boolean" }, local: { type: "boolean" }, ssh: { type: "string", multiple: true },
      "accept-policy": { type: "boolean" }, "confirm-age": { type: "boolean" },
    } });
  } catch { throw new Error(usage); }
  if (parsed.positionals.length > 1) throw new Error(usage);
  if (parsed.values.daemon && (parsed.values.local || parsed.values.ssh?.length)) throw new Error(usage);
  await withInviteInput(parsed.positionals[0], async (invite, ask) => {
    const summary = parsed.values.daemon ? await joinDaemon(invite, {
      acceptPolicy: parsed.values["accept-policy"], confirmAge: parsed.values["confirm-age"],
    }, ask) : await joinMachines(invite, parsed.values.ssh ?? [], {
      local: parsed.values.local, acceptPolicy: parsed.values["accept-policy"], confirmAge: parsed.values["confirm-age"],
    }, ask);
    process.exitCode = joinExitCode(summary);
  });
}
