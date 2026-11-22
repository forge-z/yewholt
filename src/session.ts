import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type Storage } from "@earendil-works/pi-durable";
import { SessionManager, type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PRESENCE, RUNTIME_PROFILE, presence, runtimeProfile, type AgentScan } from "./agents.js";
import { APPROVAL_TTL_MS, type ApprovalAsk } from "./coding.js";
import { isModelReference } from "./control-protocol.js";
import { botModelRuntime, createBotSession, piDir } from "./bot-session.js";
import { physicalPath, workspaceId, type Roots } from "./workspace.js";
import { WorkspaceIsolation } from "./isolation.js";
import { type ModelChoice } from "./models.js";
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
  /** Pi's global resources, credentials and sessions directory. */
  piDir?: string;
  now?: () => number;
  /** Pubkeys besides the owner that may answer code-bot approvals (default `YEWHOLT_ADMINS`). */
  admins?: readonly string[];
  /** Public wake URL announced in external agents' runtime profiles (`YEWHOLT_WAKE_URL`). */
  wakeUrl?: string;
};

/** A bot that gets the coding runtime: stored permissions include `code`. */
export function isCoder(bot: Pick<BotRecord, "permissions">): boolean {
  return bot.permissions.includes("code");
}

export class Yewholt {
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly waiting = new Map<string, { pubkey: string; resolve: (allow: boolean) => void }>();
  private readonly activeTurns = new Map<string, CodeTurn>();
  private closing = false;
  private readonly memberChannels = new Map<string, ReadonlySet<string>>();
  private readonly directChannels = new Map<string, ReadonlySet<string>>();
  private readonly agentKeys = new Map<string, string>();
  private readonly agentRuntime = new Map<string, { profile: number; presence: number }>();
  private readonly ignoredShutdowns = new Set<string>();
  private agentReconcile: Promise<void> = Promise.resolve();
  private outboxListener: (() => void) | undefined;

  private constructor(
    readonly harness: Harness,
    private readonly options: Required<Pick<SessionOptions, "home" | "turnTokens" | "defaultLimit" | "now">> & { admins: ReadonlySet<string>; wakeUrl?: string },
    private readonly agentDir: string,
    private readonly runtime: ModelRuntime,
    private readonly isolation: WorkspaceIsolation,
  ) {}

  static async open(storage: Storage, options: SessionOptions): Promise<Yewholt> {
    const agentDir = options.piDir ?? piDir();
    const runtime = await botModelRuntime(agentDir, options.models);
    const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, ctx);
    const self = new Yewholt(
      harness,
      {
        home: options.home,
        turnTokens: options.turnTokens ?? Number(process.env.YEWHOLT_TURN_TOKENS ?? "1000"),
        defaultLimit: options.defaultLimit ?? Number(process.env.YEWHOLT_BUDGET_TOKENS ?? "100000"),
        now: options.now ?? Date.now,
        admins: new Set((options.admins ?? parseAdmins(process.env.YEWHOLT_ADMINS)).map((key) => key.toLowerCase())),
        wakeUrl: options.wakeUrl,
      },
      agentDir,
      runtime,
      options.isolation ?? new WorkspaceIsolation(options.home),
    );
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

  /** A restarted process cannot safely replay a tool call or an unfinished prompt. */
  async resumeTurns(): Promise<void> {
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      for (const request of reg.approvals ?? []) {
        const bot = reg.bots.find((item) => item.pubkey === request.pubkey);
        if (bot && (!bot.external || this.hasAgentKey(bot.pubkey))) reg.outbox.push(this.chatEvent(bot, request.channelId,
          `The daemon restarted; request ${request.id} was cancelled, ask again.`));
      }
      for (const turn of reg.turns ?? []) {
        const bot = reg.bots.find((item) => item.pubkey === turn.pubkey);
        if (bot && (!bot.external || this.hasAgentKey(bot.pubkey))) reg.outbox.push(this.chatEvent(bot, turn.channelId,
          "Interrupted by a restart, send it again."));
        remember(reg, { channelId: turn.channelId, authorPubkey: turn.author, eventId: turn.eventId,
          text: turn.text, createdAt: turn.createdAt, relay: turn.relay });
      }
      reg.approvals = [];
      reg.turns = [];
    }, ctx);
    this.notifyOutbox();
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
    this.closing = true;
    for (const pubkey of this.sessions.keys()) this.disposeBot(pubkey);
    await Promise.allSettled(this.queues.values());
    await Promise.allSettled(this.retiring.values());
    await this.runtime.settleCredentialWrites();
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
    return [...new Set(this.runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`)
      .filter(isModelReference))].sort();
  }

  hasModel(choice: ModelChoice): boolean {
    return this.availableModelReferences().includes(`${choice.provider}/${choice.modelId}`);
  }

  async forgetRemovedAgent(pubkey: string): Promise<void> {
    this.disposeBot(pubkey);
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
    const bot = (await this.snapshot()).bots.find((item) => item.pubkey === pubkey);
    if (bot) await this.syncAgent(bot);
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
      if (changed) this.disposeBot(pubkey);
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
        this.disposeBot(pubkey);
        discardAgentTraffic(reg, pubkey);
        if (!bot.stopped && status === "retired") this.queueOffline(reg, pubkey);
        bot.status = status;
        this.agentDisconnected(pubkey);
      }
    }, ctx);
  }

  /** A turn, an approval or a queued message is in progress. */
  busy(): boolean {
    return this.activeTurns.size > 0 || this.waiting.size > 0 || this.queues.size > 0;
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
          queueRuntime(reg, runtimeProfile(bot, secret, createdAt, this.options.wakeUrl));
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
        this.disposeBot(bot.pubkey);
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
    const previous = this.queues.get(bot.pubkey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const state = await this.snapshot();
      if (state.processed.includes(processedKey(message))) return;
      const fresh = state.bots.find((item) => item.pubkey === bot.pubkey);
      if (this.closing || !fresh || fresh.status !== "active") return;
      if (!(await this.canSpend(fresh, this.options.turnTokens))) {
        await this.reply(fresh, message, budgetText(fresh), 0);
        return;
      }
      await this.runTurn(fresh, message);
    });
    this.queues.set(bot.pubkey, run);
    try { await run; }
    finally { if (this.queues.get(bot.pubkey) === run) this.queues.delete(bot.pubkey); }
  }

  private async createConversation(bot: BotRecord, register?: (reg: RegistryState) => void): Promise<void> {
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      bot.conversationId = Math.max(0, ...reg.bots.map((item) => item.conversationId)) + 1;
      register?.(reg);
    }, ctx);
  }

  async botSession(pubkey: string): Promise<AgentSession> {
    let pending = this.sessions.get(pubkey);
    if (!pending) {
      const retiring = this.retiring.get(pubkey);
      pending = (async () => {
        await retiring;
        const bot = (await this.snapshot()).bots.find((item) => item.pubkey === pubkey);
        if (!bot || bot.status !== "active" || this.closing) throw new Error("Bot is not active");
        const cwd = isCoder(bot) ? this.isolation.workspace(pubkey) : join(this.agentDir, "yewholt", workspaceId(pubkey));
        if (isCoder(bot)) this.isolation.prepare(pubkey);
        else mkdirSync(cwd, { recursive: true, mode: 0o700 });
        return createBotSession(bot, cwd, this.agentDir, this.runtime, instructionsFor(bot), {
          roots: () => this.toolWorkspace(bot),
          approve: (ask) => this.requestApproval(bot, ask),
          bashUser: this.isolation.unsafe ? undefined : this.isolation.user,
        });
      })();
      this.sessions.set(pubkey, pending);
      void pending.catch(() => { if (this.sessions.get(pubkey) === pending) this.sessions.delete(pubkey); });
    }
    return pending;
  }

  private disposeBot(pubkey: string): void {
    const pending = this.sessions.get(pubkey);
    this.sessions.delete(pubkey);
    for (const waiting of this.waiting.values()) if (waiting.pubkey === pubkey) waiting.resolve(false);
    if (pending) {
      const retiring = pending.then(async (session) => {
        try {
          await session.abort();
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally { session.dispose(); }
      }).catch(() => undefined);
      this.retiring.set(pubkey, retiring);
      void retiring.then(() => { if (this.retiring.get(pubkey) === retiring) this.retiring.delete(pubkey); });
    }
  }

  private async syncAgent(bot: BotRecord): Promise<void> {
    if (isCoder(bot)) this.isolation.prepare(bot.pubkey);
    const session = await this.sessions.get(bot.pubkey);
    if (session) {
      session.setSessionName(bot.name);
      this.disposeBot(bot.pubkey);
    } else {
      const dir = join(this.agentDir, "sessions", "yewholt-" + workspaceId(bot.pubkey));
      const recent = (await SessionManager.listAll(dir))[0];
      if (recent && recent.name !== bot.name) SessionManager.open(recent.path, dir).appendSessionInfo(bot.name);
    }
  }

  private async runTurn(bot: BotRecord, message: HumanMessage): Promise<void> {
    const turn: CodeTurn = {
      ...(message.relay ? { relay: message.relay } : {}), requestId: `nostr:${message.eventId}:${bot.pubkey}`,
      pubkey: bot.pubkey, channelId: message.channelId, eventId: message.eventId,
      author: message.authorPubkey, text: message.text, createdAt: message.createdAt,
    };
    this.activeTurns.set(bot.pubkey, turn);
    const drop = (reg: RegistryState) => { reg.turns = (reg.turns ?? []).filter((item) => item.requestId !== turn.requestId); };
    await this.harness.commit(async (tx) => {
      const reg = await tx.doc(RegistryDoc);
      reg.turns ??= [];
      reg.turns.push(turn);
    }, ctx);
    let spent = 0;
    let answer: string;
    try {
      const session = await this.botSession(bot.pubkey);
      const model = this.runtime.getModel(bot.provider, bot.modelId);
      if (!model) {
        answer = `${bot.name} is a Pi session on ${bot.modelLabel || "an unset model"}. Free-text answers need a provider API key and a pi-ai catalog id (provider/modelId).`;
      } else {
        await session.setModel(model);
        const before = session.messages.length;
        try { await session.prompt(message.text); }
        finally {
          spent = Math.max(this.options.turnTokens, session.messages.slice(before).reduce((sum, item) =>
            sum + (item.role === "assistant" ? item.usage.totalTokens : 0), 0));
        }
        const replies = session.messages.slice(before).filter((item) => item.role === "assistant");
        const last = replies.at(-1);
        const text = session.getLastAssistantText();
        const why = last?.role === "assistant" && last.stopReason === "error"
          ? failureReason("model_error", last.errorMessage) : last?.role === "assistant" && last.stopReason === "aborted"
            ? "aborted" : "empty_answer";
        answer = text && last?.role === "assistant" && !["error", "aborted"].includes(last.stopReason)
          ? text : `I could not answer that (${why}).`;
      }
    } catch (error) {
      answer = `I could not answer that (${failureReason("model_error", error instanceof Error ? error.message : error)}).`;
    } finally {
      this.activeTurns.delete(bot.pubkey);
    }
    await this.reply(bot, message, answer, spent, true, drop);
    this.notifyOutbox();
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

  private toolWorkspace(bot: BotRecord): (Roots & { homeAliases: string[] }) | { refusal: string } {
    const refusal = this.isolation.prepare(bot.pubkey);
    if (refusal) return { refusal };
    const home = this.options.home;
    let real = home;
    try { real = physicalPath(home); } catch { /* use configured path */ }
    return { home, workspace: this.isolation.workspace(bot.pubkey),
      homeAliases: real === home ? [] : [real], credentialFile: join(this.agentDir, "auth.json") };
  }

  private async requestApproval(bot: BotRecord, ask: ApprovalAsk): Promise<boolean> {
    const turn = this.activeTurns.get(bot.pubkey);
    if (!turn || this.closing) return false;
    const id = randomUUID().slice(0, 8);
    const event = this.chatEvent(bot, turn.channelId, approvalText(bot, ask, id));
    let resolve!: (allow: boolean) => void;
    const decision = new Promise<boolean>((done) => { resolve = done; });
    this.waiting.set(id, { pubkey: bot.pubkey, resolve });
    const timer = setTimeout(() => resolve(false), APPROVAL_TTL_MS);
    try {
      await this.harness.commit(async (tx) => {
        const reg = await tx.doc(RegistryDoc);
        reg.approvals ??= [];
        reg.approvals.push({
          id, pubkey: bot.pubkey, conversationId: bot.conversationId, taskId: 0, key: id,
          channelId: turn.channelId, tool: ask.tool, subject: ask.subject, reasons: ask.reasons,
          eventId: event.id, createdAt: Math.floor(this.options.now() / 1000),
        });
        reg.outbox.push(event);
      }, ctx);
      this.notifyOutbox();
      return await decision;
    } finally {
      clearTimeout(timer);
      this.waiting.delete(id);
      await this.harness.commit(async (tx) => {
        const reg = await tx.doc(RegistryDoc);
        reg.approvals = (reg.approvals ?? []).filter((item) => item.id !== id);
      }, ctx);
    }
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
    const waiting = this.waiting.get(request.id);
    this.waiting.delete(request.id);
    const result = waiting ? "delivered" : "ended";
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
    waiting?.resolve(allow);
    this.notifyOutbox();
  }

  private async noteOnly(bot: BotRecord, message: HumanMessage, text: string): Promise<void> {
    const pending = this.sessions.get(bot.pubkey);
    if (pending) (await pending).sessionManager.appendCustomEntry("yewholt.chat",
      { author: message.authorPubkey, text: message.text, reply: text });
  }
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
    lines.push("You may use installed skills, MCP servers and extension tools. The read tool is only for installed skill files; no shell or file writes.");
    return lines.join("\n");
  }
  lines.push(
    "code gives you your own workspace folder. It is your working directory and your $HOME; use relative paths there.",
    "Tools: read, write, edit and bash work in the workspace. tool_search finds and loads more tools when you need them.",
    "Inside the workspace you work freely. These wait until a person approves them in the chat: recursive deletes (rm -r), git push, piping a download into a shell, sudo/su/doas, any command that mentions the Yewholt state folder ($YEWHOLT_HOME, .yewholt), and write or edit outside the workspace. The call waits; a rejection comes back to you as a refusal.",
    "Reading or writing Yewholt's state folder is refused and cannot be approved. Your commands do not get the daemon's environment or its API keys.",
    "Installed skills, MCP servers and extension tools are available. Use only the permissions their owner granted.",
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
