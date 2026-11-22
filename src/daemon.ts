import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AgentFiles, PRESENCE, agentStatuses, type AgentDiagnostics, type AgentScan } from "./agents.js";
import { configuredRelays, loadConfig, type RelayConfig, type YewholtConfig } from "./config.js";
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
import { sameRelay } from "./relay-url.js";
import { ensureOwnerKey, Yewholt } from "./session.js";
import { Doze, requestWake, startWakeServer, WakeWatch, wakeSettings } from "./wake.js";

let stopping = false;

export async function runDaemon(home: string): Promise<void> {
  const config = loadConfig(home);
  const routes = configuredRelays(config);
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
  const wakeConfig = wakeSettings();
  const doze = new Doze(wakeConfig);
  process.on("SIGTERM", () => {
    stopping = true;
    doze.wake();
  });
  process.on("SIGINT", () => {
    stopping = true;
    doze.wake();
  });
  ensureOwnerKey(home);
  const session = await Yewholt.open(await openNodeSqliteStorage(sqlitePath(home)), { home, isolation, wakeUrl: wakeConfig.url });
  const wakeServer = wakeConfig.port === undefined ? undefined : startWakeServer(wakeConfig.port, () => doze.wake());
  const ownerSecret = readKey(ownerKeyPath(home));
  try {
    const defaults = {
      relayUrl: config.relayUrl,
      model: defaultModel() ?? { provider: "", modelId: "", label: "unset" },
    };
    const files = new AgentFiles(home, defaults);
    const control = new DeployControl(home, ownerSecret, defaults);
    let latest: AgentDiagnostics | undefined;
    let pending: AgentScan | null = null;
    const reconcile = async (force = false) => {
      pending = files.poll(force) ?? pending;
      if (!pending) return false;
      const previous = new Map((await session.snapshot()).bots.map((bot) => [bot.pubkey, bot.relayUrl]));
      pending.definitions = pending.definitions.filter((agent) => {
        const route = routes.find(({ relayUrl }) => sameRelay(relayUrl, agent.relayUrl));
        const old = previous.get(agent.pubkey);
        const reason = !route ? "relay is not configured"
          : old && !sameRelay(old, agent.relayUrl) ? "agent cannot change relay" : undefined;
        if (reason) {
          pending!.invalid.push({ id: agent.pubkey, pubkey: agent.pubkey, name: agent.name, reason });
          return false;
        }
        return control.reconcileHosted(agent);
      });
      await session.reconcileAgents(pending);
      latest = { invalid: pending.invalid, unavailable: pending.unavailable };
      pending = null;
      return true;
    };
    await reconcile();
    await session.resumeTurns();
    const links = new Map<string, BotLinks<BotRecord>>();
    const wake = new Set<() => void>();
    let sharedWork = Promise.resolve();
    const serialize: Serialize = (operation) => {
      const run = sharedWork.then(operation);
      sharedWork = run.then(() => undefined, () => undefined);
      return run;
    };
    const refreshStatus = () => writeStatus(home, session, config, control.pubkey, latest, links);
    await refreshStatus();
    session.setOutboxListener(() => { for (const notify of wake) notify(); });
    await Promise.all(routes.map(async (route, index) => {
      const primary = index === 0;
      const routeControl = new DeployControl(home, ownerSecret, { ...defaults, relayUrl: route.relayUrl },
        undefined, { primaryRelay: config.relayUrl });
      const loopback = primary && loopbackPort !== undefined ? { relayUrl: route.relayUrl, port: loopbackPort } : undefined;
      while (!stopping) {
        try {
          await serve(session, ownerSecret, route, primary, routeControl, reconcile, serialize, wake, links, refreshStatus, doze, loopback);
        } catch (error) {
          console.error(`relay loop ${route.relayUrl}:`, error instanceof Error ? error.message : error);
        }
        if (stopping) break;
        if (doze.asleep) await doze.untilWoken();
        else await sleep(2000);
      }
    }));
  } finally {
    wakeServer?.close();
    session.setOutboxListener(undefined);
    await session.close();
    removePid();
  }
}

type Serialize = <T>(operation: () => Promise<T>) => Promise<T>;

async function serve(
  session: Yewholt, ownerSecret: string, route: RelayConfig, primary: boolean, control: DeployControl,
  reconcile: (force?: boolean) => Promise<boolean>, serialize: Serialize, wake: Set<() => void>,
  linksByRelay: Map<string, BotLinks<BotRecord>>, refreshStatus: () => Promise<void>, doze: Doze, loopback?: RelayLoopback,
): Promise<void> {
  const { relayUrl, externalRelayPubkey } = route;
  const owner = new RelayClient(relayUrl, ownerSecret, undefined, true, loopback);
  const onRelay = (bot: BotRecord) => bot.external ? sameRelay(bot.relayUrl ?? "", relayUrl) : primary;
  const connectBot = (bot: BotRecord) => openBot(session, ownerSecret, relayUrl, bot, loopback);
  let links: BotLinks<BotRecord> | undefined;
  let notify: (() => void) | undefined;
  let work = Promise.resolve();
  let serving = true;
  let idle = false;
  let local = new Set<string>();
  const drain = (phase: OutboxPhase) => publishOutbox(session, ownerSecret, owner, links, connectBot, phase, onRelay, primary);
  const cursor = (state: Awaited<ReturnType<Yewholt["snapshot"]>>) =>
    primary ? state.highWater : state.highWaterByRelay?.[relayUrl];
  try {
    await owner.connect(5000);
    let highWater = cursor(await session.snapshot());
    const botLinks = new BotLinks<BotRecord>({
      relayPubkey: externalRelayPubkey,
      since: () => highWater || undefined,
      open: connectBot,
      onEvent: (event) => inbox.accept(event),
      onMembership: (pubkey, channels, direct) => session.setMemberChannels(pubkey, channels, direct),
      onDisconnect: (pubkey) => session.agentDisconnected(pubkey),
    });
    links = botLinks;
    linksByRelay.set(relayUrl, botLinks);
    let nextRetry = performance.now() + 2000;
    const maintain = (requestedSync: boolean, poll = false) => {
      if (!serving) return Promise.resolve();
      const run = work.then(async () => {
        const changed = poll && await serialize(() => reconcile());
        if (changed) for (const other of wake) if (other !== notify) other();
        let retry = false;
        if (poll && performance.now() >= nextRetry) {
          nextRetry = performance.now() + 2000;
          retry = (await session.snapshot()).bots.some((bot) => bot.external && onRelay(bot));
        }
        const sync = requestedSync || changed || retry;
        if (sync) {
          // Finish local identity events and external offline events before changing links.
          await drain("before-sync");
          const state = await session.snapshot();
          highWater = cursor(state);
          local = new Set(state.bots.map((bot) => bot.pubkey));
          await botLinks.sync(state.bots.filter((bot) => bot.external && onRelay(bot)));
        }
        // This also runs without incoming messages, on the normal daemon tick.
        const queued = await session.refreshAgentRuntime(botLinks.connectedAgents());
        if (sync || queued) await drain("connected-agents");
        if (sync || queued) await refreshStatus();
      });
      work = run.catch(() => undefined);
      return run;
    };
    const inbox = new Inbox((message) => {
      if (!serving) return;
      doze.touch();
      void session
        .handleHuman({ ...message, relay: { url: relayUrl, primary } })
        .then(() => { doze.touch(); return maintain(true); })
        .catch((error: unknown) => console.error("turn:", error instanceof Error ? error.message : error));
    });
    await maintain(true);
    // Approval requests and resumed code turns commit outside a chat message's handling.
    notify = () => {
      void maintain(true)
        .catch((error: unknown) => console.error("outbox:", error instanceof Error ? error.message : error));
    };
    wake.add(notify);
    if (externalRelayPubkey) {
      const watch = new WakeWatch(externalRelayPubkey, () => local, (url) => {
        void requestWake(url).then((ok) => { if (!ok) console.error("wake: no answer from an agent's wake URL"); });
      });
      owner.subscribe("wake-watch", watch.filters(Math.floor(Date.now() / 1000)), (event) => watch.accept(event));
    }
    owner.subscribe("deploy-control", [{ kinds: [CONTROL_KIND], "#p": [control.pubkey] }], (event) => {
      if (!serving || stopping) return;
      work = work.then(async () => {
        if (!serving || stopping || !owner.isOpen()) return;
        const reply = await serialize(() => control.handle(event, async (pubkey) =>
          (await session.snapshot()).bots.some((bot) => bot.pubkey === pubkey && !bot.external), {
          models: () => session.availableModelReferences(),
          hasModel: (choice) => session.hasModel(choice),
          publishProfile: async (agent, profile) => {
            const client = new RelayClient(relayUrl, agent.nsec, agent.authTag, false, loopback);
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
            await refreshStatus();
          },
          reconcileModel: async () => { await reconcile(true); await refreshStatus(); },
          reconcileRemoval: async (pubkey) => {
            await reconcile(true);
            try {
              await drain("before-sync");
            } finally {
              await session.forgetRemovedAgent(pubkey);
            }
            await botLinks.sync((await session.snapshot()).bots.filter(onRelay));
            await refreshStatus();
          },
        }));
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
      if (doze.due(session.busy())) {
        idle = true;
        break;
      }
      await sleep(500);
    }
  } finally {
    serving = false;
    if (notify) wake.delete(notify);
    try {
      await work;
      if ((stopping || idle) && links) {
        await session.offlineAgents(links.connectedAgents());
        await drain("offline");
      }
      if (idle) {
        doze.sleep();
        console.log(`relay ${relayUrl}: idle, connections closed until the wake URL is requested`);
      }
    } finally {
      linksByRelay.delete(relayUrl);
      await links?.closeAll();
      await owner.close();
      await refreshStatus();
    }
  }
}

/** A bot's own NIP-42 connection and its owner's delegation. */
async function openBot(session: Yewholt, ownerSecret: string, relayUrl: string, bot: BotRecord,
  loopback?: RelayLoopback): Promise<RelayClient> {
  const authTag = bot.authTag ?? ownerAuthTag(ownerSecret, bot.pubkey, "");
  const client = bot.external
    ? new ExternalRelayClient(relayUrl, session.botSecret(bot), authTag, true, loopback)
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
  onRelay: (bot: BotRecord) => boolean,
  primary: boolean,
): Promise<void> {
  const state = await session.snapshot();
  const ownerPubkey = pubkeyOf(ownerSecret);
  const bots = new Map(state.bots.map((bot) => [bot.pubkey, bot]));
  const pendingOffline = new Set(state.outbox.filter((event) => event.kind === PRESENCE && event.content === "offline").map((event) => event.pubkey));
  const events = state.outbox.filter((event) => {
    const bot = bots.get(event.pubkey);
    if (bot ? !onRelay(bot) : !primary || event.pubkey !== ownerPubkey) return false;
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
  diagnostics: AgentDiagnostics | undefined, links: ReadonlyMap<string, BotLinks<BotRecord>>): Promise<void> {
  const state = await session.snapshot();
  const body = {
    pid: process.pid,
    isolation: session.isolationStatus(),
    relayUrl: config.relayUrl,
    relays: configuredRelays(config).map(({ relayUrl }) => ({ relayUrl, connected: links.has(relayUrl) })),
    agents: agentStatuses(state.bots, diagnostics, { target, timestamps: lastDeploys(home) }),
    bots: state.bots.map((bot) => ({
      name: bot.name,
      pubkey: bot.pubkey,
      model: bot.modelLabel,
      provider: bot.provider,
      modelId: bot.modelId,
      scope: bot.scope,
      channels: [...links].find(([relay]) => sameRelay(relay, bot.relayUrl ?? config.relayUrl))?.[1].channels(bot.pubkey) ?? bot.scope,
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
