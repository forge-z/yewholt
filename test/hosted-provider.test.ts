import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bridge } from "../provider/bridge.js";
import { ProviderSecrets } from "../provider/secrets.js";
import { targetFile } from "../provider/target.js";
import { writePrivateJson } from "../src/control-files.js";
import { controlEvent, decryptControl, verifiedEnvelope, type Confirmation } from "../src/control-protocol.js";
import { DeployControl } from "../src/deploy-control.js";
import { generateKeyPair, ownerAuthTag, verifyAuthSignature, verifyEvent, type NostrEvent } from "../src/nostr.js";
import { addPairing } from "../src/pairing.js";

test("the hosted bridge reserves a public identity, attests and edits it, then wipes it and blocks both replay paths", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yewholt-hosted-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.mock.method(process, "emitWarning", () => {});
  const env = { ...process.env };
  process.env.YEWHOLT_PROVIDER_HOME = join(home, "provider");
  process.env.YEWHOLT_PROVIDER_FILE_STORAGE = "1";
  t.after(() => {
    for (const key of ["YEWHOLT_PROVIDER_HOME", "YEWHOLT_PROVIDER_FILE_STORAGE"]) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });
  const daemon = generateKeyPair(), owner = generateKeyPair();
  const provider = new ProviderSecrets().identity();
  const community = "wss://instabox.example.test";
  const defaults = { relayUrl: "ws://127.0.0.1:3000", model: { provider: "", modelId: "", label: "unset" } };
  const target = { id: "instabox", label: "Instabox", transport: "relay", relay: community, daemonPubkey: daemon.pubkey };
  writePrivateJson(targetFile("instabox"), target);
  const selectedModel = "openrouter/openai/gpt-4o-mini";
  const create = { op: "provision", target: "instabox", name: "First", community, code: true, model: selectedModel };
  assert.deepEqual(await bridge({ ...create, community: "wss://elsewhere.example" }), {
    ok: false,
    error: "Buzz is open to wss://elsewhere.example, but target instabox uses wss://instabox.example.test. Open the target relay as a Buzz community, then create the agent there.",
  });
  assert.equal((await bridge({ ...create, community: "ws://instabox.example.test" })).ok, false);
  assert.deepEqual(await bridge({ op: "targets", details: true }), {
    ok: true, targets: ["instabox"], relays: { instabox: community },
  });
  writePrivateJson(targetFile("instabox"), { ...target, relay: "wss://INSTABOX.example.test.:443/" });
  const reserved = await bridge(create);
  assert.ok("pubkey" in reserved && typeof reserved.pubkey === "string");
  assert.deepEqual(await bridge(create), reserved);
  const { pubkey } = reserved;
  const binding = join(process.env.YEWHOLT_PROVIDER_HOME, "hosted", "agents", pubkey + ".json");
  const file = join(home, "agents", pubkey + ".json");
  const nsec: string = JSON.parse(readFileSync(binding, "utf8")).secret;
  assert.ok(!JSON.stringify(reserved).includes(nsec));
  const profiles: NostrEvent[] = [];
  const names: string[] = [];
  let removals = 0;
  let activation: NostrEvent | undefined;
  const effects = {
    models: () => catalog,
    hasModel: ({ provider, modelId }: { provider: string; modelId: string }) =>
      available && `${provider}/${modelId}` === selectedModel,
    publishProfile: async (_agent: unknown, event: NostrEvent) => { profiles.push(event); },
    updateName: async (_pubkey: string, name: string) => { names.push(name); },
    reconcileRemoval: async () => { removals++; },
  };
  const catalog = [...Array.from({ length: 600 }, (_, i) => "test/provider-model-" + i + "-".repeat(40)), selectedModel];
  let available = false;
  const control = () => new DeployControl(home, daemon.secret, defaults);
  const deliver = async (event: NostrEvent, secret = provider): Promise<Confirmation> => {
    const reply = await control().handle(event, async () => false, effects);
    assert.ok(reply);
    const confirmed = verifiedEnvelope(reply, event.pubkey, "confirmation");
    assert.ok(confirmed);
    return decryptControl(confirmed, secret, daemon.pubkey) as Confirmation;
  };
  let modelPages = 0;
  const send = async (_target: unknown, secret: string, event: NostrEvent, _id: string, _agent: string, _ms: number,
    onConfirmation?: (body: Record<string, unknown>) => void) => {
    if (JSON.parse(event.content).type === "hosted-activate") activation ??= event;
    else if (JSON.parse(event.content).type === "hosted-models") modelPages++;
    const confirmation = await deliver(event, secret);
    onConfirmation?.(confirmation);
    return confirmation.ok ? "confirmed" as const : "refused" as const;
  };
  const auth = ownerAuthTag(owner.secret, pubkey);
  const request = { pubkey, community, auth };
  assert.equal((await bridge({ ...request, op: "activate" }, send)).ok, false);
  assert.equal((await bridge({ op: "models", target: "instabox" }, send)).ok, false);
  const providerPubkey = activation!.pubkey;
  addPairing(home, providerPubkey, "Mac", Date.now());
  assert.deepEqual(await bridge({ op: "models", target: "instabox" }, send), { ok: true, models: catalog });
  assert.ok(modelPages >= 3, "catalog traverses multiple authenticated pages");
  assert.equal((await bridge({ ...request, op: "activate" }, send)).ok, false);
  assert.equal(existsSync(file), false);
  available = true;
  assert.deepEqual(await bridge({ ...request, op: "activate" }, send), { ok: true });
  assert.deepEqual(await bridge({ ...request, op: "activate" }, send), { ok: true });
  assert.equal(profiles.length, 1);
  const stat = statSync(file, { bigint: true });
  assert.equal(stat.mode & 0o777n, 0o600n);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).permissions, ["post", "read", "code"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).model, {
    provider: "openrouter", modelId: "openai/gpt-4o-mini", label: selectedModel,
  });
  assert.ok(!readFileSync(binding, "utf8").includes(nsec));
  assert.deepEqual(await bridge({ ...request, op: "profile", name: "Renamed", picture: "https://example.test/photo" }, send), { ok: true });
  assert.deepEqual(names, ["First", "Renamed"]);
  assert.equal(statSync(file, { bigint: true }).mtimeNs, stat.mtimeNs);
  assert.equal(statSync(file, { bigint: true }).ino, stat.ino);
  assert.equal(profiles[1]!.kind, 0);
  assert.ok(verifyEvent(profiles[1]!));
  assert.equal(verifyAuthSignature(profiles[1]!.tags[0]!, pubkey), owner.pubkey);
  assert.deepEqual(JSON.parse(profiles[1]!.content), { name: "Renamed", display_name: "Renamed", picture: "https://example.test/photo" });

  assert.deepEqual(await bridge({ ...request, op: "remove" }, send), { ok: true });
  assert.deepEqual(await bridge({ ...request, op: "remove" }, send), { ok: true });
  assert.equal(removals, 1);
  assert.equal(existsSync(file), false);
  const after = Date.now() + 10;
  const replay = controlEvent(provider, daemon.pubkey, "hosted-activate", { requestId: randomUUID(), agentPubkey: pubkey },
    { ...request, authTag: auth, owner: owner.pubkey, name: "First", agent: { name: "First", authTag: auth, nsec } }, after);
  assert.equal((await deliver(replay)).error, "hosted agent was removed");
  const legacy = controlEvent(provider, daemon.pubkey, "deploy", { requestId: randomUUID(), agentPubkey: pubkey },
    { name: "First", authTag: auth, nsec }, after);
  assert.equal((await deliver(legacy)).error, "agent is managed by hosted control");
  assert.equal(existsSync(file), false);
});
