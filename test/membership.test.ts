import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { effectiveScope, memberChannels, newestMemberLists } from "../src/membership.js";
import { generateKeyPair, signEvent } from "../src/nostr.js";
import { ADMIN, botEvents, byKind, CODER, INSTALL, OWNER, PRIVATE, privateListWithoutCoder, RELAY } from "./helpers/fixture.js";

test("membership: Coder is in the install channel and the private channel from the relay-signed 39002s", () => {
  assert.deepEqual([...memberChannels(botEvents(), CODER, RELAY)].sort(), [PRIVATE, INSTALL].sort());
  // Owner key only sees the install channel list; it is listed there as owner.
  assert.deepEqual([...memberChannels(botEvents(), OWNER, RELAY)], [INSTALL]);
  // Admin is owner of the private channel and admin of the install channel: any role counts.
  assert.deepEqual([...memberChannels(botEvents(), ADMIN, RELAY)].sort(), [PRIVATE, INSTALL].sort());
});

test("membership: kind 9000/9007/9 alone never grant membership", () => {
  const noLists = botEvents().filter((event) => event.kind !== 39002);
  assert.equal(noLists.length, 4);
  assert.deepEqual([...memberChannels(noLists, CODER, RELAY)], []);
});

test("membership: a newer 39002 without Coder removes the private channel, order does not matter", () => {
  const removed = privateListWithoutCoder();
  assert.deepEqual([...memberChannels([...botEvents(), removed], CODER, RELAY)], [INSTALL]);
  assert.deepEqual([...memberChannels([removed, ...botEvents()], CODER, RELAY)], [INSTALL]);
  // The newest list wins per d tag.
  assert.equal(newestMemberLists([removed, ...botEvents()], RELAY).get(PRIVATE)?.id, removed.id);
});

test("membership: ties on created_at go to the lowest id", () => {
  const removed = privateListWithoutCoder(0);
  const original = byKind(39002, PRIVATE);
  assert.equal(removed.created_at, original.created_at);
  const winner = [removed.id, original.id].sort()[0];
  assert.equal(newestMemberLists([original, removed], RELAY).get(PRIVATE)?.id, winner);
  assert.equal(newestMemberLists([removed, original], RELAY).get(PRIVATE)?.id, winner);
});

test("membership: a 39002 signed by any key other than the relay key is ignored", () => {
  // Same events, different trust anchor: nothing is trusted.
  assert.deepEqual([...memberChannels(botEvents(), CODER, OWNER)], []);
  assert.deepEqual([...memberChannels(botEvents(), CODER, ADMIN)], []);
  // A forger re-signs the relay's exact tags under its own key, newer, without Coder.
  const forger = generateKeyPair();
  const real = byKind(39002, PRIVATE);
  const forgedRemove = signEvent(forger.secret, 39002, "", privateListWithoutCoder().tags, real.created_at + 600);
  assert.deepEqual([...memberChannels([...botEvents(), forgedRemove], CODER, RELAY)].sort(), [PRIVATE, INSTALL].sort());
  // ...or claims Coder is in a channel it was never added to.
  const forgedAdd = signEvent(forger.secret, 39002, "", real.tags.map((tag) => (tag[0] === "d" ? ["d", "00000000-0000-4000-8000-000000000000"] : tag)), real.created_at + 600);
  assert.deepEqual([...memberChannels([forgedAdd], CODER, RELAY)], []);
});

test("membership: missing relay key means an empty set (fail closed)", () => {
  assert.deepEqual([...memberChannels(botEvents(), CODER, null)], []);
  assert.equal(newestMemberLists(botEvents(), null).size, 0);
});

test("effective scope is the stored scope plus member channels, stored order first, no duplicates", () => {
  assert.deepEqual(effectiveScope([INSTALL], new Set([PRIVATE, INSTALL])), [INSTALL, PRIVATE]);
  assert.deepEqual(effectiveScope([INSTALL], new Set()), [INSTALL]);
  assert.deepEqual(effectiveScope([], undefined), []);
});
