import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  UsageDoc,
  type ConversationId,
  type Storage,
} from "@earendil-works/pi-durable";
import { catalogHas, defaultModel, loadModels, parseModelLabel, type ModelChoice } from "./models.js";
import { readKey, writeKey } from "./keys.js";
import { generateKeyPair, ownerAuthTag, pubkeyOf, signEvent, type NostrEvent } from "./nostr.js";
import { helpText, parseCommand, type ParsedCommand } from "./parser.js";
import { botKeyPath, ownerKeyPath } from "./paths.js";
import { RegistryDoc, type BotRecord, type Proposal, type RegistryState } from "./registry.js";

const ctx: Context = BACKGROUND_CONTEXT;
const PROCESSED_CAP = 400;

export type HumanMessage = {
  channelId: string;
  authorPubkey: string;
  eventId: string;
  text: string;
  createdAt: number;
};

export type SessionOptions = {
  home: string;
  turnTokens?: number;
  defaultLimit?: number;
  models?: Models;
};

export class Yewholt {
  private constructor(
    readonly harness: Harness,
    private readonly options: Required<Pick<SessionOptions, "home" | "turnTokens" | "defaultLimit">> & { models: Models },
  ) {}

  static async open(storage: Storage, options: SessionOptions): Promise<Yewholt> {
    const models = options.models ?? loadModels();
    const registry = createRegistry();
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        identity: { attribution: { name: "Yewholt", url: "https://github.com/forge-z/yewholt" } },
      },
      ctx,
    );
    return new Yewholt(harness, {
      home: options.home,
      turnTokens: options.turnTokens ?? Number(process.env.YEWHOLT_TURN_TOKENS ?? "1000"),
      defaultLimit: options.defaultLimit ?? Number(process.env.YEWHOLT_BUDGET_TOKENS ?? "100000"),
      models,
    });
  }

  async close(): Promise<void> {
    await this.harness.close(ctx);
  }

  async snapshot(): Promise<RegistryState> {
    return (await this.harness.snapshot(RegistryDoc, ctx)) ?? { bots: [], pending: null, processed: [], outbox: [], highWater: 0 };
  }

  /** First bot. Idempotent. Does not publish until the daemon drains the outbox. */
  async ensureOnboarding(channelId: string): Promise<BotRecord> {
    const state = await this.snapshot();
    const existing = state.bots.find((bot) => bot.role === "onboarding");
    if (existing) {
      if (!existing.scope.includes(channelId)) {
        await this.harness.commit(async (tx) => {
          const reg = await tx.doc(RegistryDoc);
          const bot = reg.bots.find((item) => item.role === "onboarding");
          if (bot && !bot.scope.includes(channelId)) bot.scope = [...bot.scope, channelId];
        }, ctx);
      }
      return (await this.snapshot()).bots.find((bot) => bot.role === "onboarding")!;
    }
    const fallback = defaultModel();
    const bot = await this.createBot({
      name: "Onboarding Specialist",
      role: "onboarding",
      model: fallback ?? { provider: "", modelId: "", label: "unset" },
      scope: [channelId],
      permissions: ["post", "read"],
      channelId,
    });
    return bot;
  }

  async handleHuman(message: HumanMessage): Promise<void> {
    const state = await this.snapshot();
    if (state.processed.includes(message.eventId)) return;
    if (state.bots.some((bot) => bot.pubkey === message.authorPubkey)) return;

    const onboarding = state.bots.find((bot) => bot.role === "onboarding" && bot.status === "active" && bot.scope.includes(message.channelId));
    const command = parseCommand(message.text);
    if (onboarding && (command || messageMentions(message.text, onboarding))) {
      await this.handleOnboarding(onboarding, message, command);
      return;
    }
    if (command) return;

    const mentioned = state.bots.filter(
      (bot) => bot.role !== "onboarding" && bot.status === "active" && bot.scope.includes(message.channelId) && messageMentions(message.text, bot),
    );
    for (const bot of mentioned) await this.handleMember(bot, message);
  }

  async ackOutbox(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      reg.outbox = reg.outbox.filter((event) => !drop.has(event.id));
    }, ctx);
  }

  async setBudget(name: string, limitTokens: number): Promise<void> {
    if (!Number.isInteger(limitTokens) || limitTokens < 1) throw new Error("budget must be a positive integer");
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      const bot = reg.bots.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (!bot) throw new Error(`no bot named ${name}`);
      bot.limitTokens = limitTokens;
    }, ctx);
  }

  private async handleOnboarding(bot: BotRecord, message: HumanMessage, command: ParsedCommand | null): Promise<void> {
    const ownerSecret = readKey(ownerKeyPath(this.options.home));
    if (!command) {
      await this.answerWithModel(bot, message);
      return;
    }
    if (command.type === "help") {
      await this.reply(bot, message, helpText(), 0, ownerSecret);
      return;
    }
    if (command.type === "approve" || command.type === "reject") {
      await this.resolveProposal(bot, message, command.type === "approve", ownerSecret);
      return;
    }
    if (!(await this.canSpend(bot, this.options.turnTokens))) {
      await this.reply(bot, message, budgetText(bot), 0, ownerSecret);
      return;
    }
    const proposal = this.proposalFrom(command, message.channelId, await this.snapshot());
    if ("error" in proposal) {
      await this.reply(bot, message, proposal.error, this.options.turnTokens, ownerSecret);
      return;
    }
    const summary = this.chatEvent(bot, message.channelId, proposal.summary, ownerSecret);
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      reg.pending = proposal;
      charge(reg, bot.pubkey, this.options.turnTokens);
      remember(reg, message);
      reg.outbox.push(summary);
    }, ctx);
    await this.noteOnly(bot, message, proposal.summary);
  }

  private async resolveProposal(bot: BotRecord, message: HumanMessage, approve: boolean, ownerSecret: string): Promise<void> {
    const state = await this.snapshot();
    const pending = state.pending;
    if (!pending) {
      await this.reply(bot, message, "There is no pending proposal.", 0, ownerSecret);
      return;
    }
    if (!approve) {
      const text = `Rejected proposal ${pending.id}.`;
      const event = this.chatEvent(bot, message.channelId, text, ownerSecret);
      await this.harness.commit(async (tx) => {
        const reg = await tx.doc(RegistryDoc);
        reg.pending = null;
        remember(reg, message);
        reg.outbox.push(event);
      }, ctx);
      await this.noteOnly(bot, message, text);
      return;
    }
    if (pending.action === "create") {
      const created = await this.createBot({
        name: pending.name,
        role: "member",
        model: { provider: pending.provider, modelId: pending.modelId, label: pending.modelLabel },
        scope: pending.scope,
        permissions: pending.permissions,
        channelId: message.channelId,
      });
      await this.harness.commit(async (tx) => {
        const reg = await tx.doc(RegistryDoc);
        reg.pending = null;
        remember(reg, message);
      }, ctx);
      await this.reply(
        bot,
        message,
        `Approved proposal ${pending.id}. ${created.name} is in this channel.\npubkey: ${created.pubkey}\nmodel: ${created.modelLabel}\nscope: ${created.scope.join(", ")}\npermissions: ${created.permissions.join(", ")}`,
        0,
        ownerSecret,
        false,
      );
      return;
    }
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      const target = reg.bots.find((item) => item.name.toLowerCase() === pending.name.toLowerCase());
      if (!target) throw new Error(`bot ${pending.name} disappeared`);
      if (pending.action === "update-model") {
        target.modelLabel = pending.modelLabel;
        target.provider = pending.provider;
        target.modelId = pending.modelId;
      } else if (pending.action === "update-scope") {
        target.scope = [...pending.scope];
      } else if (pending.action === "update-permissions") {
        target.permissions = [...pending.permissions];
      } else if (pending.action === "stop") {
        target.status = "stopped";
      } else if (pending.action === "start") {
        target.status = "active";
      }
      reg.pending = null;
      remember(reg, message);
    }, ctx);
    const updated = (await this.snapshot()).bots.find((item) => item.name.toLowerCase() === pending.name.toLowerCase())!;
    if (pending.action === "update-model" && updated.provider && updated.modelId) {
      const conversation = await this.harness.conversation(asConversation(updated.conversationId), ctx);
      await conversation?.configure({ model: { provider: updated.provider, modelId: updated.modelId }, instructions: instructionsFor(updated) }, ctx);
    } else if (pending.action === "update-scope" || pending.action === "update-permissions") {
      const conversation = await this.harness.conversation(asConversation(updated.conversationId), ctx);
      await conversation?.configure({ instructions: instructionsFor(updated) }, ctx);
    }
    await this.reply(bot, message, `Approved proposal ${pending.id}.\n${describe(updated)}`, 0, ownerSecret, false);
  }

  private async handleMember(bot: BotRecord, message: HumanMessage): Promise<void> {
    const ownerSecret = readKey(ownerKeyPath(this.options.home));
    if (!bot.permissions.includes("post")) {
      await this.noteOnly(bot, message, "Permission post is off, so this session will not publish.");
      return;
    }
    if (!(await this.canSpend(bot, this.options.turnTokens))) {
      await this.reply(bot, message, budgetText(bot), 0, ownerSecret);
      return;
    }
    await this.answerWithModel(bot, message);
  }

  private async answerWithModel(bot: BotRecord, message: HumanMessage): Promise<void> {
    const ownerSecret = readKey(ownerKeyPath(this.options.home));
    const choice = { provider: bot.provider, modelId: bot.modelId, label: bot.modelLabel };
    if (!choice.provider || !choice.modelId || !catalogHas(this.options.models, choice)) {
      const text = bot.role === "onboarding"
        ? `${helpText()}\n\nThat message is not a command I handle offline. Set YEWHOLT_MODEL and a provider API key to answer free text.`
        : `${bot.name} is a durable session on ${choice.label || "an unset model"}. Free-text answers need a provider API key and a pi-ai catalog id (provider/modelId).`;
      await this.reply(bot, message, text, 0, ownerSecret);
      return;
    }
    if (!(await this.canSpend(bot, this.options.turnTokens))) {
      await this.reply(bot, message, budgetText(bot), 0, ownerSecret);
      return;
    }
    const conversation = await this.harness.conversation(asConversation(bot.conversationId), ctx);
    if (!conversation) {
      await this.reply(bot, message, "This session has no conversation.", 0, ownerSecret);
      return;
    }
    const before = tokensOf(await this.harness.snapshot(UsageDoc, conversation.id, ctx));
    const submission = await conversation.submit(
      { type: "input", content: message.text, requestId: `nostr:${message.eventId}:${bot.pubkey}` },
      ctx,
    );
    const settled = await submission.wait(ctx);
    const after = tokensOf(await this.harness.snapshot(UsageDoc, conversation.id, ctx));
    const spent = Math.max(this.options.turnTokens, after - before);
    let answer = "I could not answer that.";
    if (settled.status === "done" && settled.type === "input") {
      const entry = await conversation.commit((tx) => tx.entry(settled.answer), ctx);
      const content = entry?.model?.[0] && "content" in entry.model[0] ? entry.model[0].content : undefined;
      answer = textOf(content) || answer;
    }
    await this.reply(bot, message, answer, spent, ownerSecret);
  }

  private async createBot(input: {
    name: string;
    role: string;
    model: ModelChoice;
    scope: string[];
    permissions: string[];
    channelId: string;
  }): Promise<BotRecord> {
    const keys = generateKeyPair();
    writeKey(botKeyPath(this.options.home, keys.pubkey), keys.secret);
    const bot: BotRecord = {
      conversationId: 0,
      name: input.name,
      pubkey: keys.pubkey,
      modelLabel: input.model.label,
      provider: input.model.provider,
      modelId: input.model.modelId,
      scope: input.scope,
      permissions: input.permissions,
      status: "active",
      role: input.role,
      limitTokens: this.options.defaultLimit,
      spentTokens: 0,
      announced: true,
    };
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: agentChange(bot),
      },
      ctx,
    );
    bot.conversationId = conversation.id as unknown as number;
    const ownerSecret = readKey(ownerKeyPath(this.options.home));
    const events = buildIdentityEvents(ownerSecret, bot, input.channelId, keys.secret);
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      reg.bots.push({ ...bot });
      reg.outbox.push(...events);
    }, ctx);
    return bot;
  }

  private proposalFrom(command: ParsedCommand, channelId: string, state: RegistryState): Proposal | { error: string } {
    if (command.type === "create") {
      if (!command.modelLabel) return { error: "Name a model. Example: crie um novo bot e coloque o GPT-6.2 Astra como modelo" };
      const model = parseModelLabel(command.modelLabel);
      const name = uniqueName(command.name ?? "Novo bot", state.bots);
      const scope = resolveScope(command.scope, channelId);
      const permissions = command.permissions ?? ["post", "read"];
      return proposal("create", name, model, scope, permissions);
    }
    if (command.type === "update-model" || command.type === "update-scope" || command.type === "update-permissions" || command.type === "stop" || command.type === "start") {
      const target = state.bots.find((bot) => bot.name.toLowerCase() === command.name.toLowerCase());
      if (!target) return { error: `No bot named ${command.name}.` };
      if (target.role === "onboarding" && (command.type === "stop" || command.type === "start")) {
        return { error: "The Onboarding Specialist stays up so approvals have somewhere to land." };
      }
      if (command.type === "update-model") {
        const model = parseModelLabel(command.modelLabel);
        return proposal("update-model", target.name, model, target.scope, target.permissions);
      }
      if (command.type === "update-scope") {
        return proposal("update-scope", target.name, modelOf(target), resolveScope(command.scope, channelId), target.permissions);
      }
      if (command.type === "update-permissions") {
        return proposal("update-permissions", target.name, modelOf(target), target.scope, command.permissions);
      }
      if (command.type === "stop") return proposal("stop", target.name, modelOf(target), target.scope, target.permissions);
      return proposal("start", target.name, modelOf(target), target.scope, target.permissions);
    }
    return { error: helpText() };
  }

  private async canSpend(bot: BotRecord, cost: number): Promise<boolean> {
    const fresh = (await this.snapshot()).bots.find((item) => item.pubkey === bot.pubkey) ?? bot;
    return fresh.spentTokens + cost <= fresh.limitTokens;
  }

  private chatEvent(bot: BotRecord, channelId: string, text: string, ownerSecret: string): NostrEvent {
    const secret = readKey(botKeyPath(this.options.home, bot.pubkey));
    return signEvent(secret, 9, text, [["h", channelId], ownerAuthTag(ownerSecret, bot.pubkey, "kind=9")]);
  }

  private async reply(bot: BotRecord, message: HumanMessage, text: string, cost: number, ownerSecret: string, mark = true): Promise<void> {
    const fresh = (await this.snapshot()).bots.find((item) => item.pubkey === bot.pubkey) ?? bot;
    if (!fresh.permissions.includes("post")) {
      await this.noteOnly(fresh, message, text);
      return;
    }
    const event = this.chatEvent(fresh, message.channelId, text, ownerSecret);
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      if (cost > 0) charge(reg, fresh.pubkey, cost);
      if (mark) remember(reg, message);
      reg.outbox.push(event);
    }, ctx);
    await this.noteOnly(fresh, message, text);
  }

  private async noteOnly(bot: BotRecord, message: HumanMessage, text: string): Promise<void> {
    const conversation = await this.harness.conversation(asConversation(bot.conversationId), ctx);
    if (!conversation) return;
    await conversation.submit(
      {
        type: "write",
        entry: {
          kind: "yewholt.chat",
          data: { author: message.authorPubkey, text: message.text, reply: text },
        },
      },
      ctx,
    );
  }
}

function asConversation(id: number): ConversationId {
  return id as unknown as ConversationId;
}

function agentChange(bot: BotRecord): { instructions: string; model?: { provider: string; modelId: string } } {
  const instructions = instructionsFor(bot);
  if (!bot.provider || !bot.modelId) return { instructions };
  return { instructions, model: { provider: bot.provider, modelId: bot.modelId } };
}

export function instructionsFor(bot: BotRecord): string {
  return [
    `You are ${bot.name}, a Yewholt bot in a Buzz channel.`,
    `Model: ${bot.modelLabel}.`,
    `Scope (channel ids): ${bot.scope.join(", ") || "none"}.`,
    `Permissions: ${bot.permissions.join(", ") || "none"}.`,
    "Stay inside that scope. post lets you publish in those channels. read lets the daemon show them to you.",
    "Do not invent extra permissions. Calendar, email, MCP, and repo access are out of scope.",
  ].join("\n");
}

function buildIdentityEvents(ownerSecret: string, bot: BotRecord, channelId: string, botSecret: string): NostrEvent[] {
  const profile = signEvent(
    botSecret,
    0,
    JSON.stringify({ name: bot.name, display_name: bot.name, about: "Yewholt bot" }),
    [ownerAuthTag(ownerSecret, bot.pubkey, "kind=0")],
  );
  const slug = personaSlug(bot.name, bot.pubkey);
  const persona = signEvent(
    ownerSecret,
    30175,
    JSON.stringify({
      display_name: bot.name,
      system_prompt: instructionsFor(bot),
      runtime: "yewholt",
      model: bot.modelId || null,
      provider: bot.provider || null,
    }),
    [
      ["d", slug],
      ["alt", "agent persona definition"],
    ],
  );
  const managed = signEvent(
    ownerSecret,
    30177,
    JSON.stringify({ name: bot.name, persona_id: slug, respond_to: "anyone" }),
    [
      ["d", bot.pubkey],
      ["alt", "managed agent"],
    ],
  );
  const relayMember = signEvent(ownerSecret, 9030, "", [
    ["p", bot.pubkey],
    ["role", "member"],
  ]);
  const channelMember = signEvent(ownerSecret, 9000, "", [
    ["h", channelId],
    ["p", bot.pubkey],
    ["role", "bot"],
  ]);
  return [profile, persona, managed, relayMember, channelMember];
}

function personaSlug(name: string, pubkey: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const slug = `${base || "bot"}-${pubkey.slice(0, 8)}`;
  return slug.slice(0, 64);
}

function proposal(action: string, name: string, model: ModelChoice, scope: string[], permissions: string[]): Proposal {
  const id = randomUUID().slice(0, 8);
  const summary = [
    `Proposal ${id} — ${action}`,
    `- name: ${name}`,
    `- model: ${model.label}`,
    `- scope: ${scope.join(", ")}`,
    `- permissions: ${permissions.join(", ")}`,
    `Reply "approve" to apply this proposal, or "reject" to discard it.`,
  ].join("\n");
  return {
    id,
    action,
    name,
    modelLabel: model.label,
    provider: model.provider,
    modelId: model.modelId,
    scope,
    permissions,
    summary,
  };
}

function modelOf(bot: BotRecord): ModelChoice {
  return { provider: bot.provider, modelId: bot.modelId, label: bot.modelLabel };
}

function resolveScope(raw: string | null, channelId: string): string[] {
  if (!raw || raw.toLowerCase() === "this") return [channelId];
  return raw
    .split(/[,\s]+/)
    .map((part) => (part.toLowerCase() === "this" ? channelId : part.trim()))
    .filter(Boolean);
}

function uniqueName(name: string, bots: readonly BotRecord[]): string {
  const taken = new Set(bots.map((bot) => bot.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let n = 2;
  while (taken.has(`${name} ${n}`.toLowerCase())) n += 1;
  return `${name} ${n}`;
}

function charge(reg: RegistryState, pubkey: string, cost: number): void {
  const bot = reg.bots.find((item) => item.pubkey === pubkey);
  if (bot) bot.spentTokens += cost;
}

function remember(reg: RegistryState, message: HumanMessage): void {
  if (!reg.processed.includes(message.eventId)) reg.processed.push(message.eventId);
  if (reg.processed.length > PROCESSED_CAP) reg.processed.splice(0, reg.processed.length - PROCESSED_CAP);
  if (message.createdAt > reg.highWater) reg.highWater = message.createdAt;
}

function budgetText(bot: BotRecord): string {
  return `Budget exhausted for ${bot.name}: ${bot.spentTokens}/${bot.limitTokens} tokens. Raise it with \`yewholt admin budget\` while the daemon is stopped. Approving the pending proposal still works.`;
}

function describe(bot: BotRecord): string {
  return [`name: ${bot.name}`, `model: ${bot.modelLabel}`, `scope: ${bot.scope.join(", ")}`, `permissions: ${bot.permissions.join(", ")}`, `status: ${bot.status}`, `budget: ${bot.spentTokens}/${bot.limitTokens}`].join("\n");
}

function messageMentions(text: string, bot: BotRecord): boolean {
  if (text.toLowerCase().includes(bot.pubkey)) return true;
  const name = bot.name.toLowerCase();
  return new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(text);
}

function tokensOf(state: { models: Record<string, { totalTokens?: number }>; tools: Record<string, { totalTokens?: number }> } | undefined): number {
  if (!state) return 0;
  return [...Object.values(state.models), ...Object.values(state.tools)].reduce((sum, usage) => sum + (usage.totalTokens ?? 0), 0);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function bindHome(home: string): void {
  mkdirSync(dirname(ownerKeyPath(home)), { recursive: true, mode: 0o700 });
}

export function ensureOwnerKey(home: string): string {
  bindHome(home);
  const path = ownerKeyPath(home);
  try {
    return pubkeyOf(readKey(path));
  } catch {
    const keys = writeKey(path);
    return keys.pubkey;
  }
}

export function chmodHome(home: string): void {
  chmodSync(home, 0o700);
  try {
    chmodSync(dirname(ownerKeyPath(home)), 0o700);
  } catch {
    // installed later
  }
}

