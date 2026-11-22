import { readFileSync } from "node:fs";
import { writePrivateJson } from "./control-files.js";
import { isPubkey } from "./control-protocol.js";
import { configPath } from "./paths.js";
import { normalizeRelay, sameRelay } from "./relay-url.js";

export type RelayConfig = {
  relayUrl: string;
  /** Public key the relay signs kind 39002 member lists with. */
  externalRelayPubkey: string;
};

export type YewholtConfig = RelayConfig & { relays?: RelayConfig[] };

export function configuredRelays(config: YewholtConfig): RelayConfig[] {
  return [config, ...(config.relays ?? [])];
}

export function saveConfig(home: string, config: YewholtConfig): void {
  writePrivateJson(configPath(home), config);
}

/** The stored file as written, which may predate the external relay requirement. */
export function readConfig(home: string): Partial<YewholtConfig> {
  return JSON.parse(readFileSync(configPath(home), "utf8")) as Partial<YewholtConfig>;
}

export function loadConfig(home: string): YewholtConfig {
  const config = readConfig(home);
  if (!config.relayUrl || !config.externalRelayPubkey) {
    throw new Error("This home was installed for the removed bundled relay. Run yh install --relay <url> to adopt the relay it runs on.");
  }
  const { relayUrl, externalRelayPubkey, relays } = config;
  const routes = [{ relayUrl, externalRelayPubkey }];
  if (relays !== undefined) {
    if (!Array.isArray(relays)) throw new Error("Invalid additional relay configuration");
    for (const route of relays) {
      if (!route || normalizeRelay(route.relayUrl) !== route.relayUrl || !isPubkey(route.externalRelayPubkey) ||
          routes.some((other) => sameRelay(other.relayUrl, route.relayUrl))) {
        throw new Error("Invalid or duplicate additional relay configuration");
      }
      routes.push(route);
    }
  }
  return { relayUrl, externalRelayPubkey, relays };
}
