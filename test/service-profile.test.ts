import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { hostname } from "node:os";
import test from "node:test";
import { WebSocketServer } from "ws";
import { namedRelayMembers, publishProviderProfile } from "../provider/relay.js";
import { generateKeyPair, signEvent, verifyEvent, type NostrEvent } from "../src/nostr.js";
import { daemonProfileEvent, machineLabel, OFFER_TAG, OWNER_TAG } from "../src/pairing-offer.js";

test("daemon profiles identify the machine by default and preserve a customized profile when closing a pairing offer", () => {
  const { secret, pubkey } = generateKeyPair();
  const offer = { key: "b".repeat(64), relayUrl: "wss://relay.example", label: "Build VM", createdAt: 1,
    expiresAt: 1000, owner: "a".repeat(64) };
  const event = daemonProfileEvent(secret, pubkey, undefined, offer, 100);
  const name = `Yewholt · daemon (${hostname().slice(0, 90)})`;
  assert.deepEqual(JSON.parse(event.content), { name, display_name: name, about: "Yewholt service key. Do not remove." });
  assert.deepEqual(event.tags.map(([tag]) => tag), [OFFER_TAG, OWNER_TAG]);
  assert.equal(event.tags[0]![2], "Build VM");
  assert.ok(verifyEvent(event));
  assert.equal(daemonProfileEvent(secret, pubkey, undefined, offer, 200, event), undefined);

  const custom = signEvent(secret, 0, JSON.stringify({
    name: "my-builder", display_name: "My Builder", about: "Private build queue", picture: "https://example.org/avatar.png",
  }), [...event.tags, ["x", "extra"]], 101);
  const closed = daemonProfileEvent(secret, pubkey, undefined, undefined, 101, custom)!;
  assert.deepEqual(closed.tags, [["x", "extra"]]);
  assert.equal(closed.created_at, 102);
  assert.deepEqual(JSON.parse(closed.content), {
    name: "my-builder", display_name: "My Builder",
    about: "Private build queue\n\nYewholt service key. Do not remove.", picture: "https://example.org/avatar.png",
  });
});

test("daemon replaces legacy self-join hostname profiles, even if an earlier update added the notice", () => {
  const { secret, pubkey } = generateKeyPair();
  const host = machineLabel();
  const name = JSON.parse(daemonProfileEvent(secret, pubkey).content).display_name;
  const notice = "Yewholt service key. Do not remove.";
  for (const about of ["Yewholt daemon", notice]) {
    const current = signEvent(secret, 0, JSON.stringify({ name: host, display_name: host, about }), [["x", "extra"]], 100);
    const migrated = daemonProfileEvent(secret, pubkey, undefined, undefined, 100, current)!;
    assert.deepEqual(JSON.parse(migrated.content), { name, display_name: name, about: notice });
    assert.deepEqual(migrated.tags, current.tags);
    assert.equal(migrated.created_at, 101);
    assert.ok(verifyEvent(migrated));
    assert.equal(daemonProfileEvent(secret, pubkey, undefined, undefined, 102, migrated), undefined);
    assert.equal(JSON.parse(daemonProfileEvent(secret, pubkey, "My watcher", undefined, 101, current)!.content).display_name,
      "My watcher");
  }
  const custom = signEvent(secret, 0, JSON.stringify({ name: host, display_name: host, about: "Build queue" }), [], 100);
  const kept = daemonProfileEvent(secret, pubkey, undefined, undefined, 101, custom)!;
  assert.equal(JSON.parse(kept.content).display_name, host);
});

test("provider publishes kind 0 once, and a read-only roster resolves profile names like the Buzz member panel", async (t) => {
  const provider = generateKeyPair(), relayKey = generateKeyPair(), unnamed = generateKeyPair();
  const roster = signEvent(relayKey.secret, 13534, "", [["member", provider.pubkey, "member"], ["member", unnamed.pubkey, "member"]]);
  const server = createServer((_req, res) => res.end(JSON.stringify({ self: relayKey.pubkey })));
  const sockets = new WebSocketServer({ server });
  const writes: NostrEvent[] = [];
  sockets.on("connection", (socket) => {
    socket.send(JSON.stringify(["AUTH", "test-challenge"]));
    socket.on("message", (raw) => {
      const [op, id, filter] = JSON.parse(raw.toString());
      if (op === "AUTH") {
        assert.ok(verifyEvent(id));
        assert.equal(id.pubkey, provider.pubkey);
        socket.send(JSON.stringify(["OK", id.id, true, ""]));
      }
      if (op === "REQ") {
        const events = filter.kinds.includes(13534) ? [roster] : writes.filter((event) => filter.authors.includes(event.pubkey));
        for (const event of events) socket.send(JSON.stringify(["EVENT", id, event]));
        socket.send(JSON.stringify(["EOSE", id]));
      }
      if (op === "EVENT") {
        assert.equal(id.kind, 0);
        assert.equal(id.pubkey, provider.pubkey);
        assert.ok(verifyEvent(id));
        writes.push(id);
        socket.send(JSON.stringify(["OK", id.id, true, ""]));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { sockets.close(); server.close(); });
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const relay = `ws://127.0.0.1:${addr.port}`;
  await publishProviderProfile(relay, provider.secret);
  await publishProviderProfile(relay, provider.secret);
  const members = await namedRelayMembers(relay, provider.secret);
  assert.equal(writes.length, 1, "reconnect and member listing must not write another event");
  const event = writes[0]!;
  const role = process.platform === "darwin" ? "provider do Mac" : "provider";
  const name = `Yewholt · ${role} (${hostname().slice(0, 90)})`;
  assert.deepEqual(JSON.parse(event.content), { name, display_name: name, about: "Yewholt service key. Do not remove." });
  assert.deepEqual(members, [{ pubkey: provider.pubkey, name }, { pubkey: unnamed.pubkey, name: null }]);
  t.diagnostic("Signed kind 0: " + JSON.stringify(event));
  t.diagnostic("CommunityAdmin label (profile display_name + npub suffix): " + name + " · npub…<suffix>");
});
