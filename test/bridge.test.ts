import assert from "node:assert/strict";
import { test } from "node:test";
import { BotLinks, humanMessageFrom, Inbox, publishAll, type ChatClient, type LinkBot } from "../src/bridge.js";
import { generateKeyPair, signEvent, type NostrEvent } from "../src/nostr.js";
import type { HumanMessage } from "../src/session.js";
import { botEvents, byKind, capture, CODER, INSTALL, OWNER, PRIVATE, privateListWithoutCoder, RELAY } from "./helpers/fixture.js";

type Sub = { filters: readonly Record<string, unknown>[]; onEvent: (event: NostrEvent) => void; onClosed?: (id: string, reason: string) => void };

/** Records what a RelayClient would put on the wire. No socket. */
class FakeClient implements ChatClient {
  readonly subs = new Map<string, Sub>();
  readonly wire: string[] = [];
  readonly published: NostrEvent[] = [];
  open = true;
  closed = false;
  constructor(readonly pubkey: string) {}
  subscribe(id: string, filters: readonly Record<string, unknown>[], onEvent: (event: NostrEvent) => void, onClosed?: (id: string, reason: string) => void): void {
    this.subs.set(id, { filters, onEvent, onClosed });
    this.wire.push(`REQ ${id}`);
  }
  unsubscribe(id: string): void {
    this.subs.delete(id);
    this.wire.push(`CLOSE ${id}`);
  }
  async publish(event: NostrEvent) {
    this.published.push(event);
    return { ok: true, message: "" };
  }
  async close(): Promise<void> {
    this.closed = true;
    this.open = false;
  }
  isOpen(): boolean {
    return this.open;
  }
  emit(id: string, event: NostrEvent): void {
    this.subs.get(id)?.onEvent(event);
  }
  /** Subscription id for `prefix`, whether bare or counter-suffixed ("members-d#2"). */
  id(prefix: string): string | undefined {
    return [...this.subs.keys()].find((key) => key === prefix || key.startsWith(`${prefix}#`));
  }
  has(prefix: string): boolean {
    return this.id(prefix) !== undefined;
  }
  sub(prefix: string): Sub | undefined {
    const id = this.id(prefix);
    return id === undefined ? undefined : this.subs.get(id);
  }
  relayClosed(id: string, reason: string): void {
    const sub = this.subs.get(id);
    this.subs.delete(id);
    sub?.onClosed?.(id, reason);
  }
}

const onboardingBot: LinkBot = { pubkey: "0b".repeat(32), name: "Onboarding Specialist", scope: [INSTALL], status: "active" };
const coderBot: LinkBot = { pubkey: CODER, name: "Coder", scope: [INSTALL], status: "active" };

function harness(relayPubkey: string | null = RELAY) {
  const clients = new Map<string, FakeClient[]>();
  const membership = new Map<string, string[]>();
  const messages: HumanMessage[] = [];
  const inbox = new Inbox((message) => messages.push(message));
  const links = new BotLinks({
    relayPubkey,
    since: () => 1_795_231_700,
    open: async (bot) => {
      const client = new FakeClient(bot.pubkey);
      clients.set(bot.pubkey, [...(clients.get(bot.pubkey) ?? []), client]);
      return client;
    },
    onEvent: inbox.accept,
    onMembership: (pubkey, channels) => membership.set(pubkey, [...channels].sort()),
  });
  const latest = (pubkey: string) => clients.get(pubkey)!.at(-1)!;
  return { clients, membership, messages, inbox, links, latest };
}

test("humanMessageFrom takes the channel from the h tag of the fixture kind 9", () => {
  const event = byKind(9);
  assert.deepEqual(humanMessageFrom(event), {
    channelId: PRIVATE,
    authorPubkey: event.pubkey,
    eventId: event.id,
    text: "@Coder apenas responda ok",
    createdAt: event.created_at,
  });
  assert.equal(humanMessageFrom(byKind(9007)), null);
  assert.equal(humanMessageFrom({ ...event, tags: event.tags.filter((tag) => tag[0] !== "h") }), null);
});

test("dedupe: the same event id arriving on two connections is handled exactly once", () => {
  const messages: HumanMessage[] = [];
  const inbox = new Inbox((message) => messages.push(message));
  const owner = new FakeClient(OWNER);
  const coder = new FakeClient(CODER);
  const other = new FakeClient("0c".repeat(32));
  owner.subscribe("channel", [{ kinds: [9], "#h": [INSTALL] }], inbox.accept);
  coder.subscribe(`chat:${PRIVATE}`, [{ kinds: [9], "#h": [PRIVATE] }], inbox.accept);
  other.subscribe(`chat:${PRIVATE}`, [{ kinds: [9], "#h": [PRIVATE] }], inbox.accept);
  const event = byKind(9);
  coder.emit(`chat:${PRIVATE}`, event);
  other.emit(`chat:${PRIVATE}`, event);
  owner.emit("channel", event);
  coder.emit(`chat:${PRIVATE}`, event);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.channelId, PRIVATE);
  assert.equal(messages[0]!.eventId, event.id);
});

test("bot link: own 39002 #p subscription, kind 9 per effective channel, re-subscribe on membership change", async () => {
  const h = harness();
  await h.links.sync([onboardingBot, coderBot]);
  const coder = h.latest(CODER);
  assert.deepEqual(coder.subs.get("members")?.filters, [{ kinds: [39002], "#p": [CODER] }]);
  assert.deepEqual(coder.sub(`chat:${INSTALL}`)?.filters, [{ kinds: [9], "#h": [INSTALL], since: 1_795_231_700 }]);
  assert.equal(coder.has(`chat:${PRIVATE}`), false);
  assert.equal(h.links.client(CODER), coder);

  // The relay replays the stored 39002s that list Coder.
  for (const event of botEvents()) coder.emit("members", event);
  assert.deepEqual(h.membership.get(CODER), [PRIVATE, INSTALL].sort());
  assert.deepEqual(coder.sub(`chat:${PRIVATE}`)?.filters, [{ kinds: [9], "#h": [PRIVATE], since: 1_795_231_700 }]);
  assert.deepEqual(h.links.channels(CODER), [INSTALL, PRIVATE]);
  // Removal detection: the newest list per member channel, whether or not it still names Coder.
  assert.deepEqual(coder.sub("members-d")?.filters, [{ kinds: [39002], "#d": [INSTALL, PRIVATE] }]);

  // The fixture message reaches the inbox through Coder's own connection, channel from h.
  const chatId = coder.id(`chat:${PRIVATE}`);
  assert.ok(chatId);
  coder.emit(chatId, byKind(9));
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0]!.channelId, PRIVATE);

  // Removed in the app: newer list without Coder. Unsubscribe that channel and re-issue members-d.
  const before = coder.wire.length;
  const oldChat = coder.id(`chat:${PRIVATE}`);
  const oldD = coder.id("members-d");
  assert.ok(oldChat && oldD);
  coder.emit(oldD, privateListWithoutCoder());
  assert.deepEqual(h.membership.get(CODER), [INSTALL]);
  assert.equal(coder.has(`chat:${PRIVATE}`), false);
  assert.ok(coder.has(`chat:${INSTALL}`), "stored scope stays subscribed");
  const newD = coder.id("members-d");
  assert.deepEqual(coder.wire.slice(before), [`CLOSE ${oldChat}`, `CLOSE ${oldD}`, `REQ ${newD}`]);
  assert.deepEqual(coder.sub("members-d")?.filters, [{ kinds: [39002], "#d": [INSTALL] }]);

  // A forged list (not the relay key) changes nothing and causes no wire traffic.
  const forged = signEvent(generateKeyPair().secret, 39002, "", byKind(39002, PRIVATE).tags, privateListWithoutCoder().created_at + 10);
  const quiet = coder.wire.length;
  coder.emit("members", forged);
  assert.deepEqual(h.membership.get(CODER), [INSTALL]);
  assert.equal(coder.wire.length, quiet);

  // An older replay of the add does not resurrect the channel.
  coder.emit("members", byKind(39002, PRIVATE));
  assert.deepEqual(h.membership.get(CODER), [INSTALL]);
});

test("bot link: no relay key means no 39002 subscription and only the stored scope", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const h = harness(null);
  await h.links.sync([coderBot]);
  const coder = h.latest(CODER);
  assert.equal(coder.has("members"), false);
  assert.deepEqual([...coder.subs.keys()], [coder.id(`chat:${INSTALL}`)]);
  coder.emit("members", byKind(39002, PRIVATE));
  assert.equal(coder.subs.has(`chat:${PRIVATE}`), false);
});

test("bot link: each members-d subscription gets a fresh id, so a stale CLOSED cannot cancel the live one", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const h = harness();
  await h.links.sync([coderBot]);
  const coder = h.latest(CODER);
  for (const event of botEvents()) coder.emit("members", event);
  const firstId = coder.id("members-d");
  assert.ok(firstId);
  const staleClosed = coder.sub("members-d")?.onClosed;
  assert.ok(staleClosed);
  // Two consecutive refreshes with different member channels: removal in the app.
  const before = coder.wire.length;
  const oldChat = coder.id(`chat:${PRIVATE}`);
  assert.ok(oldChat);
  coder.emit(firstId, privateListWithoutCoder());
  const secondId = coder.id("members-d");
  assert.ok(secondId);
  assert.notEqual(secondId, firstId);
  assert.deepEqual(coder.wire.slice(before), [`CLOSE ${oldChat}`, `CLOSE ${firstId}`, `REQ ${secondId}`]);

  // The relay's CLOSED for the id we already closed arrives late, after REQ secondId.
  staleClosed(firstId, "");
  assert.ok(coder.has(secondId), "the live members-d subscription survives");
  assert.deepEqual(coder.sub(secondId)?.filters, [{ kinds: [39002], "#d": [INSTALL] }]);

  // The surviving subscription still delivers: a newer list re-adds Coder.
  coder.emit(secondId, { ...byKind(39002, PRIVATE), created_at: byKind(39002, PRIVATE).created_at + 120 });
  assert.deepEqual(h.membership.get(CODER), [PRIVATE, INSTALL].sort());
  assert.equal([...coder.subs.keys()].filter((id) => id.startsWith("members-d")).length, 1);
  const thirdId = coder.id("members-d");
  assert.ok(thirdId);
  assert.notEqual(thirdId, firstId, "a closed id is never reused");
});

test("bot link: a CLOSED channel is not retried until the relay lists the bot there", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const h = harness();
  await h.links.sync([{ ...coderBot, scope: [INSTALL, PRIVATE] }]);
  const coder = h.latest(CODER);
  const [, , reason] = capture().owner_req_private_channel_closed;
  const privateId = coder.id(`chat:${PRIVATE}`);
  assert.ok(privateId);
  coder.relayClosed(privateId, reason);
  await h.links.sync([{ ...coderBot, scope: [INSTALL, PRIVATE] }]);
  assert.equal(coder.has(`chat:${PRIVATE}`), false);
  assert.ok(coder.has(`chat:${INSTALL}`));
  coder.emit("members", byKind(39002, PRIVATE));
  assert.ok(coder.has(`chat:${PRIVATE}`));
});

test("bot link lifecycle: approved create/start opens a connection, stop closes it, scope change re-subscribes", async () => {
  const h = harness();
  await h.links.sync([onboardingBot]);
  assert.equal(h.clients.has(CODER), false);
  await h.links.sync([onboardingBot, coderBot]);
  const first = h.latest(CODER);
  for (const event of botEvents()) first.emit("members", event);
  assert.deepEqual(h.membership.get(CODER), [PRIVATE, INSTALL].sort());

  await h.links.sync([onboardingBot, { ...coderBot, status: "stopped" }]);
  assert.equal(first.closed, true);
  assert.equal(h.links.client(CODER), undefined);
  assert.deepEqual(h.membership.get(CODER), []);
  assert.equal(h.latest(onboardingBot.pubkey).closed, false);

  await h.links.sync([onboardingBot, coderBot]);
  const second = h.latest(CODER);
  assert.notEqual(second, first);
  const elsewhere = "44444444-4444-4444-8444-444444444444";
  await h.links.sync([onboardingBot, { ...coderBot, scope: [INSTALL, elsewhere] }]);
  assert.ok(second.has(`chat:${elsewhere}`));
  await h.links.sync([onboardingBot, coderBot]);
  assert.equal(second.has(`chat:${elsewhere}`), false);

  await h.links.closeAll();
  assert.equal(second.closed, true);
  assert.deepEqual(h.membership.get(CODER), []);
  // A turn that finishes after serve ended must not open new connections.
  const opened = h.clients.get(CODER)!.length;
  await h.links.sync([onboardingBot, coderBot]);
  assert.equal(h.clients.get(CODER)!.length, opened);
});

test("bot link: a dropped bot connection is reported so serve can restart", async () => {
  const h = harness();
  await h.links.sync([onboardingBot, coderBot]);
  assert.equal(h.links.lost(), undefined);
  h.latest(CODER).open = false;
  assert.equal(h.links.lost()?.pubkey, CODER);
});

test("external bot link forwards its auth record, tracks DM changes, and reconnects on relay changes", async () => {
  const direct = new Map<string, string[]>();
  const opened: LinkBot[] = [];
  const clients: FakeClient[] = [];
  const links = new BotLinks({
    relayPubkey: RELAY,
    open: async (bot) => {
      opened.push(bot);
      const client = new FakeClient(bot.pubkey);
      clients.push(client);
      return client;
    },
    onEvent: () => undefined,
    onMembership: (pubkey, _channels, DMs) => direct.set(pubkey, [...DMs]),
  });
  const bot = { ...coderBot, external: true as const, relayUrl: "wss://first.invalid", authTag: ["auth", OWNER, "", "fixture"] };
  await links.sync([bot]);
  assert.equal(opened[0], bot);
  assert.deepEqual(links.connectedAgents(), [CODER]);
  const client = clients[0]!;
  const base = byKind(39002, PRIVATE);
  const dm = { ...base, tags: [["d", PRIVATE], ["p", CODER], ["p", OWNER]] };
  client.emit("members", dm);
  assert.deepEqual(direct.get(CODER), [PRIVATE]);
  client.emit(client.id("members-d")!, { ...dm, tags: [...dm.tags, ["p", "ab".repeat(32)]], created_at: dm.created_at + 1 });
  assert.deepEqual(direct.get(CODER), []);
  assert.ok(client.has(`chat:${PRIVATE}`));

  client.open = false;
  assert.equal(links.lost(), undefined);
  await links.sync([bot]);
  assert.equal(client.closed, true);
  assert.deepEqual(links.connectedAgents(), [CODER]);
  const reconfigured = { ...bot, relayUrl: "wss://second.invalid" };
  await links.sync([reconfigured]);
  assert.equal(clients[1]?.closed, true);
  assert.equal(opened[2], reconfigured);
  await links.sync([{ ...reconfigured, status: "stopped" }]);
  assert.deepEqual(links.connectedAgents(), []);
  assert.equal(clients[2]?.closed, true);
});

test("a hosted agent discovers a DM stored after its initial members request without reconnecting", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const h = harness();
  const bot: LinkBot = { ...coderBot, external: true, scope: [] };
  await h.links.sync([onboardingBot]);
  await h.links.sync([onboardingBot, bot]);
  const client = h.latest(CODER);
  assert.deepEqual(client.wire, ["REQ members"]);
  assert.deepEqual(h.links.channels(CODER), []);

  // The new DM is available to subsequent REQs, but the original REQ gets no live event.
  const dm = { ...byKind(39002, PRIVATE), tags: [["d", PRIVATE], ["p", CODER], ["p", OWNER]] };
  now = 9_999;
  await h.links.sync([onboardingBot, bot]);
  assert.deepEqual(client.wire, ["REQ members"]);
  now = 10_000;
  await h.links.sync([onboardingBot, bot]);
  assert.equal(h.latest(CODER), client);
  assert.deepEqual(client.wire, ["REQ members", "REQ members"]);
  assert.deepEqual(client.sub("members")?.filters, [{ kinds: [39002], "#p": [CODER] }]);

  client.emit("members", dm);
  assert.deepEqual(h.links.channels(CODER), [PRIVATE]);
  assert.deepEqual(client.sub(`chat:${PRIVATE}`)?.filters, [{ kinds: [9], "#h": [PRIVATE], since: 1_795_231_700 }]);
  assert.deepEqual(client.sub("members-d")?.filters, [{ kinds: [39002], "#d": [PRIVATE] }]);
  client.emit(client.id(`chat:${PRIVATE}`)!, byKind(9));
  assert.equal(h.messages[0]?.channelId, PRIVATE);
  assert.equal(h.latest(onboardingBot.pubkey).wire.filter((frame) => frame === "REQ members").length, 1);
});

test("publishAll: each event goes out on its signer's own connection, owner first, temporary links closed", async () => {
  const owner = new FakeClient(OWNER);
  const coder = new FakeClient(CODER);
  const temp: FakeClient[] = [];
  const reply = { ...byKind(9), pubkey: CODER, id: "r1" };
  const ownerEvent = { ...byKind(9000, INSTALL), id: "o1" };
  const fresh = { ...byKind(9), pubkey: "0d".repeat(32), id: "f1" };
  const acked = await publishAll(
    [reply, fresh, ownerEvent],
    OWNER,
    (pubkey) => (pubkey === OWNER ? owner : pubkey === CODER ? coder : undefined),
    async (pubkey) => {
      const client = new FakeClient(pubkey);
      temp.push(client);
      return client;
    },
  );
  assert.deepEqual(acked, ["o1", "r1", "f1"]);
  assert.deepEqual(owner.published.map((event) => event.id), ["o1"]);
  assert.deepEqual(coder.published.map((event) => event.id), ["r1"]);
  assert.equal(coder.closed, false);
  assert.equal(temp.length, 1);
  assert.deepEqual(temp[0]!.published.map((event) => event.id), ["f1"]);
  assert.equal(temp[0]!.closed, true);
});
