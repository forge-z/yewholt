import { readFileSync, writeFileSync } from "node:fs";
import { configPath } from "./paths.js";

export type YewholtConfig = {
  relayUrl: string;
  /** Public key the relay signs kind 39002 member lists with. */
  externalRelayPubkey: string;
};

export function saveConfig(home: string, config: YewholtConfig): void {
  writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
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
  return { relayUrl: config.relayUrl, externalRelayPubkey: config.externalRelayPubkey };
}
