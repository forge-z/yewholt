import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPair } from "../src/nostr.js";
import { DelegatedReaders, delegationEvent } from "../src/wake-delegation.js";

const vm = generateKeyPair();
const watcher = generateKeyPair();
const agent = generateKeyPair();
const tag = ["auth", "owner", "", "sig"];

function readers() {
  const opened: { agent: string; secret: string; authTag?: string[]; closed: boolean }[] = [];
  const delegated = new DelegatedReaders(watcher.secret, async (pubkey, secret, authTag) => {
    const entry = { agent: pubkey, secret, authTag, closed: false };
    opened.push(entry);
    return { close: async () => { entry.closed = true; } };
  });
  return { delegated, opened };
}

test("a delegation opens one reader as the agent, sealed to the watcher only", async () => {
  const { delegated, opened } = readers();
  assert.deepEqual(delegated.filters(), [{ kinds: [1059], "#p": [watcher.pubkey] }]);
  const event = delegationEvent(vm.secret, watcher.pubkey, agent.pubkey, agent.secret, tag, 1_000_000);
  assert.equal(event.content.includes(agent.secret), false);
  delegated.accept(event);
  delegated.accept(delegationEvent(vm.secret, watcher.pubkey, agent.pubkey, agent.secret, tag, 2_000_000));
  assert.deepEqual(opened, [{ agent: agent.pubkey, secret: agent.secret, authTag: tag, closed: false }]);

  const other = readers();
  other.delegated.accept(delegationEvent(vm.secret, generateKeyPair().pubkey, agent.pubkey, agent.secret, tag));
  assert.deepEqual(other.opened, [], "sealed to another watcher");
  other.delegated.accept(delegationEvent(vm.secret, watcher.pubkey, agent.pubkey, generateKeyPair().secret, tag));
  assert.deepEqual(other.opened, [], "the key must belong to the named agent");
  await delegated.closeAll();
  assert.equal(opened[0].closed, true);
});

test("a newer delegation with a new auth tag replaces the reader; an older one is ignored", async () => {
  const { delegated, opened } = readers();
  delegated.accept(delegationEvent(vm.secret, watcher.pubkey, agent.pubkey, agent.secret, tag, 2_000_000));
  delegated.accept(delegationEvent(vm.secret, watcher.pubkey, agent.pubkey, agent.secret, ["auth", "older"], 1_000_000));
  assert.equal(opened.length, 1);
  delegated.accept(delegationEvent(vm.secret, watcher.pubkey, agent.pubkey, agent.secret, ["auth", "new"], 3_000_000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened.length, 2);
  assert.equal(opened[0].closed, true);
  assert.deepEqual(opened[1].authTag, ["auth", "new"]);
  await delegated.closeAll();
});
