import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { listAgents } from "../src/agents.js";
import { controlEvent, decryptControl, verifiedEnvelope } from "../src/control-protocol.js";
import { DeployControl, lastDeploys } from "../src/deploy-control.js";
import { generateKeyPair, ownerAuthTag, signEvent, type NostrEvent } from "../src/nostr.js";
import { addPairing, listPairings, removePairing } from "../src/pairing.js";

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "yewholt-deploy-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const daemon = generateKeyPair();
  const provider = generateKeyPair();
  const agent = generateKeyPair();
  const defaults = { relayUrl: "ws://127.0.0.1:13000", model: { provider: "test", modelId: "offline", label: "test/offline" } };
  const provisioning = { name: "Control fixture", nsec: agent.secret, authTag: ownerAuthTag(daemon.secret, agent.pubkey) };
  const file = join(home, "agents", `${agent.pubkey}.json`);
  const ledger = join(home, "state", "control.json");
  let issuedAt = Date.now();
  const pairedAt = issuedAt;
  const control = () => new DeployControl(home, daemon.secret, defaults, () => issuedAt + 1000);
  const create = (data: unknown = provisioning, job = randomUUID(), signer = provider, at = ++issuedAt) =>
    controlEvent(signer.secret, daemon.pubkey, "deploy", { agentPubkey: agent.pubkey, requestId: job }, data, at);
  const result = async (event: NostrEvent, signer = provider, service = control()) => {
    const reply = await service.handle(event, async () => false);
    assert.ok(reply);
    assert.equal(reply.pubkey, daemon.pubkey);
    const envelope = verifiedEnvelope(reply, signer.pubkey, "confirmation");
    assert.ok(envelope);
    assert.equal(envelope.requestId, JSON.parse(event.content).requestId);
    assert.equal(envelope.agentPubkey, agent.pubkey);
    return decryptControl(envelope, signer.secret, daemon.pubkey);
  };
  const pair = () => addPairing(home, provider.pubkey, "Fixture provider", pairedAt);
  const expected = (event: NostrEvent, error?: string) => ({
    job: JSON.parse(event.content).requestId, agentPubkey: agent.pubkey, ok: !error, ...(error ? { error } : {}),
  });
  return { home, daemon, provider, agent, provisioning, file, ledger, create, result, pair, expected, control, pairedAt };
}

test("deploy control fails closed with an empty list, an unrelated key, a removed key, or an older pairing epoch", async (t) => {
  const f = fixture(t);
  const first = f.create();
  assert.deepEqual(await f.result(first), f.expected(first, "provider not paired"));
  assert.equal(existsSync(f.file), false);
  f.pair();
  assert.equal(listPairings(f.home).length, 1);
  const unrelated = generateKeyPair();
  const wrong = f.create(f.provisioning, randomUUID(), unrelated);
  assert.deepEqual(await f.result(wrong, unrelated), f.expected(wrong, "provider not paired"));
  assert.equal(existsSync(f.file), false);
  assert.equal(removePairing(f.home, f.provider.pubkey), true);
  assert.deepEqual(await f.result(first), f.expected(first, "provider not paired"));
  addPairing(f.home, f.provider.pubkey, "Re-paired", f.pairedAt + 5);
  assert.deepEqual(await f.result(first), f.expected(first, "deploy outside pairing window"));
  assert.equal(existsSync(f.file), false);
});

test("signed deploy envelopes bind the AAD and fail closed before provisioning", async (t) => {
  const f = fixture(t);
  f.pair();
  const valid = f.create();
  const original = verifiedEnvelope(valid, f.daemon.pubkey, "deploy");
  assert.ok(original);
  const changed = { ...original, requestId: randomUUID() };
  assert.throws(() => decryptControl(changed, f.daemon.secret, f.provider.pubkey));
  const invalidCipher = signEvent(f.provider.secret, valid.kind, JSON.stringify(changed), valid.tags, valid.created_at);
  assert.deepEqual(await f.result(invalidCipher), f.expected(invalidCipher, "invalid ciphertext"));
  assert.equal(await f.control().handle({ ...valid, sig: "0".repeat(128) }, async () => false), null);
  const foreign = controlEvent(f.provider.secret, generateKeyPair().pubkey, "deploy", original, f.provisioning);
  assert.equal(await f.control().handle(foreign, async () => false), null);
  assert.equal(existsSync(f.file), false);
});

test("jobs replay across restart without overwriting, identical payloads are no-ops, and newer payloads replace", async (t) => {
  const f = fixture(t);
  f.pair();
  const obsolete = f.create({ ...f.provisioning, name: "Stale fixture" });
  const first = f.create();
  assert.deepEqual(await f.result(first), f.expected(first));
  const original = statSync(f.file, { bigint: true });
  const appliedAt = lastDeploys(f.home).get(f.agent.pubkey);
  assert.ok(appliedAt);
  assert.equal(original.mode & 0o777n, 0o600n);

  const retry = f.create({ ...f.provisioning, name: "Ignored on the same job" }, JSON.parse(first.content).requestId);
  assert.deepEqual(await f.result(retry), f.expected(first));
  const duplicate = f.create();
  assert.deepEqual(await f.result(duplicate), f.expected(duplicate));
  assert.equal(statSync(f.file, { bigint: true }).ino, original.ino);
  assert.equal(lastDeploys(f.home).get(f.agent.pubkey), appliedAt);

  const replacement = f.create({ ...f.provisioning, name: "Replaced fixture" });
  assert.deepEqual(await f.result(replacement), f.expected(replacement));
  assert.notEqual(statSync(f.file, { bigint: true }).ino, original.ino);
  assert.deepEqual(await f.result(first), f.expected(first));
  assert.deepEqual(await f.result(obsolete), f.expected(obsolete, "stale deploy"));
  assert.equal(JSON.parse(readFileSync(f.file, "utf8")).name, "Replaced fixture");
});

test("provisioning errors and durable diagnostics do not copy secrets or unknown fields", async (t) => {
  const f = fixture(t);
  f.pair();
  const envValue = "sensitive-fixture-env-value";
  const invalid = f.create({ ...f.provisioning, name: f.agent.secret, env_vars: { TOKEN: envValue } });
  const failure = await f.result(invalid);
  assert.deepEqual(failure, f.expected(invalid, "invalid provisioning"));
  assert.equal(existsSync(f.file), false);

  const valid = f.create({ ...f.provisioning, env_vars: { TOKEN: envValue } });
  const success = await f.result(valid);
  assert.deepEqual(success, f.expected(valid));
  const provision = readFileSync(f.file, "utf8");
  assert.equal(JSON.parse(provision).nsec, f.agent.secret);
  assert.ok(!provision.includes(envValue));
  const diagnostics = JSON.stringify([failure, success, readFileSync(f.ledger, "utf8"), [...lastDeploys(f.home)]]);
  assert.ok(!diagnostics.includes(f.agent.secret));
  assert.ok(!diagnostics.includes(envValue));
});

test("a deploy without an explicit model remains compatible with the existing unset daemon default", async (t) => {
  const f = fixture(t);
  f.pair();
  const defaults = { relayUrl: "ws://127.0.0.1:13000", model: { provider: "", modelId: "", label: "unset" } };
  const service = new DeployControl(f.home, f.daemon.secret, defaults, () => f.pairedAt + 1000);
  const deploy = f.create();
  assert.deepEqual(await f.result(deploy, f.provider, service), f.expected(deploy));
  assert.equal(listAgents(f.home, defaults).definitions[0]?.model.label, "unset");
});

test("an interrupted install can be retried without permitting older replay", async (t) => {
  const f = fixture(t);
  f.pair();
  const earlier = f.create({ ...f.provisioning, name: "Earlier fixture" });
  const next = f.create();
  const directory = join(f.home, "agents");
  writeFileSync(directory, "", { mode: 0o600 });
  assert.deepEqual(await f.result(next), f.expected(next, "deploy could not be recorded"));
  rmSync(directory);
  mkdirSync(directory, { mode: 0o700 });
  assert.deepEqual(await f.result(earlier), f.expected(earlier, "stale deploy"));
  assert.equal(existsSync(f.file), false);
  assert.deepEqual(await f.result(next), f.expected(next));
  assert.equal(JSON.parse(readFileSync(f.file, "utf8")).name, f.provisioning.name);
});
