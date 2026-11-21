import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { RelayClient } from "../src/nostr-client.js";
import { generateKeyPair, type NostrEvent } from "../src/nostr.js";
import { botEvents, byKind, capture, PRIVATE } from "./helpers/fixture.js";

/** A loopback NIP-42 relay stub. It only speaks the frames these tests need. */
async function fakeRelay(): Promise<{
  url: string;
  frames: unknown[][];
  send: (frame: unknown[]) => void;
  waitFor: (pred: (frame: unknown[]) => boolean) => Promise<unknown[]>;
  stop: () => Promise<void>;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const frames: unknown[][] = [];
  const waiters: Array<{ pred: (frame: unknown[]) => boolean; resolve: (frame: unknown[]) => void }> = [];
  let peer: WebSocket | undefined;
  server.on("connection", (socket) => {
    peer = socket;
    // Like a real relay, the challenge comes a moment after the upgrade.
    // RelayClient.connect() installs its challenge handler after `open`, so a
    // same-tick challenge would be dropped (pre-existing, see the report).
    setTimeout(() => socket.send(JSON.stringify(["AUTH", "challenge-1"])), 20);
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as unknown[];
      frames.push(frame);
      if (frame[0] === "AUTH") socket.send(JSON.stringify(["OK", (frame[1] as NostrEvent).id, true, ""]));
      for (const waiter of [...waiters]) {
        if (waiter.pred(frame)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    frames,
    send: (frame) => peer?.send(JSON.stringify(frame)),
    waitFor: (pred) => {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("fake relay: expected frame never arrived")), 2000);
        waiters.push({ pred, resolve: (frame) => (clearTimeout(timer), resolve(frame)) });
      });
    },
    stop: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("RelayClient routes EVENT frames to the subscription that asked for them only", async () => {
  const relay = await fakeRelay();
  const client = new RelayClient(relay.url, generateKeyPair().secret);
  try {
    await client.connect();
    const members: string[] = [];
    const chat: string[] = [];
    client.subscribe("members", [{ kinds: [39002], "#p": ["x"] }], (event) => members.push(event.id));
    client.subscribe(`chat:${PRIVATE}`, [{ kinds: [9], "#h": [PRIVATE] }], (event) => chat.push(event.id));
    await relay.waitFor((frame) => frame[0] === "REQ" && frame[1] === `chat:${PRIVATE}`);
    const list = byKind(39002, PRIVATE);
    const message = byKind(9);
    relay.send(["EVENT", "members", list]);
    relay.send(["EVENT", `chat:${PRIVATE}`, message]);
    relay.send(["EVENT", "nobody-asked", byKind(9007)]);
    relay.send(["EOSE", "members"]);
    await tick();
    assert.deepEqual(members, [list.id]);
    assert.deepEqual(chat, [message.id]);
  } finally {
    await client.close();
    await relay.stop();
  }
});

test("RelayClient.unsubscribe sends CLOSE and drops the handler", async () => {
  const relay = await fakeRelay();
  const client = new RelayClient(relay.url, generateKeyPair().secret);
  try {
    await client.connect();
    const seen: string[] = [];
    client.subscribe("chat", [{ kinds: [9], "#h": [PRIVATE] }], (event) => seen.push(event.id));
    await relay.waitFor((frame) => frame[0] === "REQ" && frame[1] === "chat");
    client.unsubscribe("chat");
    assert.deepEqual(await relay.waitFor((frame) => frame[0] === "CLOSE"), ["CLOSE", "chat"]);
    relay.send(["EVENT", "chat", byKind(9)]);
    await tick();
    assert.equal(seen.length, 0);
    // Re-subscribing under the same id works again.
    client.subscribe("chat", [{ kinds: [9], "#h": [PRIVATE] }], (event) => seen.push(event.id));
    await relay.waitFor((frame) => frame[0] === "REQ" && frame[1] === "chat" && relay.frames.filter((f) => f[0] === "REQ").length === 2);
    relay.send(["EVENT", "chat", byKind(9)]);
    await tick();
    assert.deepEqual(seen, [byKind(9).id]);
  } finally {
    await client.close();
    await relay.stop();
  }
});

test("RelayClient surfaces CLOSED to the subscription callback and logs it once with the reason", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  const relay = await fakeRelay();
  const client = new RelayClient(relay.url, generateKeyPair().secret);
  try {
    await client.connect();
    const closed: Array<[string, string]> = [];
    const seen: string[] = [];
    client.subscribe("channel", [{ kinds: [9], "#h": [PRIVATE] }], (event) => seen.push(event.id), (id, reason) => closed.push([id, reason]));
    client.subscribe("other", [{ kinds: [9] }], () => undefined);
    await relay.waitFor((frame) => frame[0] === "REQ" && frame[1] === "other");
    const [, , reason] = capture().owner_req_private_channel_closed;
    relay.send(["CLOSED", "channel", reason]);
    relay.send(["CLOSED", "channel", reason]);
    await tick();
    assert.deepEqual(closed, [["channel", reason]]);
    assert.equal(logged.filter((line) => line.includes(reason)).length, 1);
    assert.ok(logged.some((line) => line.includes("channel") && line.includes("restricted: not a channel member")));
    // The closed subscription no longer receives events.
    relay.send(["EVENT", "channel", byKind(9)]);
    await tick();
    assert.deepEqual(seen, []);
    assert.ok(client.isOpen());
  } finally {
    await client.close();
    await relay.stop();
  }
});

test("RelayClient ignores a relay CLOSED for an id it closed itself, even after re-subscribing", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  const relay = await fakeRelay();
  const client = new RelayClient(relay.url, generateKeyPair().secret);
  try {
    await client.connect();
    const closed: string[] = [];
    const seen: string[] = [];
    client.subscribe("x", [{ kinds: [9] }], (event) => seen.push(event.id), (id) => closed.push(id));
    await relay.waitFor((frame) => frame[0] === "REQ" && frame[1] === "x");
    client.unsubscribe("x");
    await relay.waitFor((frame) => frame[0] === "CLOSE" && frame[1] === "x");
    client.subscribe("x", [{ kinds: [9] }], (event) => seen.push(event.id), (id) => closed.push(id));
    await relay.waitFor((frame) => frame[0] === "REQ" && frame[1] === "x" && relay.frames.filter((f) => f[0] === "REQ").length === 2);
    // The live order from the Buzz relay: its CLOSED for our CLOSE lands after the new REQ.
    relay.send(["CLOSED", "x", ""]);
    relay.send(["EVENT", "x", byKind(9)]);
    await tick();
    assert.deepEqual(seen, [byKind(9).id], "the second handler still receives EVENTs");
    assert.deepEqual(closed, [], "no onClosed for a CLOSED we asked for");
    assert.deepEqual(logged, [], "our own CLOSE is not logged as a relay close");
  } finally {
    await client.close();
    await relay.stop();
  }
});

test("RelayClient still drops the handler and calls onClosed for a relay-initiated CLOSED", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const relay = await fakeRelay();
  const client = new RelayClient(relay.url, generateKeyPair().secret);
  try {
    await client.connect();
    const closed: string[] = [];
    const seen: string[] = [];
    client.subscribe("never-unsubscribed", [{ kinds: [9] }], (event) => seen.push(event.id), (id) => closed.push(id));
    await relay.waitFor((frame) => frame[0] === "REQ" && frame[1] === "never-unsubscribed");
    relay.send(["CLOSED", "never-unsubscribed", "restricted: not a channel member"]);
    relay.send(["EVENT", "never-unsubscribed", byKind(9)]);
    await tick();
    assert.deepEqual(closed, ["never-unsubscribed"]);
    assert.deepEqual(seen, []);
  } finally {
    await client.close();
    await relay.stop();
  }
});

test("RelayClient keeps AUTH and publish OK handling", async () => {
  const relay = await fakeRelay();
  const client = new RelayClient(relay.url, generateKeyPair().secret, ["auth", "00".repeat(32), "", "00".repeat(64)]);
  try {
    await client.connect();
    const auth = relay.frames.find((frame) => frame[0] === "AUTH");
    assert.ok(auth);
    assert.ok((auth[1] as NostrEvent).tags.some((tag) => tag[0] === "auth"));
    const event = botEvents()[0]!;
    const pending = client.publish(event);
    await relay.waitFor((frame) => frame[0] === "EVENT");
    relay.send(["OK", event.id, false, "duplicate: already have it"]);
    assert.deepEqual(await pending, { ok: false, message: "duplicate: already have it" });
    assert.ok(client.isOpen());
  } finally {
    await client.close();
    await relay.stop();
  }
});
