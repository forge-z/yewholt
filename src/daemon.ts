import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadConfig, saveConfig, type YewholtConfig } from "./config.js";
import { readKey } from "./keys.js";
import { accepted, RelayClient } from "./nostr-client.js";
import { ownerAuthTag, pubkeyOf, signEvent } from "./nostr.js";
import { botKeyPath, ownerKeyPath, pidPath, sqlitePath, statusPath } from "./paths.js";
import { createChannelTags } from "./relay.js";
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
    await publishOutbox(home, session, ownerSecret, owner, config);
    await writeStatus(home, session, config.relayUrl, channelId);
    const seen = new Set<string>();
    owner.subscribe("channel", [{ kinds: [9], "#h": [channelId] }], (event) => {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      void session
        .handleHuman({
          channelId,
          authorPubkey: event.pubkey,
          eventId: event.id,
          text: event.content ?? "",
          createdAt: event.created_at,
        })
        .then(() => publishOutbox(home, session, ownerSecret, owner, config))
        .then(() => writeStatus(home, session, config.relayUrl, channelId))
        .catch((error: unknown) => console.error("turn:", error instanceof Error ? error.message : error));
    });
    while (!stopping && owner.isOpen()) await sleep(500);
  } finally {
    await owner.close();
  }
}

async function publishOutbox(
  home: string,
  session: Yewholt,
  ownerSecret: string,
  owner: RelayClient,
  config: YewholtConfig,
): Promise<void> {
  const state = await session.snapshot();
  const ownerPubkey = pubkeyOf(ownerSecret);
  const events = [...state.outbox].sort((a, b) => Number(b.pubkey === ownerPubkey) - Number(a.pubkey === ownerPubkey));
  const clients = new Map<string, RelayClient>([[ownerPubkey, owner]]);
  const acked: string[] = [];
  try {
    for (const event of events) {
      let client = clients.get(event.pubkey);
      if (!client) {
        try {
          client = new RelayClient(config.relayUrl, readKey(botKeyPath(home, event.pubkey)), ownerAuthTag(ownerSecret, event.pubkey, ""));
          await client.connect();
          clients.set(event.pubkey, client);
        } catch (error) {
          console.error(`bot connect ${event.pubkey}:`, error instanceof Error ? error.message : error);
          continue;
        }
      }
      const result = await client.publish(event);
      if (accepted(result)) acked.push(event.id);
      else console.error(`publish ${event.kind} ${event.id}: ${result.message}`);
    }
  } finally {
    for (const [pubkey, client] of clients) {
      if (pubkey !== ownerPubkey) await client.close();
    }
  }
  await session.ackOutbox(acked);
}

async function writeStatus(home: string, session: Yewholt, relayUrl: string, channelId: string): Promise<void> {
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
