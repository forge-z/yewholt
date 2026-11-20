import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hexToBytes } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { writeKey } from "../src/keys.js";
import { ownerAuthTag, signEvent, verifyAuthTag, verifyEvent } from "../src/nostr.js";

test("NIP-OA test vector verifies", () => {
  const owner = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const agent = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
  const conditions = "kind=1&created_at<1713957000";
  const sig = "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369";
  const preimage = `nostr:agent-auth:${agent}:${conditions}`;
  const digest = sha256(new TextEncoder().encode(preimage));
  assert.equal(Buffer.from(digest).toString("hex"), "08cdecd55af4c28d3801fd69615dcf5cc04fab3bc134b38a840bf157197069a6");
  assert.equal(schnorr.verify(hexToBytes(sig), digest, hexToBytes(owner)), true);
  assert.equal(verifyAuthTag(["auth", owner, conditions, sig], agent, 1713956400, 1), owner);
  assert.equal(verifyAuthTag(["auth", owner, conditions, sig], agent, 1713956400, 9), null);
});

test("signed events round-trip and key files are mode 0600", () => {
  const home = mkdtempSync(join(tmpdir(), "yewholt-keys-"));
  const owner = writeKey(join(home, "owner.key"));
  const agent = writeKey(join(home, "agent.key"));
  assert.equal(statSync(join(home, "agent.key")).mode & 0o777, 0o600);
  const event = signEvent(agent.secret, 9, "hello", [["h", "chan"], ownerAuthTag(owner.secret, agent.pubkey, "kind=9")]);
  assert.equal(verifyEvent(event), true);
  const auth = event.tags.find((tag) => tag[0] === "auth");
  assert.ok(auth);
  assert.equal(verifyAuthTag(auth, event.pubkey, event.created_at, event.kind), owner.pubkey);
});
