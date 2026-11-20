import { readFileSync, writeFileSync } from "node:fs";
import { configPath } from "./paths.js";

export type YewholtConfig = {
  port: number;
  relayUrl: string;
  channelId: string | null;
  channelName: string;
};

export function saveConfig(home: string, config: YewholtConfig): void {
  writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function loadConfig(home: string): YewholtConfig {
  return JSON.parse(readFileSync(configPath(home), "utf8")) as YewholtConfig;
}
