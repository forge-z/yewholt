import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { AgentFiles, agentStatuses, listAgents } from "../src/agents.js";
import { WorkspaceIsolation } from "../src/isolation.js";
import { directChannels } from "../src/membership.js";
import { generateKeyPair, ownerAuthTag, verifyEvent } from "../src/nostr.js";
import { botKeyPath } from "../src/paths.js";
import { RegistryDoc } from "../src/registry.js";
import { ensureOwnerKey, isCoder, Yewholt, type HumanMessage } from "../src/session.js";
import { byKind, CODER, INSTALL, OWNER, PRIVATE, RELAY } from "./helpers/fixture.js";

const defaults = { relayUrl: "wss://relay.invalid", model: { provider: "test", modelId: "offline", label: "Offline" } };
const start = 1_795_231_800_000;

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "yewholt-agents-"));
  const dir = join(home, "agents");
  mkdirSync(dir);
  const owner = generateKeyPair();
  const agent = generateKeyPair();
  const file = join(dir, `${agent.pubkey}.json`);
  const authTag = ownerAuthTag(owner.secret, agent.pubkey);
  const payload = { name: "Coder", nsec: agent.secret, authTag };
  function write(fields: Record<string, unknown> = {}, mtime = start - 1000, filename = file) {
    const temp = join(dir, "replacement.tmp");
    writeFileSync(temp, JSON.stringify({ ...payload, ...fields }), { mode: 0o600 });
    utimesSync(temp, mtime / 1000, mtime / 1000);
    renameSync(temp, filename);
  }
  return { home, dir, agent, owner, file, authTag, write, close: () => rmSync(home, { recursive: true, force: true }) };
}

async function withAgent(fn: (f: ReturnType<typeof fixture>, session: Yewholt, tick: (ms: number) => void) => Promise<void>) {
  const f = fixture();
  let now = start;
  const workspaces = mkdtempSync(join(tmpdir(), "yewholt-agent-workspaces-"));
  const isolation = new WorkspaceIsolation(f.home, { YEWHOLT_UNSAFE_SHARED_USER: "1", YEWHOLT_WORKSPACES: workspaces });
  const session = await Yewholt.open(new MemoryStorage(), {
    home: f.home, models: createModels(), now: () => now, isolation, piDir: join(f.home, "pi"),
  });
  try {
    await fn(f, session, (ms) => { now += ms; });
  } finally {
    await session.close();
    rmSync(workspaces, { recursive: true, force: true });
    f.close();
  }
}

async function reconcile(f: ReturnType<typeof fixture>, session: Yewholt) {
  await session.reconcileAgents(listAgents(f.home, defaults));
}

async function refresh(f: ReturnType<typeof fixture>, session: Yewholt) {
  await session.refreshAgentRuntime([f.agent.pubkey]);
}

const say = (eventId: string, text = "hello", authorPubkey = OWNER, channelId = PRIVATE): HumanMessage =>
  ({ eventId, text, authorPubkey, channelId, createdAt: start / 1000 });

test("provisioning lists only agent JSON files and uses daemon defaults", () => {
  const f = fixture();
  try {
    f.write();
    writeFileSync(join(f.dir, "ignore.tmp"), "ignored");
    const scan = listAgents(f.home, defaults);
    assert.deepEqual(scan.invalid, []);
    assert.equal(scan.definitions.length, 1);
    const { pubkey, ownerPubkey, name, authTag, relayUrl, model, permissions, respondTo, respondToAllowlist, channelId } = scan.definitions[0]!;
    assert.deepEqual({ pubkey, ownerPubkey, name, authTag, relayUrl, model, permissions, respondTo, respondToAllowlist, channelId }, {
      pubkey: f.agent.pubkey, ownerPubkey: f.owner.pubkey, name: "Coder", authTag: f.authTag, ...defaults,
      permissions: ["post", "read"], respondTo: "anyone", respondToAllowlist: [], channelId: undefined,
    });
  } finally {
    f.close();
  }
});

test("provisioning rejects malformed or unauthenticated agents without exposing their keys", () => {
  const f = fixture();
  try {
    const digest = sha256(new TextEncoder().encode(`nostr:agent-auth:${f.agent.pubkey}:`));
    const selfSignature = bytesToHex(schnorr.sign(digest, hexToBytes(f.agent.secret)));
    for (const [fields, reason] of [
      [{ nsec: "z".repeat(64) }, "nsec"],
      [{ nsec: "0".repeat(64) }, "nsec"],
      [{ authTag: undefined }, "auth tag"],
      [{ authTag: [...f.authTag.slice(0, 3), "0".repeat(128)] }, "auth tag"],
      [{ authTag: ["auth", f.agent.pubkey, "", selfSignature] }, "auth tag"],
      [{ authTag: ["auth", "", "", f.authTag[3]] }, "auth tag"],
      [{ name: undefined }, "name"],
    ] as const) {
      f.write(fields);
      const scan = listAgents(f.home, defaults);
      assert.equal(scan.definitions.length, 0);
      assert.equal(scan.invalid.length, 1);
      assert.ok(scan.invalid[0]!.reason.includes(reason));
      assert.equal(JSON.stringify(scan.invalid).includes(f.agent.secret), false);
    }
    const wrong = join(f.dir, `${f.owner.pubkey}.json`);
    f.write({}, start, wrong);
    f.write();
    let scan = listAgents(f.home, defaults);
    assert.equal(scan.definitions.length, 1);
    assert.match(scan.invalid[0]!.reason, /filename/);
    chmodSync(f.file, 0o644);
    scan = listAgents(f.home, defaults);
    assert.equal(scan.definitions.length, 0);
    assert.ok(scan.invalid.some((item) => item.reason.includes("0600")));
  } finally {
    f.close();
  }
});

test("provisioning polls at most every two seconds and reads atomically replaced files", () => {
  const f = fixture();
  let now = start;
  try {
    f.write();
    const files = new AgentFiles(f.home, defaults, () => now);
    assert.equal(files.poll()?.definitions[0]?.name, "Coder");
    f.write({ name: "New name" });
    utimesSync(f.dir, (start + 3000) / 1000, (start + 3000) / 1000);
    now += 1999;
    assert.equal(files.poll(), null);
    now += 1;
    assert.equal(files.poll()?.definitions[0]?.name, "New name");
    now += 2000;
    assert.equal(files.poll(), null);
  } finally {
    f.close();
  }
});

test("reconcile is idempotent and updates the same conversation from provisioning", async () => {
  await withAgent(async (f, session) => {
    f.write();
    await Promise.all([reconcile(f, session), reconcile(f, session)]);
    const before = await session.snapshot();
    assert.equal(before.bots.length, 1);
    f.write({
      name: "Updated", model: { provider: "test", modelId: "changed", label: "Changed" }, permissions: ["post", "read", "code"],
      relayUrl: "wss://other.invalid", respondTo: "allowlist", respondToAllowlist: [OWNER], channelId: PRIVATE,
    }, start + 1000);
    await reconcile(f, session);
    const state = await session.snapshot();
    assert.equal(state.bots.length, 1);
    const bot = state.bots[0]!;
    assert.equal(bot.conversationId, before.bots[0]?.conversationId);
    assert.equal(bot.name, "Updated");
    assert.equal(bot.modelId, "changed");
    assert.equal(bot.status, "active");
    assert.deepEqual(bot.scope, [PRIVATE]);
    assert.equal(isCoder(bot), true);
    assert.deepEqual([bot.external, bot.ownerPubkey, bot.authTag, bot.relayUrl, bot.respondTo, bot.respondToAllowlist, bot.stopped],
      [true, f.owner.pubkey, f.authTag, "wss://other.invalid", "allowlist", [OWNER], false]);
    assert.equal(JSON.stringify(state).includes(f.agent.secret), false);
  });
});

test("reconcile retires a removed file and queues offline once", async () => {
  await withAgent(async (f, session) => {
    f.write();
    await reconcile(f, session);
    await refresh(f, session);
    unlinkSync(f.file);
    await reconcile(f, session);
    await reconcile(f, session);
    const state = await session.snapshot();
    assert.equal(state.bots[0]?.status, "retired");
    assert.deepEqual(state.outbox.map(({ kind, content, tags }) => ({ kind, content, tags })), [{ kind: 20001, content: "offline", tags: [] }]);
    assert.equal(verifyEvent(state.outbox[0]!), true);
    await session.ackOutbox([state.outbox[0]!.id]);
    assert.equal(session.hasAgentKey(f.agent.pubkey), false);
  });
});

test("invalid replacement disables the previous record and reports the failure once", async (t) => {
  const log = t.mock.method(console, "error", () => undefined);
  await withAgent(async (f, session) => {
    let now = start;
    const files = new AgentFiles(f.home, defaults, () => now);
    f.write({ channelId: PRIVATE });
    await session.reconcileAgents(files.poll()!);
    await refresh(f, session);
    for (let i = 0; i < 2; i++) {
      f.write({ channelId: PRIVATE, authTag: undefined });
      now += 2000;
      utimesSync(f.dir, now / 1000, now / 1000);
      const scan = files.poll()!;
      await session.reconcileAgents(scan);
      await session.handleHuman(say("formerly-active", "@Coder hello"));
      const state = await session.snapshot();
      assert.equal(state.bots.length, 1);
      assert.deepEqual(state.outbox, []);
      assert.deepEqual(agentStatuses(state.bots, scan), [
        { name: "Coder", pubkey: f.agent.pubkey.slice(0, 8), state: "invalid:invalid auth tag" },
      ]);
    }
    assert.equal(log.mock.callCount(), 1);
    assert.equal(JSON.stringify(log.mock.calls[0]?.arguments).includes(f.agent.secret), false);
    unlinkSync(f.file);
    await reconcile(f, session);
    assert.equal((await session.snapshot()).outbox[0]?.content, "offline");
  });
});

test("external provisioning emits no identity events and creates no bot key file", async () => {
  await withAgent(async (f, session) => {
    f.write();
    await reconcile(f, session);
    assert.deepEqual((await session.snapshot()).outbox, []);
    assert.equal(existsSync(botKeyPath(f.home, f.agent.pubkey)), false);
    await refresh(f, session);
    assert.deepEqual((await session.snapshot()).outbox.map((event) => event.kind), [10100, 20001]);
  });
});

test("agents do not answer or shut down on another relay with the same channel ID", async () => {
  await withAgent(async (f, session) => {
    const secondary = { url: "wss://other.invalid", primary: false };
    const primary = { url: defaults.relayUrl, primary: true };
    f.write({ relayUrl: secondary.url, channelId: PRIVATE, permissions: ["post"] });
    await reconcile(f, session);
    const chat = say("shared-id", "@Coder hello", f.owner.pubkey);
    await session.handleHuman({ ...say("shutdown", "!shutdown", f.owner.pubkey), relay: primary });
    await session.handleHuman({ ...chat, relay: primary });
    assert.deepEqual((await session.snapshot()).outbox, []);
    assert.equal((await session.snapshot()).bots[0]?.status, "active");
    await session.handleHuman({ ...chat, relay: secondary });
    const state = await session.snapshot();
    assert.equal(state.outbox[0]?.pubkey, f.agent.pubkey);
    assert.equal(state.highWater, 0);
    assert.equal(state.highWaterByRelay?.[secondary.url], chat.createdAt);
  });
});

test("connected agents publish exact profile and presence with independent cadences", async () => {
  await withAgent(async (f, session, tick) => {
    f.write({ respondTo: "allowlist", respondToAllowlist: [OWNER] });
    await reconcile(f, session);
    const next = async () => {
      await refresh(f, session);
      const { outbox } = await session.snapshot();
      assert.ok(outbox.every((event) => event.pubkey === f.agent.pubkey && verifyEvent(event)));
      await session.ackOutbox(outbox.map((event) => event.id));
      return outbox.map(({ kind, content, tags }) => ({ kind, content, tags }));
    };
    const profile = { kind: 10100, content: JSON.stringify({
      display_name: "Coder", name: "Coder", status: "online", respond_to: "allowlist", respond_to_allowlist: [OWNER], capabilities: [],
    }), tags: [] };
    const presence = { kind: 20001, content: "online", tags: [] };
    assert.deepEqual(await next(), [profile, presence]);
    tick(59_999);
    assert.deepEqual(await next(), []);
    tick(1);
    assert.deepEqual(await next(), [presence]);
    for (let i = 0; i < 8; i++) {
      tick(60_000);
      assert.deepEqual(await next(), [presence]);
    }
    tick(60_000);
    assert.deepEqual(await next(), [profile, presence]);
    session.agentDisconnected(f.agent.pubkey);
    tick(1000);
    assert.deepEqual(await next(), [profile, presence]);
  });
});

test("DM detection counts distinct members on the newest trusted 39002", () => {
  const base = byKind(39002, PRIVATE);
  const dmTags = base.tags.filter((tag) => tag[0] === "d" || tag[1] === CODER);
  dmTags.push(["p", OWNER], ["p", OWNER]);
  const dm = { ...base, tags: dmTags, created_at: base.created_at + 1 };
  const group = { ...dm, tags: [...dmTags, ["p", "ac".repeat(32)]], created_at: dm.created_at + 1 };
  assert.deepEqual([...directChannels([dm], CODER, RELAY)], [PRIVATE]);
  assert.deepEqual([...directChannels([dm, group], CODER, RELAY)], []);
  assert.deepEqual([...directChannels([dm, { ...group, pubkey: OWNER }], CODER, RELAY)], [PRIVATE]);
  assert.deepEqual([...directChannels([dm], CODER, null)], []);
});

test("external DM response gate handles anyone, allowlist, and unknown policies", async () => {
  await withAgent(async (f, session) => {
    const replies = async () => (await session.snapshot()).outbox.filter((event) => event.kind === 9);
    session.setMemberChannels(f.agent.pubkey, [PRIVATE, INSTALL], [PRIVATE]);
    f.write();
    await reconcile(f, session);
    await session.handleHuman(say("anyone"));
    assert.equal((await replies()).length, 1);
    assert.equal(verifyEvent((await replies())[0]!), true);
    assert.deepEqual((await replies())[0]?.tags, [["h", PRIVATE], f.authTag]);
    await session.handleHuman(say("group", "hello", OWNER, INSTALL));
    assert.equal((await replies()).length, 1);
    await session.handleHuman(say("mention", "@Coder hello", OWNER, INSTALL));
    assert.equal((await replies()).length, 2);

    f.write({ respondTo: "allowlist", respondToAllowlist: [OWNER] }, start + 1000);
    await reconcile(f, session);
    await session.handleHuman(say("denied", "@Coder hello", f.owner.pubkey));
    assert.equal((await replies()).length, 2);
    await session.handleHuman(say("allowed"));
    assert.equal((await replies()).length, 3);

    f.write({ respondTo: "unknown" }, start + 2000);
    await reconcile(f, session);
    await session.handleHuman(say("unknown"));
    assert.equal((await replies()).length, 3);
  });
});

test("owner shutdown is durable, requires newer provisioning, and cannot be replayed", async () => {
  await withAgent(async (f, session, tick) => {
    f.write({ channelId: PRIVATE, respondTo: "unknown" }, start + 1000);
    await reconcile(f, session);
    const stop = say("stop", "  !shutdown\n", f.owner.pubkey);
    await session.handleHuman(stop);
    await session.handleHuman(stop);
    await reconcile(f, session);
    assert.equal((await session.snapshot()).bots[0]?.status, "stopped", "a future-dated file must still change");
    f.write({ channelId: PRIVATE, name: "Still stopped" }, start);
    await reconcile(f, session);
    await session.handleHuman(say("ignored", "@Still stopped hello"));
    let state = await session.snapshot();
    assert.equal(state.bots[0]?.name, "Still stopped");
    assert.equal(state.bots[0]?.status, "stopped");
    assert.deepEqual(state.bots[0]?.shutdownEventIds, [stop.eventId]);
    assert.deepEqual(state.outbox.map(({ kind, content, tags }) => ({ kind, content, tags })), [{ kind: 20001, content: "offline", tags: [] }]);
    await session.ackOutbox(state.outbox.map((event) => event.id));
    tick(2000);
    f.write({ channelId: PRIVATE }, start + 2000);
    await reconcile(f, session);
    // The ordinary inbox history is bounded. Shutdown replay protection must survive it.
    await session.harness.commit(async (tx) => { (await tx.doc(RegistryDoc)).processed = []; }, BACKGROUND_CONTEXT);
    await session.handleHuman(stop);
    state = await session.snapshot();
    assert.equal(state.bots[0]?.status, "active");
    assert.equal(state.outbox.length, 0);
  });
});

test("hosted profile rename does not reactivate a stopped external agent", async () => {
  await withAgent(async (f, session) => {
    f.write({ channelId: PRIVATE });
    await reconcile(f, session);
    await session.handleHuman(say("owner-stop", "!shutdown", f.owner.pubkey));
    const before = (await session.snapshot()).bots[0]!;
    assert.equal(before.status, "stopped");
    await session.updateHostedName(before.pubkey, "New hosted name");
    const after = (await session.snapshot()).bots[0]!;
    assert.equal(after.name, "New hosted name");
    assert.equal(after.status, "stopped");
    assert.equal(after.agentFileVersion, before.agentFileVersion);
    assert.equal(after.stoppedFileVersion, before.stoppedFileVersion);
  });
});

test("stranger shutdown is ignored and logged once", async (t) => {
  const log = t.mock.method(console, "error", () => undefined);
  await withAgent(async (f, session) => {
    f.write({ channelId: PRIVATE });
    await reconcile(f, session);
    const stop = say("stranger", "!shutdown");
    await session.handleHuman(stop);
    await session.handleHuman(stop);
    const state = await session.snapshot();
    assert.equal(state.bots[0]?.status, "active");
    assert.equal(state.outbox.length, 0);
    assert.equal(log.mock.callCount(), 1);
    assert.equal(JSON.stringify(log.mock.calls[0]?.arguments).includes(f.agent.secret), false);
  });
});

test("daemon profile names the daemon key in member lists", async () => {
  const { daemonName, daemonProfile } = await import("../src/agents.js");
  const { secret, pubkey } = generateKeyPair();
  assert.equal(daemonName({ YEWHOLT_NAME: " Yewholt watcher " }), "Yewholt watcher");
  assert.equal(daemonName({}), undefined);
  assert.equal(daemonName({ YEWHOLT_NAME: "  " }), undefined);
  const event = daemonProfile(secret, "Yewholt watcher", 100);
  assert.equal(event.kind, 0);
  assert.equal(event.pubkey, pubkey);
  assert.equal(event.created_at, 100);
  assert.ok(verifyEvent(event));
  assert.deepEqual(JSON.parse(event.content), { name: "Yewholt watcher", display_name: "Yewholt watcher", about: "Yewholt daemon" });
});
