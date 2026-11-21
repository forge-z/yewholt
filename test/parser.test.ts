import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { parseCommand, stripLeadingMentions } from "../src/parser.js";
import { ensureOwnerKey, Yewholt, type HumanMessage } from "../src/session.js";

const channel = "22222222-2222-4222-8222-222222222222";
const MODEL = "opencode/deepseek-v4.1-flash";

function create(text: string): { name: string | null; modelLabel: string | null } {
  const parsed = parseCommand(text);
  assert.equal(parsed?.type, "create", text);
  if (parsed?.type !== "create") throw new Error("unreachable");
  return { name: parsed.name, modelLabel: parsed.modelLabel };
}

test("parser: verbatim Buzz messages name the bot and the model", () => {
  assert.deepEqual(create("@Onboarding Specialist crie um novo bot chamado Coder com o modelo opencode/deepseek-v4.1-flash"), { name: "Coder", modelLabel: MODEL });
  assert.deepEqual(create("crie um novo bot chamado Teste com o modelo opencode/deepseek-v4.1-flash"), { name: "Teste", modelLabel: MODEL });
});

test("parser: com modelo, usando o modelo, with model", () => {
  assert.deepEqual(create("crie um novo bot chamado Coder com modelo opencode/deepseek-v4.1-flash"), { name: "Coder", modelLabel: MODEL });
  assert.deepEqual(create("crie um novo bot chamado Coder usando o modelo opencode/deepseek-v4.1-flash"), { name: "Coder", modelLabel: MODEL });
  assert.deepEqual(create("create a bot named Coder with model opencode/deepseek-v4.1-flash"), { name: "Coder", modelLabel: MODEL });
  assert.deepEqual(create("crie um novo bot com o modelo GPT-6.2 Astra"), { name: null, modelLabel: "GPT-6.2 Astra" });
  assert.deepEqual(create("crie um novo bot chamado Coder com o modelo opencode/deepseek-v4.1-flash."), { name: "Coder", modelLabel: MODEL });
});

test("parser: coloque o X como modelo and name:/model: fields", () => {
  assert.deepEqual(create("crie um novo bot e coloque o opencode/deepseek-v4.1-flash como modelo"), { name: null, modelLabel: MODEL });
  assert.deepEqual(create("create bot name: Coder model: opencode/deepseek-v4.1-flash"), { name: "Coder", modelLabel: MODEL });
});

test("parser: every form that parsed before parses exactly as before", () => {
  // Outputs captured from parser.ts at b42dd2c before this change.
  const before: Array<[string, unknown]> = [
    ["crie um novo bot e coloque o GPT-6.2 Astra como modelo", { type: "create", name: null, modelLabel: "GPT-6.2 Astra", scope: null, permissions: null }],
    ["create bot name: Alpha model: openai/gpt-6-sol scope: this permissions: post,read", { type: "create", name: "Alpha", modelLabel: "openai/gpt-6-sol", scope: "this", permissions: ["post", "read"] }],
    ["create bot name: Beta model: openai/gpt-6-sol", { type: "create", name: "Beta", modelLabel: "openai/gpt-6-sol", scope: null, permissions: null }],
    ["change model of Alpha to anthropic/claude-sonnet-5", { type: "update-model", name: "Alpha", modelLabel: "anthropic/claude-sonnet-5" }],
    ["mude o modelo de Alpha para openai/gpt-6-sol", { type: "update-model", name: "Alpha", modelLabel: "openai/gpt-6-sol" }],
    ["change scope of Alpha to this", { type: "update-scope", name: "Alpha", scope: "this" }],
    ["mude o escopo de Alpha para this", { type: "update-scope", name: "Alpha", scope: "this" }],
    ["change permissions of Alpha to post,read", { type: "update-permissions", name: "Alpha", permissions: ["post", "read"] }],
    ["stop bot Alpha", { type: "stop", name: "Alpha" }],
    ["pare o bot Alpha", { type: "stop", name: "Alpha" }],
    ["start bot Alpha", { type: "start", name: "Alpha" }],
    ["inicie o bot Alpha", { type: "start", name: "Alpha" }],
    ["approve", { type: "approve" }],
    ["sim", { type: "approve" }],
    ["aprovo", { type: "approve" }],
    ["reject", { type: "reject" }],
    ["não", { type: "reject" }],
    ["help", { type: "help" }],
    ["ajuda", { type: "help" }],
    ["", { type: "help" }],
    ["crie um bot chamado Zeta e coloque o openai/gpt-6-sol como modelo", { type: "create", name: "Zeta", modelLabel: "openai/gpt-6-sol", scope: null, permissions: null }],
    ["create bot model openai/gpt-6-sol scope this", { type: "create", name: null, modelLabel: "openai/gpt-6-sol", scope: null, permissions: null }],
    ["create a bot named Alpha model openai/gpt-6-sol", { type: "create", name: "Alpha", modelLabel: "openai/gpt-6-sol", scope: null, permissions: null }],
    ["novo bot chamado Beta modelo: openai/x", { type: "create", name: "Beta", modelLabel: "openai/x", scope: null, permissions: null }],
    ["hello there", null],
    ["@Coder apenas responda ok", null],
  ];
  for (const [text, expected] of before) assert.deepEqual(parseCommand(text), expected, text);
});

test("leading mentions of known bots are stripped, names with spaces and extra spaces included", () => {
  const names = ["Onboarding Specialist", "Coder"];
  assert.deepEqual(stripLeadingMentions("@Onboarding Specialist aprovo", names), { text: "aprovo", mentioned: ["Onboarding Specialist"] });
  assert.deepEqual(stripLeadingMentions("@Onboarding Specialist  approve", names), { text: "approve", mentioned: ["Onboarding Specialist"] });
  assert.deepEqual(stripLeadingMentions("  @onboarding specialist, aprovo", names), { text: "aprovo", mentioned: ["Onboarding Specialist"] });
  assert.deepEqual(stripLeadingMentions("@Coder @Onboarding Specialist sim", names), { text: "sim", mentioned: ["Coder", "Onboarding Specialist"] });
  assert.deepEqual(stripLeadingMentions("aprovo", names), { text: "aprovo", mentioned: [] });
  // Unknown names and mid-sentence mentions are left alone.
  assert.deepEqual(stripLeadingMentions("@Someone aprovo", names), { text: "@Someone aprovo", mentioned: [] });
  assert.deepEqual(stripLeadingMentions("@Coderx aprovo", names), { text: "@Coderx aprovo", mentioned: [] });
  assert.deepEqual(stripLeadingMentions("ok @Coder", names), { text: "ok @Coder", mentioned: [] });
});

async function withSession(fn: (session: Yewholt, say: (id: string, text: string) => Promise<void>) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "yewholt-parser-"));
  ensureOwnerKey(home);
  const session = await Yewholt.open(new MemoryStorage(), { home, turnTokens: 1000, defaultLimit: 100_000, models: createModels() });
  try {
    await session.ensureOnboarding(channel);
    await fn(session, async (eventId, text) => {
      const message: HumanMessage = { channelId: channel, authorPubkey: "ab".repeat(32), eventId, text, createdAt: 1_800_000_000 };
      await session.handleHuman(message);
    });
  } finally {
    await session.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test("onboarding: '@Onboarding Specialist aprovo' approves the verbatim create request", async () => {
  await withSession(async (session, say) => {
    await say("m1", "@Onboarding Specialist crie um novo bot chamado Coder com o modelo opencode/deepseek-v4.1-flash");
    const pending = (await session.snapshot()).pending;
    assert.equal(pending?.name, "Coder");
    assert.equal(pending?.provider, "opencode");
    assert.equal(pending?.modelId, "deepseek-v4.1-flash");
    assert.match(pending?.summary ?? "", /model: opencode\/deepseek-v4\.1-flash/);
    await say("m2", "@Onboarding Specialist aprovo");
    const state = await session.snapshot();
    assert.equal(state.pending, null);
    assert.equal(state.bots.find((bot) => bot.name === "Coder")?.modelId, "deepseek-v4.1-flash");
  });
});

test("onboarding: '@Onboarding Specialist  approve' (two spaces) and bare 'aprovo' both approve", async () => {
  await withSession(async (session, say) => {
    await say("n1", "crie um novo bot chamado Teste com o modelo opencode/deepseek-v4.1-flash");
    assert.equal((await session.snapshot()).pending?.name, "Teste");
    await say("n2", "@Onboarding Specialist  approve");
    assert.equal((await session.snapshot()).pending, null);
    assert.ok((await session.snapshot()).bots.some((bot) => bot.name === "Teste"));

    await say("n3", "create bot name: Coder model: opencode/deepseek-v4.1-flash");
    assert.equal((await session.snapshot()).pending?.name, "Coder");
    await say("n4", "aprovo");
    assert.equal((await session.snapshot()).pending, null);
    assert.ok((await session.snapshot()).bots.some((bot) => bot.name === "Coder"));
  });
});

test("onboarding: a message that leads with another bot's mention is not an approval", async () => {
  await withSession(async (session, say) => {
    await say("o1", "crie um novo bot chamado Teste com o modelo opencode/deepseek-v4.1-flash");
    await say("o2", "approve");
    await say("o3", "crie um novo bot chamado Coder com o modelo opencode/deepseek-v4.1-flash");
    await say("o4", "@Teste sim, pode seguir");
    assert.equal((await session.snapshot()).pending?.name, "Coder");
  });
});

test("default model: a create without a model uses YEWHOLT_MODEL; without it the reply asks for one", async () => {
  const previous = process.env.YEWHOLT_MODEL;
  try {
    process.env.YEWHOLT_MODEL = MODEL;
    await withSession(async (session, say) => {
      await say("d1", "@Onboarding Specialist crie um novo bot chamado Teste");
      const pending = (await session.snapshot()).pending;
      assert.equal(pending?.name, "Teste");
      assert.equal(pending?.modelLabel, MODEL);
      assert.equal(pending?.provider, "opencode");
      assert.equal(pending?.modelId, "deepseek-v4.1-flash");
      assert.match(pending?.summary ?? "", /- model: opencode\/deepseek-v4\.1-flash/);
    });
    delete process.env.YEWHOLT_MODEL;
    await withSession(async (session, say) => {
      await say("d2", "crie um novo bot chamado Teste");
      const state = await session.snapshot();
      assert.equal(state.pending, null);
      assert.ok(state.outbox.some((event) => event.kind === 9 && event.content.startsWith("Name a model.")));
    });
  } finally {
    if (previous === undefined) delete process.env.YEWHOLT_MODEL;
    else process.env.YEWHOLT_MODEL = previous;
  }
});
