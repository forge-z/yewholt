import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeProfile } from "../src/agents.js";
import { MEMBER_LIST_KIND } from "../src/membership.js";
import { generateKeyPair, signEvent } from "../src/nostr.js";
import type { BotRecord } from "../src/registry.js";
import { ChannelFeed, Doze, PRESENCE_KIND, requestWake, RUNTIME_PROFILE_KIND, WakeWatch, wakeSettings } from "../src/wake.js";

const relay = generateKeyPair();
const human = generateKeyPair();
const agent = generateKeyPair();
const url = "https://vm.example/wake";

function profile(content: Record<string, unknown>, createdAt = 100) {
  return signEvent(agent.secret, RUNTIME_PROFILE_KIND, JSON.stringify(content), [], createdAt);
}

function watcher(now: () => number, local = new Set<string>()) {
  const poked: string[] = [];
  const watch = new WakeWatch(relay.pubkey, () => local, (target) => poked.push(target), now);
  watch.accept(signEvent(relay.secret, MEMBER_LIST_KIND, "", [["d", "room"], ["p", human.pubkey], ["p", agent.pubkey]], 100));
  return { watch, poked };
}

let sent = 0;
const message = (tags: string[][] = [["h", "room"]], author = human) => signEvent(author.secret, 9, `oi ${sent++}`, tags);

test("wakeSettings reads the wake URL, port and idle minutes", () => {
  assert.deepEqual(wakeSettings({}), { url: undefined, port: undefined, idleMs: 600_000 });
  assert.deepEqual(wakeSettings({ YEWHOLT_WAKE_URL: url, YEWHOLT_WAKE_PORT: "8787", YEWHOLT_IDLE_MINUTES: "2" }),
    { url, port: 8787, idleMs: 120_000 });
  assert.throws(() => wakeSettings({ YEWHOLT_WAKE_URL: "ftp://vm" }));
  assert.throws(() => wakeSettings({ YEWHOLT_WAKE_PORT: "99999" }));
  assert.throws(() => wakeSettings({ YEWHOLT_IDLE_MINUTES: "0" }));
  assert.deepEqual(wakeSettings({ YEWHOLT_WATCHER_PUBKEY: ` ${agent.pubkey.toUpperCase()} ` }),
    { url: undefined, port: undefined, idleMs: 600_000, watcher: agent.pubkey });
  assert.throws(() => wakeSettings({ YEWHOLT_WATCHER_PUBKEY: "abc" }));
});

test("Doze closes only a wakeable, quiet daemon and reopens on a wake request", async () => {
  let now = 0;
  assert.equal(new Doze({ idleMs: 10, port: 1 }, () => now).enabled, false);
  const doze = new Doze({ url, port: 1, idleMs: 10 }, () => now);
  now = 20;
  assert.equal(doze.due(true), false, "a running turn keeps it awake");
  now = 25;
  assert.equal(doze.due(false), false);
  now = 30;
  assert.equal(doze.due(false), true);
  doze.sleep();
  assert.equal(doze.asleep, true);
  let woken = false;
  const waiting = doze.untilWoken().then(() => { woken = true; });
  await Promise.resolve();
  assert.equal(woken, false);
  doze.wake();
  await waiting;
  assert.equal(doze.asleep, false);
  assert.equal(doze.due(false), false);
});

test("Doze stays awake when touched between the idle check and sleep", () => {
  let now = 0;
  const doze = new Doze({ url, port: 1, idleMs: 10 }, () => now);
  now = 10;
  assert.equal(doze.due(false), true);
  doze.touch();
  doze.sleep();
  assert.equal(doze.asleep, false);
});

test("WakeWatch requests the wake URL of an asleep agent addressed in its channel", () => {
  let now = 1_000_000;
  const { watch, poked } = watcher(() => now);
  watch.accept(profile({ wake_url: url, respond_to: "anyone" }));
  watch.accept(message());
  assert.deepEqual(poked, [url]);
  watch.accept(message());
  assert.deepEqual(poked, [url], "one request per minute per URL");
  now += 61_000;
  watch.accept(message([["p", agent.pubkey]]));
  assert.deepEqual(poked, [url, url]);
});

test("WakeWatch leaves awake, local and unwakeable agents alone", () => {
  const now = 1_000_000;
  const online = watcher(() => now);
  online.watch.accept(profile({ wake_url: url, respond_to: "anyone" }));
  online.watch.accept(signEvent(agent.secret, PRESENCE_KIND, "online", []));
  online.watch.accept(message());
  assert.deepEqual(online.poked, []);
  online.watch.accept(signEvent(agent.secret, PRESENCE_KIND, "offline", []));
  online.watch.accept(message());
  assert.deepEqual(online.poked, [url]);

  const local = watcher(() => now, new Set([agent.pubkey]));
  local.watch.accept(profile({ wake_url: url, respond_to: "anyone" }));
  local.watch.accept(message());
  assert.deepEqual(local.poked, []);

  const none = watcher(() => now);
  none.watch.accept(profile({ respond_to: "anyone" }));
  none.watch.accept(message());
  none.watch.accept(profile({ wake_url: "file:///etc/passwd", respond_to: "anyone" }, 200));
  none.watch.accept(message());
  assert.deepEqual(none.poked, []);
});

test("WakeWatch follows the agent's respond_to and ignores other agents", () => {
  const now = 1_000_000;
  const owner = generateKeyPair();
  const ownerOnly = watcher(() => now);
  ownerOnly.watch.accept(profile({ wake_url: url, respond_to: "owner", owner: owner.pubkey }));
  ownerOnly.watch.accept(message());
  assert.deepEqual(ownerOnly.poked, []);
  ownerOnly.watch.accept(message([["h", "room"]], owner));
  assert.deepEqual(ownerOnly.poked, [url]);

  const allow = watcher(() => now);
  allow.watch.accept(profile({ wake_url: url, respond_to: "allowlist", respond_to_allowlist: [human.pubkey], owner: owner.pubkey }));
  allow.watch.accept(message());
  assert.deepEqual(allow.poked, [url]);

  const bots = watcher(() => now);
  const other = generateKeyPair();
  bots.watch.accept(profile({ wake_url: url, respond_to: "anyone" }));
  bots.watch.accept(signEvent(other.secret, RUNTIME_PROFILE_KIND, "{}", []));
  bots.watch.accept(message([["h", "room"]], other));
  assert.deepEqual(bots.poked, []);
});

test("WakeWatch trusts only relay-signed member lists", () => {
  const forged = generateKeyPair();
  const poked: string[] = [];
  const watch = new WakeWatch(relay.pubkey, () => new Set(), (target) => poked.push(target), () => 1_000_000);
  watch.accept(signEvent(forged.secret, MEMBER_LIST_KIND, "", [["d", "room"], ["p", agent.pubkey]]));
  watch.accept(profile({ wake_url: url, respond_to: "anyone" }));
  watch.accept(message());
  assert.deepEqual(poked, []);
});

test("requestWake retries while the VM resumes and then stops", async () => {
  const statuses = [503, 502, 404];
  const calls: string[] = [];
  const fetchApi = (async (target: string) => {
    calls.push(target);
    return new Response(null, { status: statuses.shift()!, headers: { "Retry-After": "1" } });
  }) as unknown as typeof fetch;
  const delays: number[] = [];
  assert.equal(await requestWake(url, fetchApi, 10_000, async (ms) => { delays.push(ms); }), true);
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [1000, 1000]);

  const failing = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  let clock = 0;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    assert.equal(await requestWake(url, failing, 5000, async (ms) => { clock += ms; }), false);
  } finally {
    Date.now = realNow;
  }
});

test("runtimeProfile announces the wake URL and owner only when set", () => {
  const bot = { name: "Ana", respondTo: "owner", ownerPubkey: human.pubkey } as BotRecord;
  assert.equal(JSON.parse(runtimeProfile(bot, agent.secret, 1).content).wake_url, undefined);
  const content = JSON.parse(runtimeProfile(bot, agent.secret, 1, url).content);
  assert.equal(content.wake_url, url);
  assert.equal(content.owner, human.pubkey);
});

test("provider url wake GETs the URL and fails when it never answers", async () => {
  const { runWake } = await import("../provider/wake.js");
  const seen: string[] = [];
  const ok = (async (target: string) => { seen.push(target); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
  await runWake({ kind: "url", url }, "req", 1000, () => "", ok);
  assert.deepEqual(seen, [url]);
  const down = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  await assert.rejects(runWake({ kind: "url", url }, "req", 50, () => "", down), /did not answer/);
});

test("WakeWatch wakes once for a message seen on two feeds", () => {
  let now = 1_000_000;
  const { watch, poked } = watcher(() => now);
  watch.accept(profile({ wake_url: url, respond_to: "anyone" }));
  const event = message();
  watch.accept(event);
  now += 61_000;
  watch.accept(event);
  assert.deepEqual(poked, [url]);
});

type Sub = { filters: readonly Record<string, unknown>[]; onEvent: (event: ReturnType<typeof signEvent>) => void;
  onClosed?: (id: string, reason: string) => void; onEose?: () => void };

function fakeClient() {
  const subs = new Map<string, Sub>();
  return {
    subs,
    subscribe(id: string, filters: readonly Record<string, unknown>[], onEvent: Sub["onEvent"], onClosed?: Sub["onClosed"], onEose?: () => void) {
      subs.set(id, { filters, onEvent, onClosed, onEose });
    },
    unsubscribe(id: string) { subs.delete(id); },
  };
}

test("ChannelFeed follows readable channels by #h, as Buzz routes live messages", () => {
  const client = fakeClient();
  const seen: string[] = [];
  let stale = 0;
  const feed = new ChannelFeed(client, (event) => seen.push(event.id), relay.pubkey, agent.pubkey, () => stale++, () => 2_000_000);
  feed.refresh();
  assert.deepEqual(client.subs.get("wake-lists")?.filters, [{ kinds: [MEMBER_LIST_KIND], authors: [relay.pubkey], "#p": [agent.pubkey] }]);
  const list = (channel: string, author = relay) => signEvent(author.secret, MEMBER_LIST_KIND, "", [["d", channel], ["p", agent.pubkey]]);
  const dm = list("dm");
  client.subs.get("wake-lists")!.onEvent(dm);
  client.subs.get("wake-lists")!.onEvent(list("room"));
  client.subs.get("wake-lists")!.onEvent(list("forged", human));
  client.subs.get("wake-lists")!.onEose!();
  assert.equal(client.subs.has("wake-lists"), false);
  assert.deepEqual(client.subs.get("wake-messages")?.filters, [{ kinds: [9], "#h": ["dm", "room"], since: 1995 }]);
  assert.ok(seen.includes(dm.id), "member lists reach the watch");

  const before = client.subs.get("wake-messages");
  feed.refresh();
  client.subs.get("wake-lists")!.onEvent(list("room"));
  client.subs.get("wake-lists")!.onEvent(list("dm"));
  client.subs.get("wake-lists")!.onEose!();
  assert.equal(client.subs.get("wake-messages"), before, "same channels keep the subscription");

  feed.refresh();
  client.subs.get("wake-lists")!.onEose!();
  assert.equal(client.subs.has("wake-messages"), false);
  feed.stop();
  assert.equal(stale, 0);
});

test("ChannelFeed reports a connection whose list read never ends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const client = fakeClient();
  let stale = 0;
  const feed = new ChannelFeed(client, () => undefined, relay.pubkey, undefined, () => stale++);
  feed.start();
  assert.deepEqual(client.subs.get("wake-lists")?.filters, [{ kinds: [MEMBER_LIST_KIND], authors: [relay.pubkey] }]);
  t.mock.timers.tick(30_000);
  assert.equal(stale, 1);
  client.subs.get("wake-lists")!.onEose!();
  t.mock.timers.tick(60_000);
  client.subs.get("wake-lists")!.onEose!();
  t.mock.timers.tick(30_000);
  assert.equal(stale, 1);
  feed.stop();
});
