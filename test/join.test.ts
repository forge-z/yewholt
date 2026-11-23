import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { joinExitCode, joinMachines, remoteYh, updateJoinTarget, type Runner } from "../provider/join.js";
import { loadTarget, targetFile, validateTarget, type Target } from "../provider/target.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { configureJoinedRelay, initializeDaemon } from "../src/daemon-join.js";
import { writePrivateJson } from "../src/control-files.js";
import { readKey, writeKey } from "../src/keys.js";
import { generateKeyPair, pubkeyOf, signEvent, verifyEvent, type NostrEvent } from "../src/nostr.js";
import { readPairing } from "../src/pairing.js";
import { configPath, envFilePath, ownerKeyPath } from "../src/paths.js";
import { discoverRelayPubkey, readRelayMembers } from "../src/relay-discovery.js";
import { claimInvite, consentToPolicy, inviteRelayPubkey, parseInvite, type Consent } from "../src/relay-join.js";
import { route, usageText } from "../src/route.js";

const invite = parseInvite("https://buzz.example/invite/test-token");
const provider = generateKeyPair(), owner = generateKeyPair(), remoteOwner = generateKeyPair(), relay = generateKeyPair();
const primary = "wss://primary.example";
const consent: Consent = { receipt: "receipt", acceptPolicy: true, confirmAge: true };

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "yewholt-join-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const daemonHome = join(home, "daemon"), targetsHome = join(home, "provider");
  return { daemonHome, targetsHome, checkModels: async () => ({ ok: true, message: "Models available." }),
    offers: async () => [] };
}

function install(home: string) {
  writeKey(ownerKeyPath(home), owner.secret);
  saveConfig(home, { relayUrl: primary, externalRelayPubkey: relay.pubkey });
}

test("join routes as a provider-side command and documents all flags", () => {
  assert.deepEqual(route(["join", "--ssh", "vm"]), { kind: "command", command: "join", args: ["--ssh", "vm"] });
  assert.match(usageText(), /join \[<invite-url>\] \[--daemon \| --local\] \[--ssh <host> \.\.\.\] \[--accept-policy\] \[--confirm-age\]/);
});

test("SSH helper quotes remote yh arguments, uses login bash, and sends invite only on stdin", async () => {
  const calls: unknown[][] = [];
  const runner: Runner = async (...args) => { calls.push(args); return "ok"; };
  const url = `${invite.origin}/invite/${invite.code}\n`;
  await remoteYh("me@vm.example", ["relay", "join", "--accept-policy", "--confirm-age"], url, runner);
  assert.deepEqual(calls[0], ["ssh", ["-o", "BatchMode=yes", "me@vm.example",
    "bash -lc 'yh '\\''relay'\\'' '\\''join'\\'' '\\''--accept-policy'\\'' '\\''--confirm-age'\\'''"], url]);
  assert.ok(!JSON.stringify(calls[0].slice(0, 2)).includes(invite.code));
  await remoteYh("vm", ["pair", "add", provider.pubkey, "--label", "Owner's Mac; $(touch bad)"], "", runner);
  assert.ok(String((calls[1][1] as string[])[3]).includes("bash -lc"));
  assert.throws(() => remoteYh("-oProxyCommand=bad", ["status"], "", runner), /Invalid SSH host/);
});

test("target SSH validation preserves old files and rejects shell/option inputs", () => {
  const base = { id: "vm", label: "VM", transport: "relay", relay: primary, daemonPubkey: owner.pubkey };
  assert.equal(validateTarget("vm", base).ssh, undefined);
  for (const ssh of ["vm", "owner@vm.example", "owner@[2001:db8::1]"]) {
    assert.equal(validateTarget("vm", { ...base, ssh }).ssh, ssh);
  }
  for (const ssh of ["", "-bad", "host;id", "host name", "host\n", "user@-host", 3, "a".repeat(256)]) {
    assert.throws(() => validateTarget("vm", { ...base, ssh }), /Invalid SSH host/);
  }
});

test("join target updates by daemon key, retaining identity, label, wake settings and private mode", (t) => {
  const { targetsHome } = fixture(t);
  const targets: { id: string; target: Target }[] = [];
  const existing = updateJoinTarget(targetsHome, targets, owner.pubkey, [primary], "existing", "My VM", "vm");
  existing.target.wake = { kind: "command", cmd: "wake-vm" };
  const updated = updateJoinTarget(targetsHome, targets, owner.pubkey, [invite.relayUrl, primary], "mac", "My Mac", "new-vm");
  assert.equal(updated.id, "existing");
  assert.deepEqual(loadTarget("existing", targetsHome), { ...existing.target,
    relays: [invite.relayUrl], wake: { kind: "command", cmd: "wake-vm" } });
  assert.equal(updated.target.label, "My VM");
  assert.equal(updated.target.ssh, "vm");
  assert.equal(statSync(targetFile("existing", targetsHome)).mode & 0o777, 0o600);
  const collision = updateJoinTarget(targetsHome, targets, remoteOwner.pubkey, [primary], "existing", "Other");
  assert.equal(collision.id, "existing-2");
});

test("policy consent is asked once and its receipt is reused for multiple HTTP claims", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests: { path: string; body?: string }[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, body: init?.body as string | undefined });
    const result = path === "/api/join-policy" ? { policy: { version: "v1", terms_markdown: "terms", age_attestation_required: true } }
      : path === "/api/invites/accept-policy" ? { receipt: "receipt" } : { status: "already_member" };
    return Response.json(result);
  };
  const questions: string[] = [];
  const approved = await consentToPolicy(invite, {}, async (question) => { questions.push(question); return "yes"; });
  assert.deepEqual(approved, consent);
  await claimInvite(invite, approved, provider.secret);
  await claimInvite(invite, approved, owner.secret);
  assert.equal(questions.length, 2);
  assert.deepEqual(requests.map(({ path }) => path), ["/api/join-policy", "/api/invites/accept-policy", "/api/invites/claim", "/api/invites/claim"]);
  for (const request of requests.slice(2)) assert.equal(JSON.parse(request.body!).policy_receipt, "receipt");
});

test("NIP-11 reads the relay signing key, not the operator key, without sending the invite code", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let document: object = { self: relay.pubkey, pubkey: owner.pubkey };
  globalThis.fetch = async (input, init) => {
    assert.equal(input, invite.origin + "/");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("Accept"), "application/nostr+json");
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, "error");
    return Response.json(document);
  };
  assert.equal(await inviteRelayPubkey(invite), relay.pubkey);
  for (const self of [undefined, "invalid"]) {
    document = { self, pubkey: owner.pubkey };
    await assert.rejects(inviteRelayPubkey(invite), /did not publish its signing key/);
  }
});

test("join prepares both daemons before claiming, starts them after pairing, and does not restart on retry", async (t) => {
  const homes = fixture(t);
  const log: string[] = [], claims: string[] = [];
  const config = { relayUrl: invite.relayUrl, externalRelayPubkey: relay.pubkey };
  const remoteHome = join(homes.daemonHome, "..", "vm");
  let lookups = 0, remoteInstalls = 0, claimStatus: "joined" | "already_member" = "joined";
  let localStarted = false, remoteStarted = false, remotePaired = false;
  const joinBoth = () => joinMachines(invite, ["vm"], { local: true }, async () => "yes", {
    ...homes, identity: () => provider.secret, consent: async () => consent,
    log: (line) => log.push(line), running: () => localStarted ? 42 : null,
    relayKey: async () => { lookups++; return relay.pubkey; },
    claim: async (_invite, _consent, secret) => {
      for (const home of [homes.daemonHome, remoteHome]) {
        assert.deepEqual(loadConfig(home), { ...config, relays: undefined });
        assert.ok(existsSync(ownerKeyPath(home)));
        assert.ok(existsSync(envFilePath(home)));
      }
      claims.push(pubkeyOf(secret));
      return claimStatus;
    },
    configure: (home, url, secret) => configureJoinedRelay(home, url, secret, undefined, async () => relay.pubkey),
    runner: async (file, args, stdin) => {
      if (file === process.execPath) {
        assert.equal(args[1], "start");
        assert.equal(localStarted, false);
        assert.equal(claims.length, 2);
        assert.ok(readPairing(homes.daemonHome, provider.pubkey));
        localStarted = true;
        return "";
      }
      assert.equal(file, "ssh");
      const command = args.at(-1)!;
      assert.ok(!command.includes(invite.code));
      if (command.includes("yewholt:installed")) {
        assert.match(command, /command -v yh/);
        assert.match(command, /command -v node/);
        return existsSync(configPath(remoteHome)) ? "yewholt:installed" : "yewholt:fresh";
      }
      if (command.includes("--relay-pubkey")) {
        assert.equal(stdin, "");
        assert.match(command, /install/);
        assert.ok(command.includes(invite.relayUrl) && command.includes(relay.pubkey));
        initializeDaemon(remoteHome, config);
        remoteInstalls++;
        return "";
      }
      if (command.includes("list")) return JSON.stringify([loadConfig(remoteHome)]);
      if (command.includes("admin")) return `owner ${pubkeyOf(readKey(ownerKeyPath(remoteHome)))}`;
      if (command.includes("join")) {
        assert.equal(stdin, `${invite.origin}/invite/${invite.code}\n`);
        return claimStatus === "joined" ? "Joined" : "Already a member of";
      }
      if (command.includes("pair")) {
        remotePaired = true;
        return "";
      }
      if (command.includes("status")) return remoteStarted ? "daemon: running (43)" : "daemon: stopped";
      if (command.includes("start")) {
        assert.equal(remoteStarted, false);
        assert.equal(remotePaired, true);
        remoteStarted = true;
        return "";
      }
      throw new Error("Unexpected command");
    },
  });
  assert.deepEqual((await joinBoth()).map(({ status }) => status), ["joined", "joined", "joined"]);
  assert.ok(localStarted && remoteStarted);
  const localKey = pubkeyOf(readKey(ownerKeyPath(homes.daemonHome)));
  const remoteKey = pubkeyOf(readKey(ownerKeyPath(remoteHome)));
  assert.deepEqual(claims, [provider.pubkey, localKey]);
  assert.equal(loadTarget("mac", homes.targetsHome).daemonPubkey, localKey);
  assert.equal(loadTarget("vm", homes.targetsHome).daemonPubkey, remoteKey);
  assert.ok(readPairing(homes.daemonHome, provider.pubkey));
  for (const home of [homes.daemonHome, remoteHome]) {
    assert.equal(statSync(home).mode & 0o777, 0o700);
    for (const path of [ownerKeyPath(home), envFilePath(home), configPath(home)]) {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  }
  assert.match(log[0], /up to 3 invite uses/);
  claimStatus = "already_member";
  assert.deepEqual((await joinBoth()).map(({ status }) => status), ["already_member", "already_member", "already_member"]);
  assert.deepEqual(claims, [provider.pubkey, localKey, provider.pubkey, localKey]);
  assert.equal(lookups, 1);
  assert.equal(remoteInstalls, 1);
});

test("failed preparation leaves the invite unused when no requested daemon is ready", async (t) => {
  const homes = fixture(t);
  const summary = await joinMachines(invite, ["vm"], { local: true }, async () => "yes", {
    ...homes, log: () => {}, consent: async () => consent,
    relayKey: async () => { throw new Error("NIP-11 missing self"); },
    identity: () => { throw new Error("must not create provider identity"); },
    claim: async () => { throw new Error("must not claim"); },
    runner: async () => { throw new Error("SSH authentication failed"); },
  });
  assert.deepEqual(summary, [
    { machine: "My Mac daemon", status: "failed", reason: "NIP-11 missing self" },
    { machine: "vm", status: "failed", reason: "SSH authentication failed" },
  ]);
  assert.equal(existsSync(homes.daemonHome), false);
});

test("daemon initialization preserves an existing key and rejects a conflicting config", (t) => {
  const { daemonHome } = fixture(t);
  writeKey(ownerKeyPath(daemonHome), owner.secret);
  const config = { relayUrl: primary, externalRelayPubkey: relay.pubkey };
  assert.equal(initializeDaemon(daemonHome, config).pubkey, owner.pubkey);
  for (const conflict of [{ ...config, relayUrl: invite.relayUrl }, { ...config, externalRelayPubkey: remoteOwner.pubkey }]) {
    assert.throws(() => initializeDaemon(daemonHome, conflict), /already has a primary relay/);
  }
  assert.deepEqual(loadConfig(daemonHome), { ...config, relays: undefined });
  assert.equal(readKey(ownerKeyPath(daemonHome)), owner.secret);
});

test("daemon initialization does not replace a damaged identity", (t) => {
  const { daemonHome } = fixture(t);
  const path = ownerKeyPath(daemonHome);
  writeKey(path, owner.secret);
  writeFileSync(path, "invalid");
  assert.throws(() => initializeDaemon(daemonHome, { relayUrl: primary, externalRelayPubkey: relay.pubkey }), /not a nostr secret/);
  assert.throws(() => readKey(path), /not a nostr secret/);
  assert.equal(existsSync(configPath(daemonHome)), false);
});

test("local and remembered SSH machines reuse consent, pair, update targets, restart after adding running relays", async (t) => {
  const homes = fixture(t);
  install(homes.daemonHome);
  const targets: { id: string; target: Target }[] = [];
  updateJoinTarget(homes.targetsHome, targets, owner.pubkey, [primary], "my-mac", "Original Mac");
  updateJoinTarget(homes.targetsHome, targets, remoteOwner.pubkey, [primary], "my-vm", "Original VM", "owner@vm");
  const commands: { args: string[]; stdin?: string }[] = [];
  let policyCalls = 0;
  const claims: string[] = [];
  const log: string[] = [];
  const checked: string[] = [];
  const runner: Runner = async (_file, args, stdin) => {
    commands.push({ args, stdin });
    const command = args.at(-1)!;
    if (command.includes("yewholt:installed")) return "yewholt:installed";
    if (command.includes("admin")) return `owner ${remoteOwner.pubkey}\nsecret /private/path (mode 0600)\n`;
    if (command.includes("list")) return JSON.stringify([{ relayUrl: primary }]);
    if (command.includes("status")) return "daemon: running (42)\n";
    if (command.includes("join")) return "Already a member of wss://buzz.example";
    if (command.includes("id -un")) return "vm-user\n";
    return "";
  };
  const summary = await joinMachines(invite, ["owner@vm"], {}, async () => { throw Error("must not ask twice"); }, {
    ...homes, identity: () => provider.secret, runner, log: (s) => log.push(s), running: () => 42,
    consent: async () => { policyCalls++; return consent; },
    claim: async (_invite, approval, secret) => { assert.equal(approval, consent); claims.push(secret); return "joined"; },
    configure: (home, url, secret) => configureJoinedRelay(home, url, secret, undefined, async () => relay.pubkey),
    checkModels: async (id, target, secret) => {
      assert.equal(target.relay, invite.relayUrl);
      assert.equal(secret, provider.secret);
      assert.ok(commands.some(({ args }) => args.at(-1)!.includes("start") && args.includes("owner@vm")));
      assert.equal(loadTarget(id, homes.targetsHome).daemonPubkey, target.daemonPubkey);
      checked.push(id);
      return id === "my-mac" ? { ok: true, message: "Models available." }
        : { ok: false, message: "No models", needsLogin: true };
    },
  });
  assert.equal(policyCalls, 1);
  assert.deepEqual(claims, [provider.secret, owner.secret]);
  assert.deepEqual(summary.map(({ status }) => status), ["joined", "joined", "already_member"]);
  assert.equal(joinExitCode(summary), 0);
  assert.match(log[0], /up to 3 invite uses/);
  assert.ok(log.includes("owner@vm: already member"));
  for (const id of ["my-mac", "my-vm"]) assert.deepEqual(loadTarget(id, homes.targetsHome).relays, [invite.relayUrl]);
  assert.equal(loadTarget("my-vm", homes.targetsHome).ssh, "owner@vm");
  assert.ok(readPairing(homes.daemonHome, provider.pubkey));
  assert.ok(readPairing(homes.daemonHome, provider.pubkey, invite.relayUrl));
  assert.equal(commands.filter(({ args }) => args.includes("stop")).length, 1);
  assert.equal(commands.filter(({ args }) => args.includes("start")).length, 1);
  const remote = commands.filter(({ args }) => args[0] === "-o");
  assert.ok(remote.some(({ args }) => args.at(-1)!.includes("stop")));
  assert.ok(remote.some(({ args }) => args.at(-1)!.includes("start")));
  const remoteJoin = remote.find(({ stdin }) => stdin)!;
  assert.equal(remoteJoin.stdin, `${invite.origin}/invite/${invite.code}\n`);
  assert.ok(!remoteJoin.args.join(" ").includes(invite.code));
  assert.match(remoteJoin.args.at(-1)!, /--accept-policy/);
  assert.match(remoteJoin.args.at(-1)!, /--confirm-age/);
  assert.deepEqual(checked, ["my-mac", "my-vm"]);
  assert.deepEqual(log.slice(-2), [
    "My Mac daemon: Models available.",
    `owner@vm: No models available. As OS user "vm-user" on owner@vm (ssh -t 'owner@vm'), run yh and enter /login using the daemon's HOME and Pi agent directory. Then restart the daemon (yh stop && yh start for a CLI-managed daemon). Re-test from the Mac: yh targets doctor my-vm.`,
  ]);
});

test("successful local and SSH joins update every alias of the daemon without changing target metadata", async (t) => {
  for (const local of [true, false]) for (const status of ["joined", "already_member"] as const) {
    await t.test(`${local ? "local" : "SSH"}: ${status}`, async (t) => {
      const homes = fixture(t), log: string[] = [];
      if (local) install(homes.daemonHome);
      const daemon = local ? owner.pubkey : remoteOwner.pubkey;
      for (const id of ["original", "alias"]) {
        writePrivateJson(targetFile(id, homes.targetsHome), { id, label: `Label ${id}`, transport: "relay",
          daemonPubkey: daemon, relay: primary, ...(local ? {} : { ssh: "owner@vm" }),
          wake: { kind: "command", cmd: `wake-${id}` } });
      }
      const summary = await joinMachines(invite, local ? [] : ["owner@vm"], {}, async () => "yes", {
        ...homes, identity: () => provider.secret, consent: async () => consent, claim: async () => status,
        log: (line) => log.push(line), running: () => null,
        members: async () => { throw Error("handled targets must not need roster lookup"); },
        configure: (home, url, secret) => configureJoinedRelay(home, url, secret, undefined, async () => relay.pubkey),
        runner: async (_file, args) => {
          const command = args.at(-1)!;
          if (command.includes("yewholt:installed")) return "yewholt:installed";
          if (command.includes("admin")) return `owner ${daemon}`;
          if (command.includes("list")) return JSON.stringify([{ relayUrl: primary }]);
          if (command.includes("join")) return status === "joined" ? "Joined" : "Already a member of";
          return "daemon: stopped";
        },
      });
      assert.equal(joinExitCode(summary), 0);
      for (const id of ["original", "alias"]) {
        assert.deepEqual(loadTarget(id, homes.targetsHome), { label: `Label ${id}`, transport: "relay",
          daemonPubkey: daemon, relay: primary, relays: [invite.relayUrl],
          wake: { kind: "command", cmd: `wake-${id}` }, ...(local ? {} : { ssh: "owner@vm" }) });
        assert.equal(statSync(targetFile(id, homes.targetsHome)).mode & 0o777, 0o600);
        assert.equal(log.filter((line) => line === `Target ${id}: updated for ${invite.relayUrl}`).length, 1);
      }
    });
  }
});

test("join discovers existing member daemons without SSH and adds the community to all their targets once", async (t) => {
  const homes = fixture(t), log: string[] = [];
  const unknown = generateKeyPair();
  for (const id of ["instabox", "instabox-alias", "not-a-member"]) {
    writePrivateJson(targetFile(id, homes.targetsHome), { id, label: id, transport: "relay", relay: primary,
      daemonPubkey: id === "not-a-member" ? unknown.pubkey : remoteOwner.pubkey,
      wake: { kind: "instabox", accountId: "account", machineId: id } });
  }
  let lookups = 0, claims = 0;
  const run = () => joinMachines(invite, [], {}, async () => "yes", {
    ...homes, identity: () => provider.secret, consent: async () => consent,
    claim: async () => { claims++; return "already_member"; }, log: (line) => log.push(line),
    runner: async () => { throw Error("must not need SSH"); },
    members: async (url, secret) => {
      lookups++;
      assert.equal(url, invite.relayUrl);
      assert.equal(secret, provider.secret);
      return new Set([remoteOwner.pubkey]);
    },
  });
  assert.equal(joinExitCode(await run()), 0);
  for (const id of ["instabox", "instabox-alias"]) {
    assert.deepEqual(loadTarget(id, homes.targetsHome), { label: id, transport: "relay", relay: primary,
      daemonPubkey: remoteOwner.pubkey, relays: [invite.relayUrl],
      wake: { kind: "instabox", accountId: "account", machineId: id } });
    assert.equal(statSync(targetFile(id, homes.targetsHome)).mode & 0o777, 0o600);
    assert.ok(log.includes(`Target ${id}: updated for ${invite.relayUrl}`));
  }
  assert.equal(loadTarget("not-a-member", homes.targetsHome).relays, undefined);
  log.length = 0;
  assert.equal(joinExitCode(await run()), 0);
  assert.ok(!log.some((line) => line.startsWith("Target ")));
  assert.equal(lookups, 2);
});

test("membership lookup errors leave untouched targets unchanged and return a redacted failure", async (t) => {
  const homes = fixture(t);
  updateJoinTarget(homes.targetsHome, [], remoteOwner.pubkey, [primary], "instabox", "Instabox");
  const summary = await joinMachines(invite, [], {}, async () => "yes", {
    ...homes, identity: () => provider.secret, consent: async () => consent, claim: async () => "joined", log: () => {},
    members: async () => { throw Error(`missing roster ${invite.code}`); },
  });
  assert.equal(joinExitCode(summary), 1);
  assert.deepEqual(summary.at(-1), { machine: "Registered target membership check", status: "failed", reason: "missing roster [redacted]" });
  assert.equal(loadTarget("instabox", homes.targetsHome).relays, undefined);
});

test("exhausted invitations and SSH failures are per-machine failures and don't stop later machines", async (t) => {
  const homes = fixture(t);
  const log: string[] = [], hosts: string[] = [];
  const summary = await joinMachines(invite, ["bad-vm", "good-vm"], {}, async () => "yes", {
    ...homes, identity: () => provider.secret, log: (s) => log.push(s), consent: async () => consent,
    claim: async () => { throw Error(`invite_exhausted ${invite.code}`); },
    runner: async (_file, args, stdin) => {
      const host = args[2], command = args[3];
      hosts.push(host);
      if (host === "bad-vm") throw Error("SSH authentication failed");
      if (command.includes("yewholt:installed")) return "yewholt:installed";
      if (command.includes("admin")) return `owner ${remoteOwner.pubkey}`;
      if (command.includes("list")) return JSON.stringify([{ relayUrl: invite.relayUrl }]);
      assert.ok(!command.includes("--accept-policy") || stdin?.includes(invite.code));
      return "Joined wss://buzz.example";
    },
  });
  assert.deepEqual(summary.map(({ status }) => status), ["failed", "failed", "joined"]);
  assert.equal(joinExitCode(summary), 1);
  assert.match(summary[0].reason!, /invite_exhausted \[redacted\]/);
  assert.ok(hosts.includes("good-vm"));
  assert.ok(log.some((s) => /Local daemon not installed/.test(s)));
  assert.equal(loadTarget("good-vm", homes.targetsHome).ssh, "good-vm");
});

test("consent refusal stops all claims and SSH commands", async (t) => {
  await assert.rejects(joinMachines(invite, ["vm"], {}, async () => "no", {
    ...fixture(t), log: () => {}, consent: async () => { throw Error("not accepted"); },
    identity: () => { throw Error("must not create identity"); },
    runner: async () => { throw Error("must not run ssh"); },
  }), /not accepted/);
});

test("existing local relays do not restart a running daemon and already-member is success", async (t) => {
  const homes = fixture(t);
  install(homes.daemonHome);
  saveConfig(homes.daemonHome, { relayUrl: invite.relayUrl, externalRelayPubkey: relay.pubkey });
  const log: string[] = [];
  const summary = await joinMachines(invite, [], {}, async () => "yes", {
    ...homes, identity: () => provider.secret, log: (s) => log.push(s), consent: async () => consent,
    claim: async () => "already_member", running: () => 42,
    configure: (home, url, secret) => configureJoinedRelay(home, url, secret, undefined, async () => relay.pubkey),
    runner: async () => { throw Error("must not restart"); },
    checkModels: async () => ({ ok: false, message: "No models", needsLogin: true }),
  });
  assert.deepEqual(summary.map(({ status }) => status), ["already_member", "already_member"]);
  assert.equal(joinExitCode(summary), 0);
  assert.equal(loadTarget("mac", homes.targetsHome).relay, invite.relayUrl);
  assert.ok(log.at(-1)!.includes(`As OS user "${userInfo().username}" on this Mac, run yh and enter /login`));
  assert.match(log.at(-1)!, /yh targets doctor mac\.$/);
});

test("implicitly included daemons only restart if running with new admission or an added relay", async (t) => {
  for (const status of ["joined", "already_member"] as const) {
    for (const added of [false, true]) {
      for (const running of [false, true]) {
        await t.test(`${status}, added=${added}, running=${running}`, async (t) => {
          const homes = fixture(t);
          install(homes.daemonHome);
          if (!added) saveConfig(homes.daemonHome, { relayUrl: invite.relayUrl, externalRelayPubkey: relay.pubkey });
          updateJoinTarget(homes.targetsHome, [], remoteOwner.pubkey, [primary], "vm", "VM", "vm");
          const localCommands: string[] = [], remoteCommands: string[] = [], log: string[] = [];
          const summary = await joinMachines(invite, [], {}, async () => "yes", {
            ...homes, identity: () => provider.secret, log: (s) => log.push(s), consent: async () => consent,
            claim: async () => status, running: () => running ? 42 : null,
            configure: (home, url, secret) => configureJoinedRelay(home, url, secret, undefined, async () => relay.pubkey),
            runner: async (file, args) => {
              if (file === process.execPath) {
                localCommands.push(args[1]);
                return "";
              }
              const command = args.at(-1)!;
              remoteCommands.push(command);
              if (command.includes("yewholt:installed")) return "yewholt:installed";
              if (command.includes("admin")) return `owner ${remoteOwner.pubkey}`;
              if (command.includes("list")) return JSON.stringify([{ relayUrl: added ? primary : invite.relayUrl }]);
              if (command.includes("join")) return `${status === "already_member" ? "Already a member of" : "Joined"} ${invite.relayUrl}`;
              if (command.includes("status")) return running ? "daemon: running (42)\n" : "daemon: stopped\n";
              return "";
            },
            checkModels: async () => running ? { ok: true, message: "Models available." }
              : { ok: false, message: "Daemon offline or not responding." },
          });
          assert.deepEqual(summary.map((result) => result.status), [status, status, status]);
          const restart = running && (status === "joined" || added);
          assert.deepEqual(localCommands, restart ? ["stop", "start"] : []);
          assert.deepEqual(remoteCommands.filter((command) => command.includes("stop") || command.includes("start"))
            .map((command) => command.includes("stop") ? "stop" : "start"), restart ? ["stop", "start"] : []);
          if (!running) {
            assert.equal(log.at(-1), "vm: Daemon offline or not responding. Re-test from the Mac: yh targets doctor vm.");
            assert.ok(log.every((line) => !line.includes("/login")));
          }
        });
      }
    }
  }
});

test("failed local and SSH claims do not start or restart daemons", async (t) => {
  const homes = fixture(t);
  install(homes.daemonHome);
  const commands: string[] = [];
  const summary = await joinMachines(invite, ["vm"], { local: true }, async () => "yes", {
    ...homes, identity: () => provider.secret, log: () => {}, consent: async () => consent,
    claim: async () => { throw Error("invite_exhausted"); },
    running: () => { throw Error("must not check running after failed claim"); },
    runner: async (_file, args) => {
      const command = args.at(-1)!;
      commands.push(command);
      if (command.includes("yewholt:installed")) return "yewholt:installed";
      if (command.includes("admin")) return `owner ${remoteOwner.pubkey}`;
      if (command.includes("list")) return JSON.stringify([{ relayUrl: invite.relayUrl }]);
      if (command.includes("join")) throw Error("invite_exhausted");
      throw Error("unexpected command");
    },
  });
  assert.ok(summary.every(({ status, reason }) => status === "failed" && reason === "invite_exhausted"));
  assert.equal(joinExitCode(summary), 1);
  assert.ok(commands.every((command) => !command.includes("stop") && !command.includes("start")));
});

test("SSH does not receive consent flags not given locally, and an explicitly selected stopped VM starts", async (t) => {
  const commands: string[] = [];
  const homes = fixture(t);
  const summary = await joinMachines(invite, ["_vm.example"], {}, async () => "yes", {
    ...homes, identity: () => provider.secret, log: () => {},
    consent: async () => ({ acceptPolicy: false, confirmAge: false }), claim: async () => "joined",
    runner: async (_file, args) => {
      const command = args[3];
      commands.push(command);
      if (command.includes("yewholt:installed")) return "yewholt:installed";
      if (command.includes("admin")) return `owner ${remoteOwner.pubkey}`;
      if (command.includes("list")) return JSON.stringify([{ relayUrl: primary }]);
      if (command.includes("status")) return "daemon: stopped\n";
      return "Joined wss://buzz.example";
    },
  });
  assert.equal(joinExitCode(summary), 0);
  assert.ok(commands.every((command) => !/--accept-policy|--confirm-age/.test(command)));
  assert.ok(commands.some((command) => command.includes("start")));
  assert.ok(commands.every((command) => !command.includes("stop")));
  assert.equal(loadTarget("vm-example", homes.targetsHome).ssh, "_vm.example");
});

function discoveryClient(events: NostrEvent[], calls: string[] = []) {
  let authenticated = false;
  return {
    connect: async () => { calls.push("AUTH"); authenticated = true; },
    subscribe: (_id: string, filters: readonly Record<string, unknown>[], event: (value: NostrEvent) => void) => {
      assert.ok(authenticated);
      assert.deepEqual(filters, [{ kinds: [39000, 39002], limit: 5 }]);
      calls.push("REQ");
      events.forEach(event);
    },
    unsubscribe: () => { calls.push("CLOSE"); },
    close: async () => { calls.push("disconnect"); },
  };
}

test("relay key discovery authenticates before REQ, ignores invalid events, and verifies the supplied pin", async () => {
  const event = signEvent(relay.secret, 39002, "", [["d", "group"]]);
  const calls: string[] = [];
  const found = await discoverRelayPubkey(invite.relayUrl, owner.secret, relay.pubkey,
    discoveryClient([{ ...event, sig: "bad" }, signEvent(owner.secret, 1, "", []), event], calls));
  assert.equal(found, relay.pubkey);
  assert.deepEqual(calls, ["AUTH", "REQ", "CLOSE", "disconnect"]);
  await assert.rejects(discoverRelayPubkey(invite.relayUrl, owner.secret, owner.pubkey, discoveryClient([event])), /differs/);
});

test("relay discovery timeout and AUTH rejection clean up the client", async () => {
  const calls: string[] = [];
  await assert.rejects(discoverRelayPubkey(invite.relayUrl, owner.secret, undefined, discoveryClient([], calls), 5), /timed out/);
  assert.deepEqual(calls, ["AUTH", "REQ", "CLOSE", "disconnect"]);
  const client = discoveryClient([]);
  client.connect = async () => { throw Error("AUTH rejected"); };
  await assert.rejects(discoverRelayPubkey(invite.relayUrl, owner.secret, undefined, client), /AUTH rejected/);
});

function rosterClient(events: NostrEvent[], finish = true, rejection?: string) {
  const calls: string[] = [];
  return {
    calls,
    connect: async () => { calls.push("AUTH"); },
    subscribe: (id: string, filters: readonly Record<string, unknown>[], onEvent: (value: NostrEvent) => void,
      onClosed?: (id: string, reason: string) => void, onEose?: () => void) => {
      assert.deepEqual(calls, ["AUTH"]);
      assert.deepEqual(filters, [{ kinds: [13534], authors: [relay.pubkey], limit: 1 }]);
      calls.push("REQ");
      events.forEach(onEvent);
      if (rejection) onClosed?.(id, rejection);
      else if (finish) onEose?.();
    },
    unsubscribe: () => { calls.push("CLOSE"); },
    close: async () => { calls.push("disconnect"); },
  };
}

test("community roster lookup authenticates, verifies the signing key, and uses the newest complete snapshot", async () => {
  const older = signEvent(relay.secret, 13534, "", [["member", owner.pubkey, "member"]], 1);
  const newest = signEvent(relay.secret, 13534, "", [["member", remoteOwner.pubkey, "member"], ["member", "invalid"], ["p", owner.pubkey]], 2);
  const client = rosterClient([
    signEvent(owner.secret, 13534, "", [["member", owner.pubkey]], 3),
    { ...newest, sig: "bad" }, signEvent(relay.secret, 39002, "", [["p", owner.pubkey]], 4), newest, older,
  ]);
  assert.deepEqual(await readRelayMembers(invite.relayUrl, provider.secret, relay.pubkey, client), new Set([remoteOwner.pubkey]));
  assert.deepEqual(client.calls, ["AUTH", "REQ", "CLOSE", "disconnect"]);
  const empty = rosterClient([signEvent(relay.secret, 13534, "", [])]);
  assert.deepEqual(await readRelayMembers(invite.relayUrl, provider.secret, relay.pubkey, empty), new Set());
});

test("community roster lookup fails closed on absent, refused and timed-out rosters and AUTH errors", async () => {
  for (const [client, message] of [
    [rosterClient([]), /No relay-signed/],
    [rosterClient([], true, "restricted"), /rejected: restricted/],
    [rosterClient([], false), /timed out/],
  ] as const) {
    await assert.rejects(readRelayMembers(invite.relayUrl, provider.secret, relay.pubkey, client, 5), message);
    assert.deepEqual(client.calls, ["AUTH", "REQ", "CLOSE", "disconnect"]);
  }
  const client = rosterClient([]);
  client.connect = async () => { throw Error("AUTH rejected"); };
  await assert.rejects(readRelayMembers(invite.relayUrl, provider.secret, relay.pubkey, client), /AUTH rejected/);
  assert.deepEqual(client.calls, ["CLOSE", "disconnect"]);
});

test("join discovers and updates a non-SSH target through authenticated NIP-43 WebSocket queries", async (t) => {
  const homes = fixture(t);
  updateJoinTarget(homes.targetsHome, [], remoteOwner.pubkey, [primary], "instabox", "Instabox");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}`, calls: string[] = [];
  server.on("connection", (socket) => {
    let authenticated = false;
    socket.send(JSON.stringify(["AUTH", "join-challenge"]));
    socket.on("message", (data) => {
      const [type, id, filter] = JSON.parse(data.toString());
      if (type === "AUTH") {
        authenticated = verifyEvent(id) && id.pubkey === provider.pubkey && id.kind === 22242 &&
          id.tags.some((tag: string[]) => tag[0] === "challenge" && tag[1] === "join-challenge");
        calls.push("AUTH");
        socket.send(JSON.stringify(["OK", id.id, authenticated, ""]));
      } else if (type === "REQ") {
        assert.ok(authenticated);
        if (filter.kinds.includes(39002)) {
          calls.push("groups");
          socket.send(JSON.stringify(["EVENT", id, signEvent(relay.secret, 39002, "", [["d", "channel"]])]));
        } else {
          assert.deepEqual(filter, { kinds: [13534], authors: [relay.pubkey], limit: 1 });
          calls.push("roster");
          socket.send(JSON.stringify(["EVENT", id, signEvent(relay.secret, 13534, "", [["member", remoteOwner.pubkey, "member"]])]));
        }
        socket.send(JSON.stringify(["EOSE", id]));
      }
    });
  });
  const log: string[] = [];
  const summary = await joinMachines({ ...invite, relayUrl: url }, [], {}, async () => "yes", {
    ...homes, identity: () => provider.secret, consent: async () => consent, claim: async () => "already_member",
    log: (line) => log.push(line), runner: async () => { throw Error("must not use SSH"); },
  });
  assert.equal(joinExitCode(summary), 0);
  assert.deepEqual(calls, ["AUTH", "groups", "AUTH", "roster"]);
  assert.deepEqual(loadTarget("instabox", homes.targetsHome).relays, [url]);
  assert.ok(log.includes(`Target instabox: updated for ${url}`));
});
