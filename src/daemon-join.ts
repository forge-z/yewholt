import { configuredRelays, loadConfig, saveConfig } from "./config.js";
import { discoverRelayPubkey } from "./relay-discovery.js";
import { sameRelay } from "./relay-url.js";

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
