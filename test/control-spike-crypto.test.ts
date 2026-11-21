import assert from "node:assert/strict";
import { test } from "node:test";
import { pubkeyOf } from "../src/nostr.js";
import { open, seal } from "../src/control-crypto.js";

test("control spike ciphertext round-trips only with the original agent and request AAD", () => {
  const sender = "01".padStart(64, "0");
  const recipient = "02".padStart(64, "0");
  const context = { agentPubkey: pubkeyOf("03".padStart(64, "0")), requestId: "deploy-1" };
  const payload = '{"op":"deploy","fixture":true}';
  const purpose = "yewholt-control-spike-v1";
  const content = seal(payload, sender, pubkeyOf(recipient), context, purpose);
  assert.equal(open(content, recipient, pubkeyOf(sender), context, purpose), payload);
  assert.throws(() => open(content, recipient, pubkeyOf(sender), { ...context, requestId: "deploy-2" }, purpose));
  assert.throws(() => open(content, recipient, pubkeyOf(sender), { ...context, agentPubkey: pubkeyOf(sender) }, purpose));
});
