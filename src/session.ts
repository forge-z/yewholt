import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  UsageDoc,
  type Conversation,
  type ConversationId,
  type EnvTarget,
  type Extension,
  type Registry,
  type Storage,
  type TaskId,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { ApprovalDecision, createGateExtension, type ApprovalAsk } from "./coding.js";
import { loadPackages, piDir } from "./packages.js";
import { physicalPath, WorkspaceEnv, type Roots } from "./workspace.js";
import { WorkspaceIsolation } from "./isolation.js";
import { catalogHas, defaultModel, loadModels, parseModelLabel, type ModelChoice } from "./models.js";
import { readKey, writeKey } from "./keys.js";
import { generateKeyPair, ownerAuthTag, pubkeyOf, signEvent, type NostrEvent } from "./nostr.js";
import { effectiveScope } from "./membership.js";
import { helpText, parseCommand, stripLeadingMentions, type ParsedCommand } from "./parser.js";
import { botKeyPath, ownerKeyPath } from "./paths.js";
import { RegistryDoc, type ApprovalRequest, type BotRecord, type CodeTurn, type Proposal, type RegistryState } from "./registry.js";

const ctx: Context = BACKGROUND_CONTEXT;
const PROCESSED_CAP = 400;

export type HumanMessage = {
  channelId: string;
  authorPubkey: string;
  eventId: string;
  text: string;
  createdAt: number;
  /** Event ids this message replies to (its `e` tags), when it has any. */
  replyTo?: string[];
};

export type SessionOptions = {
  home: string;
  turnTokens?: number;
  defaultLimit?: number;
  models?: Models;
  isolation?: WorkspaceIsolation;
  /** Pi's settings folder for `pi.durable` packages (default `PI_CODING_AGENT_DIR` or ~/.pi/agent). */
  piDir?: string;
};

/** A bot that gets the coding runtime: stored permissions include `code`, and never the Onboarding Specialist. */
export function isCoder(bot: Pick<BotRecord, "role" | "permissions">): boolean {
  return bot.role !== "onboarding" && bot.permissions.includes("code");
}

/** What code bots run with, in selection order. Buzz's host.mjs installs the same base: CodingTools, tool search, packages. */
type Coding = {
  registry: Registry;
  toolSearch: Extension;
  gate: Extension;
  packages: Extension[];
  piDir: string;
  loading?: Promise<void>;
};

export class Yewholt {
  private readonly memberChannels = new Map<string, ReadonlySet<string>>();
  private outboxListener: (() => void) | undefined;

  private constructor(
    readonly harness: Harness,
    private readonly options: Required<Pick<SessionOptions, "home" | "turnTokens" | "defaultLimit">> & { models: Models },
    private readonly coding: Coding,
    private readonly isolation: WorkspaceIsolation,
  ) {}

  static async open(storage: Storage, options: SessionOptions): Promise<Yewholt> {
    const models = options.models ?? (await loadModels());
    const registry = createRegistry();
    // Installed for every process, selected only by code bots' conversations (settings.extensions
    // is empty, so nothing is selected by default, as before any extension existed).
    // The gate and env need the session, which needs the open Harness. Harness.open runs no task,
    // so they wait for it instead of deciding without it (a woken gate must not see "no workspace").
    let ready!: (session: Yewholt) => void;
    const opened = new Promise<Yewholt>((resolve) => (ready = resolve));
    const gate = createGateExtension({
      workspace: async (conversationId) => (await opened).toolWorkspace(conversationId),
      request: async (ask) => (await opened).requestApproval(ask),
      expire: async (taskId, key) => (await opened).dropApproval(taskId, key),
    });
    // Adapted from block/buzz-app src/bundled/pi/host.mjs (serve: install(CodingTools),
    // install(createToolSearchExtension()), then the packages' extensions), commit
    // 9657bb35451c99d3cf1687f1af9ca76fa7f001f0, Apache-2.0, see NOTICE. Yewholt adds its gate.
    const toolSearch = createToolSearchExtension();
    registry.install(CodingTools);
    registry.install(toolSearch);
    registry.install(gate);
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        identity: { attribution: { name: "Yewholt", url: "https://github.com/forge-z/yewholt" } },
        settings: { extensions: [] },
        env: async (target) => (await opened).envFor(target),
      },
      ctx,
    );
    const self = new Yewholt(
      harness,
      {
        home: options.home,
        turnTokens: options.turnTokens ?? Number(process.env.YEWHOLT_TURN_TOKENS ?? "1000"),
        defaultLimit: options.defaultLimit ?? Number(process.env.YEWHOLT_BUDGET_TOKENS ?? "100000"),
        models,
      },
      { registry, toolSearch, gate, packages: [], piDir: options.piDir ?? piDir() },
      options.isolation ?? new WorkspaceIsolation(options.home),
    );
    ready(self);
    return self;
  }

  isolationStatus(): string {
    return this.isolation.status();
  }

  /** Called after a commit that put events in the outbox outside a chat turn (approval requests, resumed turns). */
  setOutboxListener(listener: (() => void) | undefined): void {
    this.outboxListener = listener;
  }

  private notifyOutbox(): void {
    try {
      this.outboxListener?.();
    } catch (error) {
      console.error("outbox:", error instanceof Error ? error.message : error);
    }
  }

  /**
   * Re-attach to the chat turns of code bots that a previous process left unanswered: the same
   * request id finds the same durable submission (no second input), its run continues where it
   * stopped (a parked approval stays parked), and the reply is posted when it settles.
   */
  async resumeTurns(): Promise<void> {
    const state = await this.snapshot();
    if (state.bots.some(isCoder)) await this.ensurePackages();
    await Promise.all(
      (state.turns ?? []).map((turn) =>
        this.runTurn(turn).catch((error: unknown) => console.error(`resume turn ${turn.eventId}:`, error instanceof Error ? error.message : error)),
      ),
    );
  }

  /**
   * Channels the relay lists this bot in (trusted kind 39002, see membership.ts).
   * Kept in memory only: stored scope and proposals are not changed. The daemon
   * replaces the set whenever the relay's member lists change.
   */
  setMemberChannels(pubkey: string, channels: Iterable<string>): void {
    const set = new Set(channels);
    if (set.size === 0) this.memberChannels.delete(pubkey);
    else this.memberChannels.set(pubkey, set);
  }

  /** Stored scope ∪ relay membership, for the bot with this pubkey. */
  async effectiveScope(pubkey: string): Promise<string[]> {
    const bot = (await this.snapshot()).bots.find((item) => item.pubkey === pubkey);
    return effectiveScope(bot?.scope ?? [], this.memberChannels.get(pubkey));
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

    const inScope = (bot: BotRecord) => effectiveScope(bot.scope, this.memberChannels.get(bot.pubkey)).includes(message.channelId);
    const onboarding = state.bots.find((bot) => bot.role === "onboarding" && bot.status === "active" && inScope(bot));
    // "@Onboarding Specialist aprovo" parses as "aprovo". A message that leads with
    // other bots only ("@Coder sim") is addressed to them and parses as before.
    const leading = stripLeadingMentions(message.text, state.bots.map((bot) => bot.name));
    const forOnboarding = leading.mentioned.some((name) => state.bots.some((bot) => bot.role === "onboarding" && bot.name === name));
    const command = parseCommand(forOnboarding || leading.mentioned.length === 0 ? leading.text : message.text);
    if (await this.handleApprovalReply(state, message, leading, onboarding)) return;
    // The Onboarding Specialist listens to the whole channel in its stored scope (the
    // install channel). In a channel it only joined from the app it needs a mention.
    const listening = onboarding && (onboarding.scope.includes(message.channelId) ? command : command && forOnboarding);
    if (onboarding && (listening || messageMentions(message.text, onboarding))) {
      await this.handleOnboarding(onboarding, message, command);
      return;
    }
    if (command) return;

    const mentioned = state.bots.filter(
      (bot) => bot.role !== "onboarding" && bot.status === "active" && inScope(bot) && messageMentions(message.text, bot),
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
      await this.syncAgent(updated);
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
    // A package may add the provider this bot's model comes from.
    if (isCoder(bot)) await this.ensurePackages();
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
    if (isCoder(bot)) {
      await this.codeTurn(bot, message, conversation);
      return;
    }
    // Fail closed: a bot without code never keeps coding extensions selected.
    if ((await conversation.agent(ctx)).extensions.length > 0) {
      await conversation.configure({ extensions: null, cwd: null, instructions: instructionsFor(bot) }, ctx);
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
    if (isCoder(bot)) this.isolation.prepare(bot.pubkey);
    return bot;
  }

  private proposalFrom(command: ParsedCommand, channelId: string, state: RegistryState): Proposal | { error: string } {
    if (command.type === "create") {
      const model = command.modelLabel ? parseModelLabel(command.modelLabel) : defaultModel();
      if (!model) return { error: "Name a model. Example: crie um novo bot e coloque o GPT-6.2 Astra como modelo" };
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
        if (target.role === "onboarding" && command.permissions.includes("code")) {
          return { error: "The Onboarding Specialist never gets coding tools. Give code to another bot." };
        }
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

  private async reply(
    bot: BotRecord,
    message: HumanMessage,
    text: string,
    cost: number,
    ownerSecret: string,
    mark = true,
    also?: (reg: RegistryState) => void,
  ): Promise<void> {
    const fresh = (await this.snapshot()).bots.find((item) => item.pubkey === bot.pubkey) ?? bot;
    if (!fresh.permissions.includes("post")) {
      if (also) await this.harness.commit(async (tx) => also(await tx.doc(RegistryDoc)), ctx);
      await this.noteOnly(fresh, message, text);
      return;
    }
    const event = this.chatEvent(fresh, message.channelId, text, ownerSecret);
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      if (cost > 0) charge(reg, fresh.pubkey, cost);
      if (mark) remember(reg, message);
      reg.outbox.push(event);
      also?.(reg);
    }, ctx);
    await this.noteOnly(fresh, message, text);
  }

  // ---- code bots -------------------------------------------------------------------------

  /** Load the `pi.durable` parts of the user's Pi packages once per process, on first need. */
  private ensurePackages(): Promise<void> {
    this.coding.loading ??= (async () => {
      const loaded = await loadPackages(this.coding.piDir);
      for (const { source, error } of loaded.errors) console.error(`pi package ${source} skipped: ${error}`);
      for (const extension of loaded.extensions) {
        try {
          this.coding.registry.install(extension);
          this.coding.packages.push(extension);
        } catch (error) {
          console.error(`pi package extension ${extension.name} skipped: ${error instanceof Error ? error.message : error}`);
        }
      }
      const models = this.options.models as unknown as Partial<MutableModels>;
      for (const provider of loaded.providers) {
        if (typeof models.setProvider === "function") models.setProvider(provider);
        else console.error(`pi package provider ${provider.id} skipped: this model catalog is read-only`);
      }
    })().catch((error: unknown) => {
      console.error(`pi packages skipped: ${error instanceof Error ? error.message : error}`);
    });
    return this.coding.loading;
  }

  /** Selection order: Pi's tools, tool search, packages (as host.mjs), then the gate last so it sees final arguments. */
  private codeExtensions(): Extension[] {
    return [CodingTools, this.coding.toolSearch, ...this.coding.packages, this.coding.gate];
  }

  /** Make the conversation match the bot's stored permissions: tools and workspace with `code`, none without. */
  private async syncAgent(bot: BotRecord): Promise<void> {
    const conversation = await this.harness.conversation(asConversation(bot.conversationId), ctx);
    if (!conversation) return;
    if (isCoder(bot)) {
      await this.ensurePackages();
      this.isolation.prepare(bot.pubkey);
      const workspace = this.isolation.workspace(bot.pubkey);
      await conversation.configure({ extensions: this.codeExtensions(), cwd: workspace, instructions: instructionsFor(bot) }, ctx);
      return;
    }
    const selected = (await conversation.agent(ctx)).extensions.length > 0;
    await conversation.configure(selected ? { instructions: instructionsFor(bot), extensions: null, cwd: null } : { instructions: instructionsFor(bot) }, ctx);
  }

  private async codeTurn(bot: BotRecord, message: HumanMessage, conversation: Conversation): Promise<void> {
    const workspace = this.isolation.workspace(bot.pubkey);
    await conversation.configure({ extensions: this.codeExtensions(), cwd: workspace, instructions: instructionsFor(bot) }, ctx);
    const turn: CodeTurn = {
      requestId: `nostr:${message.eventId}:${bot.pubkey}`,
      pubkey: bot.pubkey,
      channelId: message.channelId,
      eventId: message.eventId,
      author: message.authorPubkey,
      text: message.text,
      createdAt: message.createdAt,
    };
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      reg.turns ??= [];
      if (!reg.turns.some((item) => item.requestId === turn.requestId)) reg.turns.push(turn);
    }, ctx);
    await this.runTurn(turn);
  }

  /** Submit (or find again, by request id) the turn's input, wait for its run, post the answer, drop the turn. */
  private async runTurn(turn: CodeTurn): Promise<void> {
    const ownerSecret = readKey(ownerKeyPath(this.options.home));
    const bot = (await this.snapshot()).bots.find((item) => item.pubkey === turn.pubkey);
    const drop = (reg: RegistryState) => {
      reg.turns = (reg.turns ?? []).filter((item) => item.requestId !== turn.requestId);
    };
    const conversation = bot && (await this.harness.conversation(asConversation(bot.conversationId), ctx));
    if (!bot || !conversation) {
      await this.harness.commit(async (tx) => drop(await tx.doc(RegistryDoc)), ctx);
      return;
    }
    const message: HumanMessage = {
      channelId: turn.channelId,
      authorPubkey: turn.author,
      eventId: turn.eventId,
      text: turn.text,
      createdAt: turn.createdAt,
    };
    const before = tokensOf(await this.harness.snapshot(UsageDoc, conversation.id, ctx));
    const submission = await conversation.submit({ type: "input", content: turn.text, requestId: turn.requestId }, ctx);
    const settled = await submission.wait(ctx);
    const after = tokensOf(await this.harness.snapshot(UsageDoc, conversation.id, ctx));
    const spent = Math.max(this.options.turnTokens, after - before);
    let answer = "I could not answer that.";
    if (settled.status === "done" && settled.type === "input") {
      const entry = await conversation.commit((tx) => tx.entry(settled.answer), ctx);
      const content = entry?.model?.[0] && "content" in entry.model[0] ? entry.model[0].content : undefined;
      answer = textOf(content) || answer;
    }
    await this.reply(bot, message, answer, spent, ownerSecret, true, drop);
    this.notifyOutbox();
  }

  /** A resumed turn can still have the previous workspace path stored in its agent snapshot. */
  private async envFor(target: EnvTarget): Promise<WorkspaceEnv | undefined> {
    const bot = await this.coderFor(target.conversationId);
    if (!bot) return undefined;
    return new WorkspaceEnv(
      this.isolation.workspace(bot.pubkey),
      this.isolation.unsafe ? undefined : this.isolation.user,
      () => this.isolation.prepare(bot.pubkey),
    );
  }

  private async coderFor(conversationId: ConversationId): Promise<BotRecord | undefined> {
    const bot = (await this.snapshot()).bots.find((item) => item.conversationId === (conversationId as unknown as number));
    return bot && isCoder(bot) ? bot : undefined;
  }

  private async toolWorkspace(conversationId: ConversationId): Promise<(Roots & { homeAliases: string[] }) | { refusal: string } | undefined> {
    const bot = await this.coderFor(conversationId);
    if (!bot) return undefined;
    const refusal = this.isolation.prepare(bot.pubkey);
    if (refusal) return { refusal };
    const home = this.options.home;
    let real = home;
    try {
      real = physicalPath(home);
    } catch {
      // keep the configured path
    }
    return { home, workspace: this.isolation.workspace(bot.pubkey), homeAliases: real === home ? [] : [real] };
  }

  /** Store a parked call's request and post it in the channel of the turn it belongs to. Idempotent. */
  private async requestApproval(ask: ApprovalAsk): Promise<void> {
    const taskId = ask.taskId as unknown as number;
    const state = await this.snapshot();
    if ((state.approvals ?? []).some((item) => item.taskId === taskId && item.key === ask.key)) return;
    const bot = state.bots.find((item) => item.conversationId === (ask.conversationId as unknown as number));
    if (!bot) return;
    const turn = (state.turns ?? []).find((item) => item.pubkey === bot.pubkey);
    const channelId = turn?.channelId ?? bot.scope[0];
    if (!channelId) return;
    const ownerSecret = readKey(ownerKeyPath(this.options.home));
    const id = randomUUID().slice(0, 8);
    const event = this.chatEvent(bot, channelId, approvalText(bot, ask, id), ownerSecret);
    const request: ApprovalRequest = {
      id,
      pubkey: bot.pubkey,
      conversationId: bot.conversationId,
      taskId,
      key: ask.key,
      channelId,
      tool: ask.tool,
      subject: ask.subject,
      reasons: ask.reasons,
      eventId: event.id,
      createdAt: Math.floor(Date.now() / 1000),
    };
    let added = false;
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      reg.approvals ??= [];
      if (reg.approvals.some((item) => item.taskId === taskId && item.key === ask.key)) return;
      reg.approvals.push(request);
      reg.outbox.push(event);
      added = true;
    }, ctx);
    if (added) this.notifyOutbox();
  }

  private async dropApproval(taskId: TaskId, key: string): Promise<void> {
    const id = taskId as unknown as number;
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      if (!(reg.approvals ?? []).some((item) => item.taskId === id && item.key === key)) return;
      reg.approvals = (reg.approvals ?? []).filter((item) => !(item.taskId === id && item.key === key));
    }, ctx);
  }

  /**
   * `aprovo`/`sim`/`approve` or `rejeito`/`não`/`reject` from a person in a channel with pending
   * command approvals. Which request it answers:
   * 1. a reply to a request message: that request;
   * 2. a leading @mention of a bot with a request here: that bot's oldest request
   *    (`@Onboarding Specialist aprovo` stays with the proposal);
   * 3. no mention: the only request here, when no proposal is pending here too; otherwise the
   *    daemon asks which one instead of guessing.
   * Returns false when the message is not an answer to a command approval.
   */
  private async handleApprovalReply(
    state: RegistryState,
    message: HumanMessage,
    leading: { text: string; mentioned: string[] },
    onboarding: BotRecord | undefined,
  ): Promise<boolean> {
    const here = (state.approvals ?? []).filter((item) => item.channelId === message.channelId);
    if (here.length === 0) return false;
    const word = parseCommand(leading.text);
    if (word?.type !== "approve" && word?.type !== "reject") return false;
    let chosen = here.find((item) => message.replyTo?.includes(item.eventId));
    if (!chosen && leading.mentioned.length > 0) {
      const mentioned = state.bots.filter((bot) => leading.mentioned.includes(bot.name)).map((bot) => bot.pubkey);
      chosen = here.find((item) => mentioned.includes(item.pubkey));
      if (!chosen) return false;
    }
    if (!chosen) {
      const proposalHere = state.pending !== null && onboarding !== undefined && onboarding.scope.includes(message.channelId);
      if (here.length === 1 && !proposalHere) chosen = here[0];
      else {
        await this.askWhich(state, message, here, proposalHere ? onboarding : undefined);
        return true;
      }
    }
    await this.resolveApproval(state, chosen!, message, word.type === "approve");
    return true;
  }

  private async askWhich(state: RegistryState, message: HumanMessage, here: ApprovalRequest[], onboarding: BotRecord | undefined): Promise<void> {
    const ownerSecret = readKey(ownerKeyPath(this.options.home));
    const lines = ["More than one request is waiting here, so I did not guess. Say which one:"];
    for (const item of here) {
      const bot = state.bots.find((candidate) => candidate.pubkey === item.pubkey);
      lines.push(`- @${bot?.name ?? item.pubkey.slice(0, 8)} aprovo (or rejeito): ${item.tool === "bash" ? "run" : item.tool} ${item.subject}`);
    }
    if (onboarding && state.pending) lines.push(`- @${onboarding.name} aprovo (or reject): proposal ${state.pending.id} (${state.pending.action} ${state.pending.name})`);
    lines.push("Or reply directly to the request message.");
    const poster = onboarding ?? state.bots.find((bot) => bot.role === "onboarding" && bot.status === "active" && bot.scope.includes(message.channelId))
      ?? state.bots.find((bot) => bot.pubkey === here[0]!.pubkey)!;
    await this.reply(poster, message, lines.join("\n"), 0, ownerSecret);
  }

  private async resolveApproval(state: RegistryState, request: ApprovalRequest, message: HumanMessage, allow: boolean): Promise<void> {
    const bot = state.bots.find((item) => item.pubkey === request.pubkey);
    const result = await this.harness.signal(
      request.taskId as unknown as TaskId,
      ApprovalDecision,
      request.key,
      { allow, by: message.authorPubkey },
      ctx,
    );
    const text =
      result === "delivered"
        ? allow
          ? `Approved. Running once:\n${request.subject}`
          : `Rejected. Not running:\n${request.subject}`
        : `That request was already answered or has ended (${result}); nothing more runs.`;
    const ownerSecret = readKey(ownerKeyPath(this.options.home));
    const event = bot && bot.permissions.includes("post") ? this.chatEvent(bot, message.channelId, text, ownerSecret) : undefined;
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      reg.approvals = (reg.approvals ?? []).filter((item) => item.id !== request.id);
      remember(reg, message);
      if (event) reg.outbox.push(event);
    }, ctx);
    this.notifyOutbox();
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
  const lines = [
    `You are ${bot.name}, a Yewholt bot in a Buzz channel.`,
    `Model: ${bot.modelLabel}.`,
    `Scope (channel ids): ${bot.scope.join(", ") || "none"}.`,
    `Permissions: ${bot.permissions.join(", ") || "none"}.`,
    "Stay inside that scope. post lets you publish in those channels. read lets the daemon show them to you.",
  ];
  if (!isCoder(bot)) {
    lines.push("Do not invent extra permissions. Calendar, email, MCP, and repo access are out of scope.");
    return lines.join("\n");
  }
  lines.push(
    "code gives you your own workspace folder. It is your working directory and your $HOME; use relative paths there.",
    "Tools: read, write, edit and bash work in the workspace. tool_search finds and loads more tools when you need them.",
    "Inside the workspace you work freely. These wait until a person approves them in the chat: recursive deletes (rm -r), git push, piping a download into a shell, sudo/su/doas, any command that mentions the Yewholt state folder ($YEWHOLT_HOME, .yewholt), and write or edit outside the workspace. The call waits; a rejection comes back to you as a refusal.",
    "Reading or writing Yewholt's state folder is refused and cannot be approved. Your commands do not get the daemon's environment or its API keys.",
    "Do not invent extra permissions. Calendar, email and MCP are out of scope.",
  );
  return lines.join("\n");
}

function approvalText(bot: BotRecord, ask: ApprovalAsk, id: string): string {
  const what = ask.tool === "bash" ? "run this command" : `${ask.tool} this path outside its workspace`;
  return [
    `${bot.name} asks for approval (${id}) to ${what}:`,
    "",
    ask.subject,
    "",
    `Why: ${ask.reasons.join("; ")}.`,
    `Reply "aprovo" to run it once, or "rejeito" to refuse. If other requests are waiting here, write "@${bot.name} aprovo" or reply to this message.`,
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

