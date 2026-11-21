import assert from "node:assert/strict";
import { test } from "node:test";
import { pubkeyOf } from "../src/nostr.js";
import { open, seal } from "./helpers/control-spike-crypto.js";

test("control spike ciphertext round-trips only with the original agent and request AAD", () => {
  const sender = "01".padStart(64, "0");
  const recipient = "02".padStart(64, "0");
  const context = { agentPubkey: pubkeyOf("03".padStart(64, "0")), requestId: "deploy-1" };
  const payload = '{"op":"deploy","fixture":true}';
  const content = seal(payload, sender, pubkeyOf(recipient), context);
  assert.equal(open(content, recipient, pubkeyOf(sender), context), payload);
  assert.throws(() => open(content, recipient, pubkeyOf(sender), { ...context, requestId: "deploy-2" }));
  assert.throws(() => open(content, recipient, pubkeyOf(sender), { ...context, agentPubkey: pubkeyOf(sender) }));
});
