import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { envFilePath } from "./paths.js";

const HEADER = `# Yewholt provider keys. Optional. This file is mode 0600.
# A variable already set in the environment wins over this file.
# See the repository .env.example for every provider.
# YEWHOLT_MODEL=opencode/big-pickle
# OPENCODE_API_KEY=
`;

/** Create `~/.yewholt/.env` when it is missing, and force mode 0600. */
export function ensureEnvFile(home: string): string {
  const path = envFilePath(home);
  try {
    readFileSync(path);
  } catch {
    writeFileSync(path, HEADER, { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  return path;
}

/**
 * Load KEY=value lines into `env`. Existing non-empty entries are left alone
 * so a shell or service manager can override the file. Empty values are ignored.
 */
export function loadEnvFile(home: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = envFilePath(home);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // The daemon can still read a file it does not own.
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (env[key]?.trim()) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!value.trim()) continue;
    env[key] = value;
  }
}
