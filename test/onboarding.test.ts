import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { ensureOwnerKey, Yewholt, type HumanMessage } from "../src/session.js";
import { botKeyPath } from "../src/paths.js";
import { parseCommand } from "../src/parser.js";

const channel = "11111111-1111-4111-8111-111111111111";

test("parser reads the Portuguese create example", () => {
  const parsed = parseCommand("crie um novo bot e coloque o GPT-6.2 Astra como modelo");
  assert.equal(parsed?.type, "create");
  if (parsed?.type === "create") assert.equal(parsed.modelLabel, "GPT-6.2 Astra");
});

test("chat approval creates a second durable session", async () => {
  const home = mkdtempSync(join(tmpdir(), "yewholt-onboard-"));
  ensureOwnerKey(home);
  const session = await Yewholt.open(new MemoryStorage(), { home, turnTokens: 1000, defaultLimit: 100_000 });
  try {
    await session.ensureOnboarding(channel);
    await say(session, "e1", "crie um novo bot e coloque o GPT-6.2 Astra como modelo");
    const proposed = await session.snapshot();
    assert.ok(proposed.pending);
    assert.match(proposed.pending.summary, /name: Novo bot/);
    assert.match(proposed.pending.summary, /model: GPT-6.2 Astra/);
    assert.match(proposed.pending.summary, new RegExp(channel));
    assert.match(proposed.pending.summary, /permissions: post, read/);
    assert.equal(proposed.bots.length, 1);

    await say(session, "e2", "approve");
    const created = await session.snapshot();
    assert.equal(created.pending, null);
    assert.equal(created.bots.length, 2);
    const bot = created.bots.find((item) => item.role === "member");
    assert.ok(bot);
    assert.equal(bot.modelLabel, "GPT-6.2 Astra");
    assert.equal(bot.provider, "openai");
    assert.equal(bot.modelId, "gpt-6.2-astra");
    assert.deepEqual(bot.scope, [channel]);
    assert.deepEqual(bot.permissions, ["post", "read"]);
    assert.ok(bot.conversationId);
    assert.notEqual(bot.conversationId, created.bots[0]?.conversationId);
    assert.equal(statSync(botKeyPath(home, bot.pubkey)).mode & 0o777, 0o600);
    const kinds = created.outbox.map((event) => event.kind).sort((a, b) => a - b);
    assert.ok(kinds.includes(0));
    assert.ok(kinds.includes(9));
    assert.ok(kinds.includes(9000));
    assert.ok(kinds.includes(9030));
    assert.ok(kinds.includes(30175));
    assert.ok(kinds.includes(30177));

    await say(session, "e3", "change model of Novo bot to anthropic/claude-sonnet-5");
    assert.match((await session.snapshot()).pending?.summary ?? "", /claude-sonnet-5/);
    await say(session, "e4", "sim");
    const updated = (await session.snapshot()).bots.find((item) => item.name === "Novo bot");
    assert.equal(updated?.modelId, "claude-sonnet-5");
    assert.equal(updated?.provider, "anthropic");

    await say(session, "e5", "stop bot Novo bot");
    await say(session, "e6", "approve");
    assert.equal((await session.snapshot()).bots.find((item) => item.name === "Novo bot")?.status, "stopped");
  } finally {
    await session.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("per-session budget blocks work but still allows approval", async () => {
  const home = mkdtempSync(join(tmpdir(), "yewholt-budget-"));
  ensureOwnerKey(home);
  const session = await Yewholt.open(new MemoryStorage(), { home, turnTokens: 1000, defaultLimit: 1000 });
  try {
    await session.ensureOnboarding(channel);
    await say(session, "b1", "create bot name: Alpha model: openai/gpt-6-sol scope: this permissions: post,read");
    const onboard = (await session.snapshot()).bots.find((bot) => bot.role === "onboarding");
    assert.equal(onboard?.spentTokens, 1000);
    await say(session, "b2", "create bot name: Beta model: openai/gpt-6-sol");
    const refused = await session.snapshot();
    assert.equal(refused.bots.length, 1);
    assert.equal(refused.pending?.name, "Alpha");
    const refusal = refused.outbox.find((event) => event.content.includes("Budget exhausted"));
    assert.ok(refusal);
    await say(session, "b3", "approve");
    assert.equal((await session.snapshot()).bots.length, 2);
  } finally {
    await session.close();
    rmSync(home, { recursive: true, force: true });
  }
});

async function say(session: Yewholt, eventId: string, text: string): Promise<void> {
  const message: HumanMessage = {
    channelId: channel,
    authorPubkey: "ab".repeat(32),
    eventId,
    text,
    createdAt: 1_700_000_000 + eventId.length,
  };
  await session.handleHuman(message);
}
