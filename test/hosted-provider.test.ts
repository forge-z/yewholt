import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { bridge } from "../provider/bridge.js";
import { ProviderSecrets } from "../provider/secrets.js";
import { targetFile } from "../provider/target.js";
import { listAgents } from "../src/agents.js";
import { writePrivateJson } from "../src/control-files.js";
import { controlEvent, decryptControl, verifiedEnvelope, type Confirmation } from "../src/control-protocol.js";
import { DeployControl } from "../src/deploy-control.js";
import { WorkspaceIsolation } from "../src/isolation.js";
import { generateKeyPair, ownerAuthTag, verifyAuthSignature, verifyEvent, type NostrEvent } from "../src/nostr.js";
import { addPairing } from "../src/pairing.js";
import { Yewholt } from "../src/session.js";

test("the hosted bridge provisions, edits model and profile in place, and tombstones the agent on removal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yewholt-hosted-"));
  const home = join(root, "daemon");
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
  const selectedModel = "faux/openai/gpt-4o-mini", updatedModel = "faux/other";
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
  let lastModelEvent: NostrEvent | undefined;
  const faux = fauxProvider({ provider: "faux", models: [{ id: "openai/gpt-4o-mini" }, { id: "other" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const isolation = new WorkspaceIsolation(home, { YEWHOLT_UNSAFE_SHARED_USER: "1", YEWHOLT_WORKSPACES: join(root, "workspaces") });
  const session = await Yewholt.open(new MemoryStorage(), { home, models, isolation, piDir: join(home, "pi") });
  t.after(() => session.close());
  const reconcile = () => {
    const scan = listAgents(home, defaults);
    scan.definitions = scan.definitions.filter((agent) => control().reconcileHosted(agent));
    return session.reconcileAgents(scan);
  };
  const effects = {
    models: () => catalog,
    hasModel: (choice: typeof defaults.model) => available && session.hasModel(choice),
    publishProfile: async (_agent: unknown, event: NostrEvent) => { profiles.push(event); },
    updateName: async (_pubkey: string, name: string) => { names.push(name); },
    reconcileRemoval: async () => { removals++; },
    reconcileModel: reconcile,
  };
  const catalog = [...Array.from({ length: 600 }, (_, i) => "test/provider-model-" + i + "-".repeat(40)), selectedModel, updatedModel];
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
    else if (JSON.parse(event.content).type === "hosted-model") lastModelEvent = event;
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
    provider: "faux", modelId: "openai/gpt-4o-mini", label: selectedModel,
  });
  assert.ok(!readFileSync(binding, "utf8").includes(nsec));

  await reconcile();
  const bot = async () => (await session.snapshot()).bots.find((bot) => bot.pubkey === pubkey)!;
  const say = (eventId: string, text: string) =>
    session.handleHuman({ eventId, text, authorPubkey: owner.pubkey, channelId: "dm", createdAt: Date.now() / 1000 });
  session.setMemberChannels(pubkey, ["dm"], ["dm"]);
  const turns: { model: string; history: string }[] = [];
  const reply: Parameters<typeof faux.appendResponses>[0][number] = (context, _options, _state, model) => {
    turns.push({ model: model.id, history: JSON.stringify(context.messages) });
    return fauxAssistantMessage("Reply from " + model.id);
  };
  faux.setResponses([reply, reply]);
  await say("first", "Remember the blue wrench.");
  const workspaceFile = join(isolation.workspace(pubkey), "wrench.txt");
  writeFileSync(workspaceFile, "blue");
  const before = await bot();
  assert.ok(before.spentTokens > 0);
  const modelRequest = { pubkey, community, op: "model" };
  assert.deepEqual(await bridge(modelRequest, send), { ok: true, models: catalog, model: selectedModel });
  assert.equal((await bridge({ ...modelRequest, community: "wss://elsewhere.example", model: updatedModel }, send)).ok, false);
  assert.deepEqual(await bridge({ ...modelRequest, model: "faux/not-in-catalog" }, send), {
    ok: false, error: "The selected model is no longer available on the daemon.",
  });
  const intruder = generateKeyPair();
  const controlBody = { community, owner: owner.pubkey, authTag: auth };
  const change = (secret: string, body: unknown, issuedAt = Date.now()) =>
    controlEvent(secret, daemon.pubkey, "hosted-model", { requestId: randomUUID(), agentPubkey: pubkey }, body, issuedAt);
  addPairing(home, intruder.pubkey, "Other Mac", Date.now());
  assert.equal((await deliver(change(intruder.secret, { ...controlBody, model: updatedModel }), intruder.secret)).error,
    "hosted agent belongs to another provider or owner");
  assert.equal((await deliver(change(provider, {
    ...controlBody, owner: intruder.pubkey, authTag: ownerAuthTag(intruder.secret, pubkey), model: updatedModel,
  }))).error, "hosted agent belongs to another provider or owner");
  assert.deepEqual(await bot(), before);
  assert.deepEqual(await bridge({ ...modelRequest, model: updatedModel }, send), { ok: true, model: updatedModel });
  const edit = lastModelEvent!;
  const edited = await bot();
  assert.deepEqual(edited, { ...before, provider: "faux", modelId: "other", modelLabel: updatedModel });
  assert.equal(readFileSync(workspaceFile, "utf8"), "blue");
  await say("second", "What tool did I mention?");
  assert.deepEqual(turns.map(({ model }) => model), ["openai/gpt-4o-mini", "other"]);
  assert.match(turns[1]!.history, /Remember the blue wrench/);
  assert.match(turns[1]!.history, /Reply from openai\/gpt-4o-mini/);
  assert.deepEqual(await bridge(modelRequest, send), { ok: true, models: catalog, model: updatedModel });
  await say("stop", "!shutdown");
  const stopped = await bot();
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(await bridge({ ...modelRequest, model: selectedModel }, send), { ok: true, model: selectedModel });
  assert.deepEqual(await bot(), { ...stopped, modelId: "openai/gpt-4o-mini", modelLabel: selectedModel });
  assert.equal((await deliver(edit)).error, "stale hosted model update");
  assert.deepEqual(await bridge(modelRequest, send), { ok: true, models: catalog, model: selectedModel });
  assert.equal(profiles.length, 1, "a model change does not republish the identity");

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
  assert.equal((await deliver(edit)).error, "hosted agent was removed");
  assert.equal(existsSync(file), false);
});
