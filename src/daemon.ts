import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadConfig, saveConfig, type YewholtConfig } from "./config.js";
import { readKey } from "./keys.js";
import { BotLinks, Inbox, publishAll } from "./bridge.js";
import { accepted, RelayClient } from "./nostr-client.js";
import { ownerAuthTag, pubkeyOf, signEvent } from "./nostr.js";
import { botKeyPath, ownerKeyPath, pidPath, sqlitePath, statusPath } from "./paths.js";
import { createChannelTags, readRelayPubkey } from "./relay.js";
import { ensureOwnerKey, Yewholt } from "./session.js";

let stopping = false;

export async function runDaemon(home: string): Promise<void> {
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
  const session = await Yewholt.open(await openNodeSqliteStorage(sqlitePath(home)), { home });
  const ownerSecret = readKey(ownerKeyPath(home));
  try {
    while (!stopping) {
      try {
        await serve(home, session, ownerSecret);
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

async function serve(home: string, session: Yewholt, ownerSecret: string): Promise<void> {
  const config = loadConfig(home);
  const owner = new RelayClient(config.relayUrl, ownerSecret);
  let links: BotLinks | undefined;
  await owner.connect();
  try {
    if (!config.channelId) {
      const channelId = randomUUID();
      const created = signEvent(ownerSecret, 9007, "", createChannelTags(channelId, config.channelName));
      const result = await owner.publish(created);
      if (!accepted(result)) throw new Error(`create channel: ${result.message}`);
      config.channelId = channelId;
      saveConfig(home, config);
    }
    const channelId = config.channelId;
    await session.ensureOnboarding(channelId);
    await publishOutbox(home, session, ownerSecret, owner, links, config);
    let highWater = (await session.snapshot()).highWater;
    const botLinks = new BotLinks({
      relayPubkey: relayKey(home),
      since: () => highWater || undefined,
      open: (bot) => openBot(home, ownerSecret, config.relayUrl, bot.pubkey),
      onEvent: (event) => inbox.accept(event),
      onMembership: (pubkey, channels) => session.setMemberChannels(pubkey, channels),
    });
    links = botLinks;
    const sync = async () => {
      const state = await session.snapshot();
      highWater = state.highWater;
      await botLinks.sync(state.bots);
    };
    // One inbox for every connection: a message seen by several bots is handled once.
    // The channel comes from the event's h tag.
    const inbox = new Inbox((message) => {
      void session
        .handleHuman(message)
        .then(() => publishOutbox(home, session, ownerSecret, owner, links, config))
        .then(sync)
        .then(() => writeStatus(home, session, config.relayUrl, channelId, links))
        .catch((error: unknown) => console.error("turn:", error instanceof Error ? error.message : error));
    });
    await sync();
    await writeStatus(home, session, config.relayUrl, channelId, links);
    owner.subscribe("channel", [{ kinds: [9], "#h": [channelId] }], inbox.accept);
    while (!stopping && owner.isOpen()) {
      const lost = botLinks.lost();
      if (lost) throw new Error(`bot connection lost: ${lost.name}`);
      await sleep(500);
    }
  } finally {
    await links?.closeAll();
    await owner.close();
  }
}

/** A bot's own NIP-42 connection: its key plus the owner's unconstrained NIP-OA tag. */
async function openBot(home: string, ownerSecret: string, relayUrl: string, pubkey: string): Promise<RelayClient> {
  const client = new RelayClient(relayUrl, readKey(botKeyPath(home, pubkey)), ownerAuthTag(ownerSecret, pubkey, ""));
  try {
    await client.connect();
  } catch (error) {
    await client.close();
    throw error;
  }
  return client;
}

let relayKeyWarned = false;

/** Relay public key for trusting kind 39002, or null (fail closed, logged once per process). */
function relayKey(home: string): string | null {
  const key = readRelayPubkey(home);
  if (key.ok) return key.pubkey;
  if (!relayKeyWarned) {
    relayKeyWarned = true;
    console.error(`relay key: ${key.reason}; ignoring kind 39002 membership, bots use their stored scope only`);
  }
  return null;
}

/**
 * Drain the outbox. Each event goes out on its signer's own connection: the owner's,
 * or the bot's persistent link. A bot without a link (just created, or stopped) gets
 * a temporary connection, as before.
 */
async function publishOutbox(
  home: string,
  session: Yewholt,
  ownerSecret: string,
  owner: RelayClient,
  links: BotLinks | undefined,
  config: YewholtConfig,
): Promise<void> {
  const state = await session.snapshot();
  const ownerPubkey = pubkeyOf(ownerSecret);
  const acked = await publishAll(
    state.outbox,
    ownerPubkey,
    (pubkey) => (pubkey === ownerPubkey ? owner : links?.client(pubkey)),
    async (pubkey) => {
      if (pubkey === ownerPubkey) throw new Error("owner connection is closed");
      return openBot(home, ownerSecret, config.relayUrl, pubkey);
    },
  );
  await session.ackOutbox(acked);
}

async function writeStatus(home: string, session: Yewholt, relayUrl: string, channelId: string, links?: BotLinks): Promise<void> {
  const state = await session.snapshot();
  const body = {
    pid: process.pid,
    relayUrl,
    channelId,
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
    pending: state.pending?.summary ?? null,
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
