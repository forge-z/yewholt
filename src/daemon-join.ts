import { chmodSync, mkdirSync } from "node:fs";
import { configuredRelays, loadConfig, readConfig, saveConfig, type RelayConfig } from "./config.js";
import { ensureEnvFile } from "./env-file.js";
import { readKey, writeKey } from "./keys.js";
import { pubkeyOf } from "./nostr.js";
import { ownerKeyPath } from "./paths.js";
import { discoverRelayPubkey } from "./relay-discovery.js";
import { sameRelay } from "./relay-url.js";

export function initializeDaemon(home: string, config: RelayConfig): { pubkey: string; envFile: string } {
  let existing;
  try {
    existing = readConfig(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing && (existing.relayUrl !== config.relayUrl || existing.externalRelayPubkey !== config.externalRelayPubkey)) {
    throw new Error("This home already has a primary relay; use yh relay add to configure additional relays");
  }

  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const key = ownerKeyPath(home);
  let pubkey: string;
  try {
    pubkey = pubkeyOf(readKey(key));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    pubkey = writeKey(key).pubkey;
  }
  const envFile = ensureEnvFile(home);
  if (!existing) saveConfig(home, config);
  return { pubkey, envFile };
}

export async function configureJoinedRelay(home: string, relayUrl: string, secret: string, expected?: string,
  discover = discoverRelayPubkey): Promise<boolean> {
  const config = loadConfig(home);
  const existing = configuredRelays(config).find((entry) => sameRelay(entry.relayUrl, relayUrl));
  if (existing && expected !== undefined && expected !== existing.externalRelayPubkey) {
    throw new Error("This relay is already configured with a different signing key");
  }
  const externalRelayPubkey = await discover(relayUrl, secret, expected ?? existing?.externalRelayPubkey);
  if (existing) return false;
  saveConfig(home, { ...config, relays: [...(config.relays ?? []), { relayUrl, externalRelayPubkey }] });
  return true;
}
