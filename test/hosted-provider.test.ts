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
import type { RelayWait } from "../provider/relay.js";
import { ProviderSecrets } from "../provider/secrets.js";
import { targetFile } from "../provider/target.js";
import { listAgents } from "../src/agents.js";
import { writePrivateJson } from "../src/control-files.js";
import { controlEvent, decryptControl, verifiedEnvelope, type Confirmation } from "../src/control-protocol.js";
import { DeployControl } from "../src/deploy-control.js";
import { WorkspaceIsolation } from "../src/isolation.js";
import { generateKeyPair, ownerAuthTag, pubkeyOf, verifyAuthSignature, verifyEvent, type NostrEvent } from "../src/nostr.js";
import { addPairing } from "../src/pairing.js";
import { writePairingOffer } from "../src/pairing-offer.js";
import { Yewholt } from "../src/session.js";

test("model lookup distinguishes a missing target, no reply, relay refusal and a closed pairing offer", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yewholt-model-lookup-"));
  const old = { ...process.env };
  process.env.YEWHOLT_PROVIDER_HOME = join(root, "provider");
  process.env.YEWHOLT_PROVIDER_FILE_STORAGE = "1";
  t.after(() => {
    for (const key of ["YEWHOLT_PROVIDER_HOME", "YEWHOLT_PROVIDER_FILE_STORAGE"]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  const daemon = generateKeyPair(), owner = generateKeyPair();
  const community = "wss://community.example";
  const home = join(root, "daemon");
  const target = "build-vm";
  const request = { op: "models", target, community };
  const expectFailure = async (message: RegExp, wait?: RelayWait) => {
    const result = await bridge(request, wait);
    assert.equal(result.ok, false);
    assert.match(result.error, message);
  };
  assert.deepEqual(await bridge(request), { ok: false, code: "target_missing",
    error: "This Yewholt target no longer exists. Reopen the target list to refresh it, then select a current machine." });
  writePrivateJson(targetFile(target), { id: target, label: target, transport: "relay", relay: community, daemonPubkey: daemon.pubkey });
  await expectFailure(/No model reply.*online/, async () => "timeout");
  await expectFailure(/relay refused/, async () => "refused");
  await expectFailure(/Could not send the model request/, async () => { throw Error("disconnected"); });
  const control = new DeployControl(home, daemon.secret, { relayUrl: community,
    model: { provider: "", modelId: "", label: "unset" } }, undefined, { primaryRelay: community });
  const send: RelayWait = async (_target, secret, event, _request, _agent, _timeout, onConfirmation) => {
    const reply = await control.handle(event, async () => false, { models: async () => ["test/offline"],
      publishProfile: async () => {}, updateName: async () => {}, reconcileRemoval: async () => {} });
    assert.ok(reply);
    const envelope = verifiedEnvelope(reply, pubkeyOf(secret), "confirmation");
    assert.ok(envelope);
    const body = decryptControl(envelope, secret, daemon.pubkey) as Confirmation;
    onConfirmation?.(body);
    return body.ok ? "confirmed" : "refused";
  };
  await expectFailure(/not paired.*yh join --daemon/, send);
  writePairingOffer(home, "invite", community, target, Date.now() - 1000, owner.pubkey);
  assert.deepEqual(await bridge(request, send), { ok: true, models: ["test/offline"] });
});

test("the Buzz picker drops a cached target when the bridge says its file is missing", async () => {
  const { apply } = await import(new URL("../../buzz-plugin/plugin.js", import.meta.url).href);
  const state: unknown[] = [];
  const effects: (() => void)[] = [];
  let cursor = 0;
  let picker!: (props: { config: { target: string }; onChange: () => void }) => unknown;
  apply({
    agents: { registerTab() {}, register({ CreateConfiguration }: { CreateConfiguration: typeof picker }) { picker = CreateConfiguration; } },
    effect() {},
    relay: { selected: () => "https://community.example" },
    host: { async spawn(_kind: string, { onStdout }: { onStdout: (output: string) => void }) {
      return { async end(input: string) {
        onStdout(JSON.stringify(JSON.parse(input).op === "targets"
          ? { ok: true, targets: ["stale", "live"], relays: { stale: "wss://community.example", live: "wss://community.example" } }
          : { ok: false, code: "target_missing", error: "Reopen the target list." }));
      }, async kill() {}, exited: Promise.resolve(0) };
    } },
    react: {
      createElement: (...parts: unknown[]) => parts,
      useEffect: (effect: () => void) => effects.push(effect),
      useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], (next: unknown) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
      },
      useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
    },
  });
  const render = () => {
    cursor = 0;
    effects.length = 0;
    return JSON.stringify(picker({ config: { target: "stale" }, onChange() {} }));
  };
  render();
  effects[0]();
  await new Promise(setImmediate);
  assert.match(render(), /"value":"stale"/);
  effects[1]();
  await new Promise(setImmediate);
  const updated = render();
  assert.doesNotMatch(updated, /"value":"stale"/);
  assert.match(updated, /"value":"live"/);
  assert.match(updated, /Reopen the target list/);
});

test("two targets provision independent agents in the same Buzz community", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yewholt-shared-community-"));
  const old = { ...process.env };
  process.env.YEWHOLT_PROVIDER_HOME = join(root, "provider");
  process.env.YEWHOLT_PROVIDER_FILE_STORAGE = "1";
  t.after(() => {
    for (const key of ["YEWHOLT_PROVIDER_HOME", "YEWHOLT_PROVIDER_FILE_STORAGE"]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  const primary = "wss://instabox.example";
  const community = "wss://forge.example";
  const owner = generateKeyPair();
  const provider = new ProviderSecrets().identity();
  const targets = new Map(["instabox", "mac"].map((id) => [id, generateKeyPair()]));
  for (const [id, daemon] of targets) {
    writePrivateJson(targetFile(id), { id, label: id, transport: "relay", relay: id === "instabox" ? primary : community,
      ...(id === "instabox" && { relays: [community] }), daemonPubkey: daemon.pubkey });
  }
  assert.deepEqual(await bridge({ op: "targets", details: true }, undefined, async () => []), {
    ok: true, targets: ["instabox", "mac"], relays: { instabox: [primary, community], mac: community },
  });
  const agents = new Set<string>();
  for (const [id, daemon] of targets) {
    const home = join(root, id);
    const primaryRelay = id === "instabox" ? primary : community;
    const model = { provider: "test", modelId: "offline", label: "Offline" };
    const control = new DeployControl(home, daemon.secret, { relayUrl: community, model }, undefined, { primaryRelay });
    addPairing(home, pubkeyOf(provider), id, undefined, id === "instabox" ? community : undefined);
    const send: RelayWait = async (target, secret, event, _request, _agent, _timeout, onConfirmation) => {
      assert.equal(target.relay, community);
      assert.equal(target.daemonPubkey, daemon.pubkey);
      const reply = await control.handle(event, async () => false, {
        models: () => ["test/offline"],
        publishProfile: async (agent) => { assert.equal(agent.relayUrl, community); },
        updateName: async () => {},
        reconcileRemoval: async () => {},
      });
      const envelope = verifiedEnvelope(reply!, event.pubkey, "confirmation")!;
      const body = decryptControl(envelope, secret, daemon.pubkey) as Confirmation;
      onConfirmation?.(body);
      return body.ok ? "confirmed" : "refused";
    };
    assert.deepEqual(await bridge({ op: "models", target: id, community }, send), { ok: true, models: ["test/offline"] });
    const reserved = await bridge({ op: "provision", target: id, name: "Same name", community });
    assert.ok("pubkey" in reserved && typeof reserved.pubkey === "string");
    agents.add(reserved.pubkey);
    assert.equal((await bridge({ op: "activate", community, pubkey: reserved.pubkey,
      auth: ownerAuthTag(owner.secret, reserved.pubkey) }, send)).ok, true);
    assert.equal(listAgents(home, { relayUrl: primaryRelay, model }).definitions[0]?.relayUrl, community);
  }
  assert.equal(agents.size, 2);
});

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
  const wakeUrl = "https://wake.example.test/";
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
  assert.deepEqual(await bridge({ op: "targets", details: true }, undefined, async () => []), {
    ok: true, targets: ["instabox"], relays: { instabox: community },
  });
  writePrivateJson(targetFile("instabox"), { ...target, relay: "wss://INSTABOX.example.test.:443/", wake: { kind: "url", url: wakeUrl } });
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
  process.env.PI_CODING_AGENT_DIR = join(home, "pi");
  const session = await Yewholt.open(new MemoryStorage(), { home, models, isolation });
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
  let sleeping = false;
  let wakeCalls = 0;
  const pendingReads: { id: string; event: NostrEvent; timeout: number }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, wakeUrl);
    assert.equal(sleeping, true);
    wakeCalls++;
    sleeping = false;
    return new Response(null, { status: 204 });
  });
  const send = async (_target: unknown, secret: string, event: NostrEvent, id: string, _agent: string, timeout: number,
    onConfirmation?: (body: Record<string, unknown>) => void) => {
    const { type } = JSON.parse(event.content);
    if (sleeping || pendingReads.length === 1) pendingReads.push({ id, event, timeout });
    if (sleeping) return "timeout" as const;
    if (type === "hosted-activate") activation ??= event;
    else if (type === "hosted-models") modelPages++;
    else if (type === "hosted-model") lastModelEvent = event;
    const confirmation = await deliver(event, secret);
    onConfirmation?.(confirmation);
    return confirmation.ok ? "confirmed" as const : "refused" as const;
  };
  const auth = ownerAuthTag(owner.secret, pubkey);
  const request = { pubkey, community, auth };
  assert.equal((await bridge({ ...request, op: "activate" }, send)).ok, false);
  assert.equal((await bridge({ op: "models", target: "instabox" }, send)).ok, false);
  assert.equal(wakeCalls, 0, "no wake after a refusal");
  const providerPubkey = activation!.pubkey;
  addPairing(home, providerPubkey, "Mac", Date.now());
  const assertWakeRetry = (type: string) => {
    assert.equal(pendingReads.length, 2);
    const [initial, retry] = pendingReads.splice(0);
    assert.deepEqual([initial.timeout, retry.timeout], [5_000, 30_000]);
    assert.notEqual(initial.id, retry.id);
    assert.notEqual(initial.event.id, retry.event.id);
    assert.equal(JSON.parse(initial.event.content).type, type);
    assert.equal(JSON.parse(retry.event.content).type, type);
  };
  sleeping = true;
  assert.deepEqual(await bridge({ op: "models", target: "instabox" }, send), { ok: true, models: catalog });
  assertWakeRetry("hosted-models");
  assert.equal(wakeCalls, 1);
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
  sleeping = true;
  assert.deepEqual(await bridge(modelRequest, send), { ok: true, models: catalog, model: selectedModel });
  assertWakeRetry("hosted-model");
  assert.equal(wakeCalls, 2);
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

test("each target list looks for owner offers in the open community, or in the targets' relays when Buzz sends none", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "yewholt-offer-discovery-"));
  const old = { ...process.env };
  process.env.YEWHOLT_PROVIDER_HOME = join(root, "provider");
  process.env.YEWHOLT_PROVIDER_FILE_STORAGE = "1";
  t.after(() => {
    for (const key of ["YEWHOLT_PROVIDER_HOME", "YEWHOLT_PROVIDER_FILE_STORAGE"]) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  const searched: string[][] = [];
  const published: string[] = [];
  const discover = async (community: string) => {
    searched.at(-1)!.push(community);
    if (community === "wss://forge.example") {
      writePrivateJson(targetFile("vm"), { id: "vm", label: "vm", transport: "relay", relay: community,
        daemonPubkey: generateKeyPair().pubkey });
      return ["vm"];
    }
    return [];
  };
  const list = async (input: Record<string, unknown>) => {
    searched.push([]);
    return bridge({ op: "targets", ...input }, undefined, discover, async (relay) => { published.push(relay); });
  };
  assert.deepEqual(await list({}), { ok: true, targets: [] });
  assert.deepEqual(searched.at(-1), []);
  assert.deepEqual(await list({ community: "https://forge.example" }), { ok: true, targets: ["vm"] });
  assert.deepEqual(searched.at(-1), ["wss://forge.example"]);
  writePrivateJson(targetFile("mac"), { id: "mac", label: "mac", transport: "relay", relay: "wss://other.example",
    relays: ["wss://forge.example/"], daemonPubkey: generateKeyPair().pubkey });
  assert.deepEqual(await list({}), { ok: true, targets: ["mac", "vm"] });
  assert.deepEqual(searched.at(-1)!.sort(), ["wss://forge.example/", "wss://other.example"]);
  assert.deepEqual(published, ["wss://forge.example"]);
});
