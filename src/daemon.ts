import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AgentFiles, PRESENCE, agentStatuses, type AgentDiagnostics, type AgentScan } from "./agents.js";
import { loadConfig, type YewholtConfig } from "./config.js";
import { CONTROL_KIND } from "./control-protocol.js";
import { DeployControl, lastDeploys } from "./deploy-control.js";
import { WorkspaceIsolation } from "./isolation.js";
import { readKey } from "./keys.js";
import { BotLinks, Inbox, publishAll } from "./bridge.js";
import { accepted, RelayClient, type RelayLoopback } from "./nostr-client.js";
import { ownerAuthTag, pubkeyOf, type NostrEvent } from "./nostr.js";
import { defaultModel } from "./models.js";
import { ownerKeyPath, pidPath, sqlitePath, statusPath } from "./paths.js";
import type { BotRecord } from "./registry.js";
import { ensureOwnerKey, Yewholt } from "./session.js";

let stopping = false;

export async function runDaemon(home: string): Promise<void> {
  const localPort = process.env.YEWHOLT_LOCAL_PORT?.trim();
  const loopbackPort = localPort ? Number(localPort) : undefined;
  if (loopbackPort !== undefined && (!/^\d+$/.test(localPort ?? "") || loopbackPort < 1 || loopbackPort > 65535)) {
    throw new Error("YEWHOLT_LOCAL_PORT must be a port number from 1 to 65535");
  }
  const isolation = new WorkspaceIsolation(home);
  isolation.start();
  mkdirSync(dirname(sqlitePath(home)), { recursive: true });
  writeFileSync(pidPath(home), `${process.pid}\n`);
  const removePid = () => {
    try {
      unlinkSync(pidPath(home));
    } catch {
      // already gone
    }
  };
  process.on("SIGTERM", () => {
    stopping = true;
  });
  process.on("SIGINT", () => {
    stopping = true;
  });
  ensureOwnerKey(home);
  const session = await Yewholt.open(await openNodeSqliteStorage(sqlitePath(home)), { home, isolation });
  const ownerSecret = readKey(ownerKeyPath(home));
  try {
    const defaults = {
      relayUrl: loadConfig(home).relayUrl,
      model: defaultModel() ?? { provider: "", modelId: "", label: "unset" },
    };
    const files = new AgentFiles(home, defaults);
    const control = new DeployControl(home, ownerSecret, defaults);
    let latest: AgentDiagnostics | undefined;
    let pending: AgentScan | null = null;
    const reconcile = async (force = false) => {
      pending = files.poll(force) ?? pending;
      if (!pending) return false;
      pending.definitions = pending.definitions.filter((agent) => control.reconcileHosted(agent));
      await session.reconcileAgents(pending);
      latest = { invalid: pending.invalid, unavailable: pending.unavailable };
      pending = null;
      return true;
    };
    let resumed = false;
    while (!stopping) {
      try {
        await reconcile();
        if (!resumed) {
          resumed = true;
          // Reattach to durable turns after their external keys and stop states are reconciled.
          void session.resumeTurns().catch((error: unknown) => console.error("resume:", error instanceof Error ? error.message : error));
        }
        await serve(home, session, ownerSecret, control, reconcile, () => latest, loopbackPort);
      } catch (error) {
        console.error("relay loop:", error instanceof Error ? error.message : error);
        await sleep(2000);
      }
    }
  } finally {
    await session.close();
    removePid();
  }
}

async function serve(
  home: string, session: Yewholt, ownerSecret: string, control: DeployControl,
  reconcile: (force?: boolean) => Promise<boolean>, agentDiagnostics: () => AgentDiagnostics | undefined, loopbackPort?: number,
): Promise<void> {
  const config = loadConfig(home);
  await writeStatus(home, session, config, control.pubkey, agentDiagnostics());
  const loopback = loopbackPort === undefined ? undefined : { relayUrl: config.relayUrl, port: loopbackPort };
  const owner = new RelayClient(config.relayUrl, ownerSecret, undefined, true, loopback);
  const connectBot = (bot: BotRecord) => openBot(session, ownerSecret, config.relayUrl, bot, loopback);
  let links: BotLinks<BotRecord> | undefined;
  let work = Promise.resolve();
  let serving = true;
  const drain = (phase: OutboxPhase) => publishOutbox(session, ownerSecret, owner, links, connectBot, phase);
  try {
    await owner.connect();
    let highWater = (await session.snapshot()).highWater;
    const botLinks = new BotLinks<BotRecord>({
      relayPubkey: config.externalRelayPubkey,
      since: () => highWater || undefined,
      open: connectBot,
      onEvent: (event) => inbox.accept(event),
      onMembership: (pubkey, channels, direct) => session.setMemberChannels(pubkey, channels, direct),
      onDisconnect: (pubkey) => session.agentDisconnected(pubkey),
    });
    links = botLinks;
    let nextRetry = performance.now() + 2000;
    const maintain = (requestedSync: boolean, poll = false) => {
      if (!serving) return Promise.resolve();
      const run = work.then(async () => {
        const changed = poll && await reconcile();
        let retry = false;
        if (poll && performance.now() >= nextRetry) {
          nextRetry = performance.now() + 2000;
          retry = (await session.snapshot()).bots.some((bot) => bot.external);
        }
        const sync = requestedSync || changed || retry;
        if (sync) {
          // Finish local identity events and external offline events before changing links.
          await drain("before-sync");
          const state = await session.snapshot();
          highWater = state.highWater;
          await botLinks.sync(state.bots.filter((bot) => bot.external));
        }
        // This also runs without incoming messages, on the normal daemon tick.
        const queued = await session.refreshAgentRuntime(botLinks.connectedAgents());
        if (sync || queued) await drain("connected-agents");
        if (sync || queued) await writeStatus(home, session, config, control.pubkey, agentDiagnostics(), botLinks);
      });
      work = run.catch(() => undefined);
      return run;
    };
    // One inbox for every connection: a message seen by several bots is handled once.
    // The channel comes from the event's h tag.
    const inbox = new Inbox((message) => {
      if (!serving) return;
      void session
        .handleHuman(message)
        .then(() => maintain(true))
        .catch((error: unknown) => console.error("turn:", error instanceof Error ? error.message : error));
    });
    await maintain(true);
    // Approval requests and resumed code turns commit outside a chat message's handling.
    session.setOutboxListener(() => {
      void maintain(true)
        .catch((error: unknown) => console.error("outbox:", error instanceof Error ? error.message : error));
    });
    owner.subscribe("deploy-control", [{ kinds: [CONTROL_KIND], "#p": [control.pubkey] }], (event) => {
      if (!serving || stopping) return;
      work = work.then(async () => {
        if (!serving || stopping || !owner.isOpen()) return;
        const reply = await control.handle(event, async (pubkey) =>
          (await session.snapshot()).bots.some((bot) => bot.pubkey === pubkey && !bot.external), {
          models: () => session.availableModelReferences(),
          hasModel: (choice) => session.hasModel(choice),
          publishProfile: async (agent, profile) => {
            const client = new RelayClient(agent.relayUrl, agent.nsec, agent.authTag, false, loopback);
            try {
              await agentRelayDeadline(client.connect());
              const result = await agentRelayDeadline(client.publish(profile));
              if (!accepted(result)) throw new Error("hosted profile rejected");
            } finally {
              await client.close();
            }
          },
          updateName: async (pubkey, name) => {
            await session.updateHostedName(pubkey, name);
            await writeStatus(home, session, config, control.pubkey, agentDiagnostics(), botLinks);
          },
          reconcileModel: async () => {
            await reconcile(true);
            await writeStatus(home, session, config, control.pubkey, agentDiagnostics(), botLinks);
          },
          reconcileRemoval: async (pubkey) => {
            await reconcile(true);
            try {
              await drain("before-sync");
            } finally {
              await session.forgetRemovedAgent(pubkey);
            }
            await botLinks.sync((await session.snapshot()).bots);
            await writeStatus(home, session, config, control.pubkey, agentDiagnostics(), botLinks);
          },
        });
        if (!reply) return;
        const result = await agentRelayDeadline(owner.publish(reply));
        if (!accepted(result)) console.error("control: confirmation rejected by relay");
      }).catch(() => {
        console.error("control: unable to send confirmation");
        void owner.close();
      });
    });
    while (!stopping && owner.isOpen()) {
      const lost = botLinks.lost();
      if (lost) throw new Error(`bot connection lost: ${lost.name}`);
      await maintain(false, true);
      await sleep(500);
    }
  } finally {
    serving = false;
    session.setOutboxListener(undefined);
    try {
      await work;
      if (stopping && links) {
        await session.offlineAgents(links.connectedAgents());
        await drain("offline");
        await writeStatus(home, session, config, control.pubkey, agentDiagnostics());
      }
    } finally {
      await links?.closeAll();
      await owner.close();
    }
  }
}

/** A bot's own NIP-42 connection and its owner's delegation. */
async function openBot(session: Yewholt, ownerSecret: string, relayUrl: string, bot: BotRecord,
  loopback?: RelayLoopback): Promise<RelayClient> {
  const authTag = bot.authTag ?? ownerAuthTag(ownerSecret, bot.pubkey, "");
  const client = bot.external
    ? new ExternalRelayClient(bot.relayUrl ?? relayUrl, session.botSecret(bot), authTag, true, loopback)
    : new RelayClient(relayUrl, session.botSecret(bot), authTag, true, loopback);
  try {
    if (bot.external) await agentRelayDeadline(client.connect());
    else await client.connect();
  } catch (error) {
    await client.close();
    if (bot.external) throw new Error("external agent relay authentication failed");
    throw error;
  }
  return client;
}

class ExternalRelayClient extends RelayClient {
  override async publish(event: NostrEvent) {
    try {
      const result = await agentRelayDeadline(super.publish(event));
      return accepted(result) ? { ok: true, message: "" } : { ok: false, message: "external agent event rejected" };
    } catch {
      await this.close();
      return { ok: false, message: "external agent relay did not acknowledge event" };
    }
  }
}

async function agentRelayDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("external agent relay timed out")), 5000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type OutboxPhase = "before-sync" | "connected-agents" | "offline";

/** Publish local traffic and offline presence before link changes, then traffic on active external links. */
async function publishOutbox(
  session: Yewholt,
  ownerSecret: string,
  owner: RelayClient,
  links: BotLinks<BotRecord> | undefined,
  connectBot: (bot: BotRecord) => Promise<RelayClient>,
  phase: OutboxPhase,
): Promise<void> {
  const state = await session.snapshot();
  const ownerPubkey = pubkeyOf(ownerSecret);
  const bots = new Map(state.bots.map((bot) => [bot.pubkey, bot]));
  const pendingOffline = new Set(state.outbox.filter((event) => event.kind === PRESENCE && event.content === "offline").map((event) => event.pubkey));
  const events = state.outbox.filter((event) => {
    const bot = bots.get(event.pubkey);
    const offline = event.kind === PRESENCE && event.content === "offline";
    if (!bot?.external) return phase === "before-sync";
    if (!session.hasAgentKey(bot.pubkey)) return false;
    if (phase !== "connected-agents") return offline;
    return !pendingOffline.has(bot.pubkey) && bot.status === "active" && links?.client(bot.pubkey)?.isOpen() === true;
  });
  if (events.length === 0) return;
  const acked = await publishAll(
    events,
    ownerPubkey,
    (pubkey) => (pubkey === ownerPubkey ? owner : links?.client(pubkey)),
    async (pubkey) => {
      if (pubkey === ownerPubkey) throw new Error("owner connection is closed");
      const bot = bots.get(pubkey);
      if (!bot) throw new Error("bot record unavailable");
      return connectBot(bot);
    },
  );
  await session.ackOutbox(acked);
}

async function writeStatus(home: string, session: Yewholt, config: YewholtConfig, target: string,
  diagnostics?: AgentDiagnostics, links?: BotLinks<BotRecord>): Promise<void> {
  const state = await session.snapshot();
  const body = {
    pid: process.pid,
    isolation: session.isolationStatus(),
    relayUrl: config.relayUrl,
    agents: agentStatuses(state.bots, diagnostics, { target, timestamps: lastDeploys(home) }),
    bots: state.bots.map((bot) => ({
      name: bot.name,
      pubkey: bot.pubkey,
      model: bot.modelLabel,
      provider: bot.provider,
      modelId: bot.modelId,
      scope: bot.scope,
      channels: links?.channels(bot.pubkey) ?? bot.scope,
      permissions: bot.permissions,
      status: bot.status,
      role: bot.role,
      spentTokens: bot.spentTokens,
      limitTokens: bot.limitTokens,
      conversationId: bot.conversationId,
    })),
    approvals: (state.approvals ?? []).map((item) => ({ id: item.id, pubkey: item.pubkey, channelId: item.channelId, tool: item.tool, subject: item.subject })),
    outbox: state.outbox.length,
  };
  writeFileSync(statusPath(home), `${JSON.stringify(body, null, 2)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readPid(home: string): number | null {
  try {
    const pid = Number(readFileSync(pidPath(home), "utf8").trim());
    if (!Number.isInteger(pid)) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}
