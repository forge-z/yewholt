import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { controlEvent, decryptControl, verifiedEnvelope, type Confirmation } from "../src/control-protocol.js";
import { RelayClient, relayDialTarget } from "../src/nostr-client.js";
import { generateKeyPair, type NostrEvent } from "../src/nostr.js";
import { botEvents, byKind, capture, PRIVATE } from "./helpers/fixture.js";

/** A loopback NIP-42 relay stub. It only speaks the frames these tests need. */
async function fakeRelay(immediateChallenge = false): Promise<{
  url: string;
  frames: unknown[][];
  hosts: string[];
  send: (frame: unknown[]) => void;
  waitFor: (pred: (frame: unknown[]) => boolean) => Promise<unknown[]>;
  stop: () => Promise<void>;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const frames: unknown[][] = [];
  const hosts: string[] = [];
  const waiters: Array<{ pred: (frame: unknown[]) => boolean; resolve: (frame: unknown[]) => void }> = [];
  let peer: WebSocket | undefined;
  server.on("connection", (socket, request) => {
    hosts.push(request.headers.host ?? "");
    peer = socket;
    // Like a real relay, the challenge comes a moment after the upgrade.
    const challenge = () => socket.send(JSON.stringify(["AUTH", "challenge-1"]));
    if (immediateChallenge) challenge();
    else setTimeout(challenge, 20);
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
    hosts,
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

test("a standalone VM daemon joins an existing relay without onboarding and serves the DeepSeek catalog", async () => {
  const relay = await fakeRelay(true);
  const home = mkdtempSync(join(tmpdir(), "yewholt-existing-relay-"));
  const provider = generateKeyPair();
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const run = (args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], {
    env: { PATH: process.env.PATH, HOME: home, YEWHOLT_HOME: home, DEEPSEEK_API_KEY: "test-key" },
    timeout: 25_000,
  });
  try {
    await run(["install", "--relay", relay.url, "--relay-pubkey", generateKeyPair().pubkey]);
    await run(["pair", "add", provider.pubkey, "--label", "Test Mac"]);
    await run(["start"]);
    const [, auth] = await relay.waitFor((frame) => frame[0] === "AUTH");
    const daemon = (auth as NostrEvent).pubkey;
    await relay.waitFor((frame) => frame[0] === "REQ" && frame[1] === "deploy-control");
    assert.equal(relay.frames.some((frame) => frame[0] === "REQ" && frame[1] === "channel"), false);
    assert.equal(relay.frames.some((frame) => frame[0] === "EVENT"), false);
    const requestId = randomUUID();
    relay.send(["EVENT", "deploy-control", controlEvent(provider.secret, daemon, "hosted-models",
      { requestId, agentPubkey: daemon }, { offset: 0 })]);
    const [, event] = await relay.waitFor((frame) => frame[0] === "EVENT");
    const reply = verifiedEnvelope(event as NostrEvent, provider.pubkey, "confirmation");
    assert.ok(reply);
    const body = decryptControl(reply, provider.secret, daemon) as Confirmation;
    assert.equal(body.ok, true);
    assert.ok(body.catalog?.models.includes("deepseek/deepseek-v4-pro"));
  } finally {
    try {
      await run(["stop"]);
    } finally {
      await relay.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("relay loopback routing is opt-in and limited to the configured public WSS relay", () => {
  const relayUrl = "wss://relay.example:8443";
  const other = "wss://other.example";
  const local = "ws://127.0.0.1:3000";
  const port = 4300;
  assert.deepEqual(relayDialTarget(relayUrl), { url: relayUrl });
  assert.deepEqual(relayDialTarget(relayUrl, { relayUrl, port }), {
    url: "ws://127.0.0.1:4300", headers: { Host: "relay.example:8443" },
  });
  assert.deepEqual(relayDialTarget(other, { relayUrl, port }), { url: other });
  assert.deepEqual(relayDialTarget(local, { relayUrl: local, port }), { url: local });
});

test("RelayClient dials loopback with the public Host and signs AUTH for the public URL", async () => {
  const relay = await fakeRelay(true);
  const relayUrl = "wss://relay.example:8443";
  const loopback = { relayUrl, port: Number(new URL(relay.url).port) };
  const client = new RelayClient(relayUrl, generateKeyPair().secret, undefined, true, loopback);
  try {
    await client.connect(2000);
    const [, auth] = await relay.waitFor((frame) => frame[0] === "AUTH");
    assert.deepEqual(relay.hosts, ["relay.example:8443"]);
    assert.deepEqual((auth as NostrEvent).tags, [["relay", relayUrl], ["challenge", "challenge-1"]]);
  } finally {
    await client.close();
    await relay.stop();
  }
});

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

test("RelayClient signals EOSE only to the named subscription", async () => {
  const relay = await fakeRelay();
  const client = new RelayClient(relay.url, generateKeyPair().secret);
  try {
    await client.connect();
    const history: string[] = [];
    client.subscribe("members", [{ kinds: [39002] }], () => {}, undefined, () => history.push("members"));
    client.subscribe("chat", [{ kinds: [9] }], () => {}, undefined, () => history.push("chat"));
    await relay.waitFor((frame) => frame[0] === "REQ" && frame[1] === "chat");
    relay.send(["EOSE", "not-subscribed"]);
    relay.send(["EOSE", "members"]);
    await tick();
    assert.deepEqual(history, ["members"]);
  } finally {
    await client.close();
    await relay.stop();
  }
});

test("RelayClient authenticates when the challenge arrives with the upgrade", { timeout: 2000 }, async () => {
  const relay = await fakeRelay(true);
  const client = new RelayClient(relay.url, generateKeyPair().secret);
  try {
    await client.connect();
    assert.ok(relay.frames.some((frame) => frame[0] === "AUTH"));
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
