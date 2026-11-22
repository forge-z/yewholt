import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
  type SettledSubmissionRecord,
  type Storage,
  type TaskId,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { PRESENCE, RUNTIME_PROFILE, presence, runtimeProfile, type AgentScan } from "./agents.js";
import { ApprovalDecision, createGateExtension, type ApprovalAsk } from "./coding.js";
import { isModelReference } from "./control-protocol.js";
import { loadPackages, piDir } from "./packages.js";
import { physicalPath, WorkspaceEnv, type Roots } from "./workspace.js";
import { WorkspaceIsolation } from "./isolation.js";
import { catalogHas, loadModels, type ModelChoice } from "./models.js";
import { readKey, writeKey } from "./keys.js";
import { ownerAuthTag, pubkeyOf, signEvent, type NostrEvent } from "./nostr.js";
import { effectiveScope } from "./membership.js";
import { approvalWord, stripLeadingMentions } from "./parser.js";
import { botKeyPath, ownerKeyPath } from "./paths.js";
import { RegistryDoc, type ApprovalRequest, type BotRecord, type CodeTurn, type RegistryState } from "./registry.js";
import { sameRelay } from "./relay-url.js";

const ctx: Context = BACKGROUND_CONTEXT;
const PROCESSED_CAP = 400;

export type HumanMessage = {
  relay?: CodeTurn["relay"];
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
  now?: () => number;
  /** Pubkeys besides the owner that may answer code-bot approvals (default `YEWHOLT_ADMINS`). */
  admins?: readonly string[];
};

/** A bot that gets the coding runtime: stored permissions include `code`. */
export function isCoder(bot: Pick<BotRecord, "permissions">): boolean {
  return bot.permissions.includes("code");
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
  private readonly directChannels = new Map<string, ReadonlySet<string>>();
  private readonly agentKeys = new Map<string, string>();
  private readonly agentRuntime = new Map<string, { profile: number; presence: number }>();
  private readonly ignoredShutdowns = new Set<string>();
  private agentReconcile: Promise<void> = Promise.resolve();
  private outboxListener: (() => void) | undefined;

  private constructor(
    readonly harness: Harness,
    private readonly options: Required<Pick<SessionOptions, "home" | "turnTokens" | "defaultLimit" | "now">> & { models: Models; admins: ReadonlySet<string> },
    private readonly coding: Coding,
    private readonly isolation: WorkspaceIsolation,
  ) {}

  static async open(storage: Storage, options: SessionOptions): Promise<Yewholt> {
    const agentDir = options.piDir ?? piDir();
    const models = options.models ?? (await loadModels(process.env, join(agentDir, "auth.json")));
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
        now: options.now ?? Date.now,
        models,
        admins: new Set((options.admins ?? parseAdmins(process.env.YEWHOLT_ADMINS)).map((key) => key.toLowerCase())),
      },
      { registry, toolSearch, gate, packages: [], piDir: agentDir },
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
  setMemberChannels(pubkey: string, channels: Iterable<string>, direct: Iterable<string> = []): void {
    const set = new Set(channels);
    if (set.size === 0) this.memberChannels.delete(pubkey);
    else this.memberChannels.set(pubkey, set);
    const conversations = new Set(direct);
    if (conversations.size === 0) this.directChannels.delete(pubkey);
    else this.directChannels.set(pubkey, conversations);
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
    return (await this.harness.snapshot(RegistryDoc, ctx)) ?? { bots: [], processed: [], outbox: [], highWater: 0 };
  }

  botSecret(bot: Pick<BotRecord, "external" | "pubkey">): string {
    if (!bot.external) return readKey(botKeyPath(this.options.home, bot.pubkey));
    const secret = this.agentKeys.get(bot.pubkey);
    if (!secret) throw new Error("external agent key unavailable");
    return secret;
  }

  hasAgentKey(pubkey: string): boolean {
    return this.agentKeys.has(pubkey);
  }

  availableModelReferences(): string[] {
    return [...new Set(this.options.models.getModels().map((model) => `${model.provider}/${model.id}`)
      .filter(isModelReference))].sort();
  }

  hasModel(choice: ModelChoice): boolean {
    return catalogHas(this.options.models, choice);
  }

  async forgetRemovedAgent(pubkey: string): Promise<void> {
    this.agentKeys.delete(pubkey);
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      reg.outbox = reg.outbox.filter((event) => event.pubkey !== pubkey);
    }, ctx);
  }

  async updateHostedName(pubkey: string, name: string): Promise<void> {
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      const bot = reg.bots.find((item) => item.external && item.pubkey === pubkey);
      if (bot) bot.name = name;
    }, ctx);
    this.agentRuntime.delete(pubkey);
  }

  reconcileAgents(scan: AgentScan): Promise<void> {
    const run = this.agentReconcile.then(() => this.applyAgentFiles(scan));
    this.agentReconcile = run.catch(() => undefined);
    return run;
  }

  private async applyAgentFiles(scan: AgentScan): Promise<void> {
    const previous = new Map((await this.snapshot()).bots.map((bot) => [bot.pubkey, bot]));
    const valid = new Set<string>();
    for (const definition of scan.definitions) {
      const { pubkey, name, model, nsec, channelId, permissions, ownerPubkey, authTag, relayUrl, respondTo, respondToAllowlist, mtimeMs, fileVersion } = definition;
      const old = previous.get(pubkey);
      if (old && !old.external) continue;
      valid.add(pubkey);
      this.agentKeys.set(pubkey, nsec);
      const fields = {
        name, modelLabel: model.label, provider: model.provider, modelId: model.modelId, scope: channelId ? [channelId] : [],
        permissions, external: true as const, ownerPubkey, authTag, relayUrl, respondTo, respondToAllowlist,
      };
      if (!old) {
        const bot: BotRecord = {
          ...fields, conversationId: 0, pubkey, status: "active", stopped: false, agentFileVersion: fileVersion,
          role: "member", limitTokens: this.options.defaultLimit, spentTokens: 0, announced: true,
        };
        await this.createConversation(bot, (reg) => reg.bots.push(bot));
        if (isCoder(bot)) this.isolation.prepare(pubkey);
        continue;
      }
      const changed = Object.entries(fields).some(([key, value]) => JSON.stringify(old[key as keyof BotRecord]) !== JSON.stringify(value));
      const wasProvisioned = old.status === "active" || old.status === "stopped";
      if (!changed && wasProvisioned && old.agentFileVersion === fileVersion) continue;
      if (changed) await this.syncAgent({ ...old, ...fields });
      await this.harness.commit(async (tx) => {
        const reg = await tx.doc(RegistryDoc);
        const current = reg.bots.find((item) => item.pubkey === pubkey)!;
        const stopped = current.stopped === true && (fileVersion === current.stoppedFileVersion || mtimeMs <= (current.stoppedAt ?? Infinity));
        Object.assign(current, fields, { agentFileVersion: fileVersion, stopped, status: stopped ? "stopped" : "active" });
      }, ctx);
      if (changed || old.status !== "active") this.agentDisconnected(pubkey);
    }
    const missing = [...previous.values()].filter((bot) => bot.external && !valid.has(bot.pubkey));
    if (missing.length === 0) return;
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      for (const { pubkey } of missing) {
        const bot = reg.bots.find((item) => item.pubkey === pubkey)!;
        const status = scan.unavailable || scan.present.has(pubkey) ? "invalid" : "retired";
        if (bot.status === status) continue;
        discardAgentTraffic(reg, pubkey);
        if (!bot.stopped && status === "retired") this.queueOffline(reg, pubkey);
        bot.status = status;
        this.agentDisconnected(pubkey);
      }
    }, ctx);
  }

  agentDisconnected(pubkey: string): void {
    this.agentRuntime.delete(pubkey);
  }

  /** Only authenticated, connected external agents are eligible for an online update. */
  async refreshAgentRuntime(connected: readonly string[]): Promise<boolean> {
    const now = this.options.now();
    const due = new Set(connected.filter((pubkey) => {
      const last = this.agentRuntime.get(pubkey);
      return !last || now - last.presence >= 60_000 || now - last.profile >= 600_000;
    }));
    if (due.size === 0) return false;
    let queued = false;
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      for (const bot of reg.bots) {
        if (!bot.external || bot.status !== "active" || !due.has(bot.pubkey)) continue;
        const secret = this.botSecret(bot);
        const last = this.agentRuntime.get(bot.pubkey) ?? { profile: -Infinity, presence: -Infinity };
        const createdAt = Math.floor(now / 1000);
        if (now - last.profile >= 600_000) {
          queueRuntime(reg, runtimeProfile(bot, secret, createdAt));
          last.profile = now;
          queued = true;
        }
        if (now - last.presence >= 60_000) {
          queueRuntime(reg, presence(secret, "online", createdAt));
          last.presence = now;
          queued = true;
        }
        this.agentRuntime.set(bot.pubkey, last);
      }
    }, ctx);
    return queued;
  }

  /** On process shutdown, advertise offline while the links are still usable. */
  async offlineAgents(connected: readonly string[]): Promise<void> {
    const online = new Set(connected);
    if (online.size === 0) return;
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      for (const bot of reg.bots) {
        if (!bot.external || bot.status !== "active" || !online.has(bot.pubkey)) continue;
        reg.outbox = reg.outbox.filter((event) => event.pubkey !== bot.pubkey ||
          (event.kind !== RUNTIME_PROFILE && !(event.kind === PRESENCE && event.content === "online")));
        this.queueOffline(reg, bot.pubkey);
      }
    }, ctx);
  }

  private queueOffline(reg: RegistryState, pubkey: string): void {
    const secret = this.agentKeys.get(pubkey);
    if (!secret) return;
    const event = presence(secret, "offline", Math.floor(this.options.now() / 1000));
    if (!reg.outbox.some((item) => item.id === event.id)) reg.outbox.push(event);
  }

  private async handleShutdown(message: HumanMessage): Promise<void> {
    let rejected = false;
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      for (const bot of reg.bots) {
        if (!bot.external || !this.inScope(bot, message)) continue;
        if (bot.status !== "active" || bot.shutdownEventIds?.includes(message.eventId)) continue;
        if (bot.ownerPubkey !== message.authorPubkey) {
          rejected = true;
          continue;
        }
        bot.stopped = true;
        bot.stoppedAt = this.options.now();
        bot.stoppedFileVersion = bot.agentFileVersion;
        bot.status = "stopped";
        bot.shutdownEventIds = [...(bot.shutdownEventIds ?? []), message.eventId];
        discardAgentTraffic(reg, bot.pubkey);
        this.queueOffline(reg, bot.pubkey);
        this.agentDisconnected(bot.pubkey);
        remember(reg, message);
      }
    }, ctx);
    if (rejected && !this.ignoredShutdowns.has(message.eventId)) {
      this.ignoredShutdowns.add(message.eventId);
      console.error("external agent shutdown ignored: author is not the agent owner");
    }
  }

  private inScope(bot: BotRecord, message: HumanMessage): boolean {
    return receivesOnRelay(bot, message) && effectiveScope(bot.scope, this.memberChannels.get(bot.pubkey)).includes(message.channelId);
  }

  async handleHuman(message: HumanMessage): Promise<void> {
    const state = await this.snapshot();
    if (state.processed.includes(processedKey(message))) return;
    const localBots = state.bots.filter((bot) => receivesOnRelay(bot, message));
    if (message.text.trim() === "!shutdown" && localBots.some((bot) => bot.external && this.inScope(bot, message))) {
      await this.handleShutdown(message);
      return;
    }
    if (state.bots.some((bot) => bot.pubkey === message.authorPubkey)) return;

    const leading = stripLeadingMentions(message.text, localBots.map((bot) => bot.name));
    if (await this.handleApprovalReply(state, message, leading)) return;
    for (const bot of localBots) {
      if (!bot.external || bot.status !== "active" || !this.inScope(bot, message)) continue;
      const direct = this.directChannels.get(bot.pubkey)?.has(message.channelId);
      const allowed = direct
        ? bot.respondTo === "anyone" || (bot.respondTo === "allowlist" && bot.respondToAllowlist?.includes(message.authorPubkey))
        : messageMentions(message.text, bot);
      if (allowed) await this.handleMember(bot, message);
    }
  }

  async ackOutbox(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    const retired: string[] = [];
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      reg.outbox = reg.outbox.filter((event) => !drop.has(event.id));
      for (const bot of reg.bots) {
        if (bot.external && bot.status === "retired" && this.agentKeys.has(bot.pubkey) &&
            !reg.outbox.some((event) => event.pubkey === bot.pubkey)) retired.push(bot.pubkey);
      }
    }, ctx);
    for (const pubkey of retired) this.agentKeys.delete(pubkey);
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

  private async handleMember(bot: BotRecord, message: HumanMessage): Promise<void> {
    if (!bot.permissions.includes("post")) {
      await this.noteOnly(bot, message, "Permission post is off, so this session will not publish.");
      return;
    }
    if (!(await this.canSpend(bot, this.options.turnTokens))) {
      await this.reply(bot, message, budgetText(bot), 0);
      return;
    }
    await this.answerWithModel(bot, message);
  }

  private async answerWithModel(bot: BotRecord, message: HumanMessage): Promise<void> {
    // A package may add the provider this bot's model comes from.
    if (isCoder(bot)) await this.ensurePackages();
    const choice = { provider: bot.provider, modelId: bot.modelId, label: bot.modelLabel };
    if (!choice.provider || !choice.modelId || !catalogHas(this.options.models, choice)) {
      const text = `${bot.name} is a durable session on ${choice.label || "an unset model"}. Free-text answers need a provider API key and a pi-ai catalog id (provider/modelId).`;
      await this.reply(bot, message, text, 0);
      return;
    }
    if (!(await this.canSpend(bot, this.options.turnTokens))) {
      await this.reply(bot, message, budgetText(bot), 0);
      return;
    }
    const conversation = await this.harness.conversation(asConversation(bot.conversationId), ctx);
    if (!conversation) {
      await this.reply(bot, message, "This session has no conversation.", 0);
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
    const answer = await this.answerText(bot, conversation, settled);
    await this.reply(bot, message, answer, spent);
  }

  /** The model's text, or why the run gave none (`model_error: 429 ...`, `no_model`), also logged. */
  private async answerText(bot: BotRecord, conversation: Conversation, settled: SettledSubmissionRecord): Promise<string> {
    let reason: string;
    let detail: unknown;
    if (settled.status === "done" && settled.type === "input") {
      const entry = await conversation.commit((tx) => tx.entry(settled.answer), ctx);
      const content = entry?.model?.[0] && "content" in entry.model[0] ? entry.model[0].content : undefined;
      const text = textOf(content);
      if (text) return text;
      reason = "empty_answer";
    } else {
      reason = settled.status === "unanswered" ? settled.reason : settled.status;
      detail = settled.status === "unanswered" ? settled.detail : undefined;
    }
    const why = failureReason(reason, detail);
    console.error(`turn: ${bot.name} (${bot.provider}/${bot.modelId}) got no answer: ${why}`);
    return `I could not answer that (${why}).`;
  }

  private async createConversation(bot: BotRecord, register?: (reg: RegistryState) => void): Promise<void> {
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: agentChange(bot),
        init: register && (async (tx, id) => {
          bot.conversationId = id as unknown as number;
          register(await tx.doc(RegistryDoc));
        }),
      },
      ctx,
    );
    bot.conversationId = conversation.id as unknown as number;
  }

  private async canSpend(bot: BotRecord, cost: number): Promise<boolean> {
    const fresh = (await this.snapshot()).bots.find((item) => item.pubkey === bot.pubkey) ?? bot;
    return fresh.spentTokens + cost <= fresh.limitTokens;
  }

  private chatEvent(bot: BotRecord, channelId: string, text: string): NostrEvent {
    const authTag = bot.authTag ?? ownerAuthTag(readKey(ownerKeyPath(this.options.home)), bot.pubkey, "kind=9");
    return signEvent(this.botSecret(bot), 9, text, [["h", channelId], authTag]);
  }

  private async reply(
    bot: BotRecord,
    message: HumanMessage,
    text: string,
    cost: number,
    mark = true,
    also?: (reg: RegistryState) => void,
  ): Promise<void> {
    const fresh = (await this.snapshot()).bots.find((item) => item.pubkey === bot.pubkey) ?? bot;
    if (fresh.external && fresh.status !== "active") {
      if (also) await this.harness.commit(async (tx) => also(await tx.doc(RegistryDoc)), ctx);
      return;
    }
    if (!fresh.permissions.includes("post")) {
      if (also) await this.harness.commit(async (tx) => also(await tx.doc(RegistryDoc)), ctx);
      await this.noteOnly(fresh, message, text);
      return;
    }
    const event = this.chatEvent(fresh, message.channelId, text);
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      const current = fresh.external ? reg.bots.find((item) => item.pubkey === fresh.pubkey) : fresh;
      if (!current || current.status !== fresh.status || !current.permissions.includes("post") ||
          (current.external && current.stoppedAt !== bot.stoppedAt)) {
        also?.(reg);
        return;
      }
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
    const change = bot.external
      ? { ...agentChange(bot), model: bot.provider && bot.modelId ? { provider: bot.provider, modelId: bot.modelId } : null }
      : { instructions: instructionsFor(bot) };
    if (isCoder(bot)) {
      await this.ensurePackages();
      this.isolation.prepare(bot.pubkey);
      const workspace = this.isolation.workspace(bot.pubkey);
      await conversation.configure({ ...change, extensions: this.codeExtensions(), cwd: workspace }, ctx);
      return;
    }
    const selected = (await conversation.agent(ctx)).extensions.length > 0;
    await conversation.configure(selected ? { ...change, extensions: null, cwd: null } : change, ctx);
  }

  private async codeTurn(bot: BotRecord, message: HumanMessage, conversation: Conversation): Promise<void> {
    const workspace = this.isolation.workspace(bot.pubkey);
    await conversation.configure({ extensions: this.codeExtensions(), cwd: workspace, instructions: instructionsFor(bot) }, ctx);
    const turn: CodeTurn = {
      ...(message.relay && { relay: message.relay }),
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
    const bot = (await this.snapshot()).bots.find((item) => item.pubkey === turn.pubkey);
    const drop = (reg: RegistryState) => {
      reg.turns = (reg.turns ?? []).filter((item) => item.requestId !== turn.requestId);
    };
    const conversation = bot && (await this.harness.conversation(asConversation(bot.conversationId), ctx));
    if (!bot || !conversation) {
      await this.harness.commit(async (tx) => drop(await tx.doc(RegistryDoc)), ctx);
      return;
    }
    if (bot.external && bot.status !== "active") return;
    const message: HumanMessage = {
      relay: turn.relay,
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
    const answer = await this.answerText(bot, conversation, settled);
    await this.reply(bot, message, answer, spent, true, drop);
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
    return bot && (!bot.external || bot.status === "active") && isCoder(bot) ? bot : undefined;
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
    return {
      home,
      workspace: this.isolation.workspace(bot.pubkey),
      homeAliases: real === home ? [] : [real],
      credentialFile: join(this.coding.piDir, "auth.json"),
    };
  }

  /** Store a parked call's request and post it in the channel of the turn it belongs to. Idempotent. */
  private async requestApproval(ask: ApprovalAsk): Promise<void> {
    const taskId = ask.taskId as unknown as number;
    const state = await this.snapshot();
    if ((state.approvals ?? []).some((item) => item.taskId === taskId && item.key === ask.key)) return;
    const bot = state.bots.find((item) => item.conversationId === (ask.conversationId as unknown as number));
    if (!bot || (bot.external && bot.status !== "active")) return;
    const turn = (state.turns ?? []).find((item) => item.pubkey === bot.pubkey);
    const channelId = turn?.channelId ?? bot.scope[0];
    if (!channelId) return;
    const id = randomUUID().slice(0, 8);
    const event = this.chatEvent(bot, channelId, approvalText(bot, ask, id));
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
   * 2. a leading @mention of a bot with a request here: that bot's oldest request;
   * 3. no mention: the only request here; otherwise the daemon asks which one instead of guessing.
   * Returns false when the message is not an answer to a command approval.
   */
  private async handleApprovalReply(
    state: RegistryState,
    message: HumanMessage,
    leading: { text: string; mentioned: string[] },
  ): Promise<boolean> {
    const here = (state.approvals ?? []).filter((item) => {
      if (item.channelId !== message.channelId) return false;
      const bot = state.bots.find((entry) => entry.pubkey === item.pubkey);
      return bot ? receivesOnRelay(bot, message) && (!bot.external || bot.status === "active") : !message.relay;
    });
    if (here.length === 0) return false;
    const word = approvalWord(leading.text);
    if (!word) return false;
    let chosen = here.find((item) => message.replyTo?.includes(item.eventId));
    if (!chosen && leading.mentioned.length > 0) {
      const mentioned = state.bots.filter((bot) => leading.mentioned.includes(bot.name)).map((bot) => bot.pubkey);
      chosen = here.find((item) => mentioned.includes(item.pubkey));
      if (!chosen) return false;
    }
    if (!chosen) {
      if (here.length === 1) chosen = here[0];
      else {
        await this.askWhich(state, message, here);
        return true;
      }
    }
    if (!this.mayApprove(state, chosen!, message.authorPubkey)) {
      await this.refuseApprover(state, chosen!, message);
      return true;
    }
    await this.resolveApproval(state, chosen!, message, word === "approve");
    return true;
  }

  /** The install owner, the external agent's owner, or an admin from `YEWHOLT_ADMINS`. */
  private mayApprove(state: RegistryState, request: ApprovalRequest, author: string): boolean {
    const who = author.toLowerCase();
    if (this.options.admins.has(who)) return true;
    const bot = state.bots.find((item) => item.pubkey === request.pubkey);
    if (bot?.external && bot.ownerPubkey === who) return true;
    try {
      return pubkeyOf(readKey(ownerKeyPath(this.options.home))) === who;
    } catch {
      return false;
    }
  }

  private async refuseApprover(state: RegistryState, request: ApprovalRequest, message: HumanMessage): Promise<void> {
    console.error(`approval ${request.id} ignored: ${message.authorPubkey} is not the owner or an admin`);
    const bot = state.bots.find((item) => item.pubkey === request.pubkey);
    const text = `Only the owner or an admin can answer approval ${request.id}. Nothing changed; it is still waiting.`;
    if (bot) await this.reply(bot, message, text, 0);
    else await this.harness.commit(async (tx) => remember(await tx.doc(RegistryDoc), message), ctx);
  }

  private async askWhich(state: RegistryState, message: HumanMessage, here: ApprovalRequest[]): Promise<void> {
    const lines = ["More than one request is waiting here, so I did not guess. Say which one:"];
    for (const item of here) {
      const bot = state.bots.find((candidate) => candidate.pubkey === item.pubkey);
      lines.push(`- @${bot?.name ?? item.pubkey.slice(0, 8)} aprovo (or rejeito): ${item.tool === "bash" ? "run" : item.tool} ${item.subject}`);
    }
    lines.push("Or reply directly to the request message.");
    const poster = state.bots.find((bot) => bot.pubkey === here[0]!.pubkey)!;
    await this.reply(poster, message, lines.join("\n"), 0);
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
    const event = bot && bot.permissions.includes("post") ? this.chatEvent(bot, message.channelId, text) : undefined;
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

function charge(reg: RegistryState, pubkey: string, cost: number): void {
  const bot = reg.bots.find((item) => item.pubkey === pubkey);
  if (bot) bot.spentTokens += cost;
}

function receivesOnRelay(bot: BotRecord, message: HumanMessage): boolean {
  return !message.relay || (bot.relayUrl ? sameRelay(bot.relayUrl, message.relay.url) : message.relay.primary);
}

function processedKey(message: HumanMessage): string {
  return message.relay && !message.relay.primary ? `${message.relay.url}:${message.eventId}` : message.eventId;
}

function remember(reg: RegistryState, message: HumanMessage): void {
  const key = processedKey(message);
  if (!reg.processed.includes(key)) reg.processed.push(key);
  if (reg.processed.length > PROCESSED_CAP) reg.processed.splice(0, reg.processed.length - PROCESSED_CAP);
  if (message.relay && !message.relay.primary) {
    const url = message.relay.url;
    if (message.createdAt > (reg.highWaterByRelay?.[url] ?? 0)) {
      reg.highWaterByRelay = { ...reg.highWaterByRelay, [url]: message.createdAt };
    }
  } else if (message.createdAt > reg.highWater) reg.highWater = message.createdAt;
}

function discardAgentTraffic(reg: RegistryState, pubkey: string): void {
  reg.outbox = reg.outbox.filter((event) => event.pubkey !== pubkey || (event.kind === PRESENCE && event.content === "offline"));
}

function queueRuntime(reg: RegistryState, event: NostrEvent): void {
  reg.outbox = reg.outbox.filter((item) => item.pubkey !== event.pubkey || item.kind !== event.kind ||
    (item.kind === PRESENCE && item.content === "offline"));
  reg.outbox.push(event);
}

function budgetText(bot: BotRecord): string {
  return `Budget exhausted for ${bot.name}: ${bot.spentTokens}/${bot.limitTokens} tokens. Raise it with \`yewholt admin budget\` while the daemon is stopped.`;
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

const MAX_REASON = 300;

/** One line for the chat and the log. Long token-like runs (API keys) are masked. */
export function failureReason(reason: string, detail?: unknown): string {
  const raw = detail === undefined || detail === null ? "" : typeof detail === "string" ? detail : JSON.stringify(detail);
  let text = raw.replace(/\s+/g, " ").trim().replace(/[A-Za-z0-9_\-]{32,}/g, "[redacted]");
  if (text.length > MAX_REASON) text = `${text.slice(0, MAX_REASON)}…`;
  return text ? `${reason}: ${text}` : reason;
}

/** `YEWHOLT_ADMINS`: hex pubkeys separated by commas or spaces. Anything else is skipped with a warning. */
export function parseAdmins(value: string | undefined): string[] {
  const admins: string[] = [];
  for (const item of (value ?? "").split(/[\s,]+/).filter(Boolean)) {
    if (/^[0-9a-fA-F]{64}$/.test(item)) admins.push(item.toLowerCase());
    else console.error(`YEWHOLT_ADMINS: skipped ${item.slice(0, 12)}…, not a 64-hex pubkey`);
  }
  return admins;
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
