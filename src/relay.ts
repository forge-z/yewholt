import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { generateKeyPair } from "./nostr.js";
import { relayDir } from "./paths.js";

export type RelayConfig = {
  port: number;
  relayUrl: string;
  ownerPubkey: string;
};

/** Path to the vendored official compose file inside this package. */
export function bundledComposeFile(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../relay/compose.yml");
}

/**
 * Write the env file the official bundle expects (`deploy/compose/.env.example`).
 * Secrets are generated once and kept mode 0600. The relay image is not modified.
 */
export function writeRelayEnv(home: string, config: RelayConfig, relaySecretHex: string): void {
  const dir = relayDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  copyFileSync(bundledComposeFile(), join(dir, "compose.yml"));
  const password = randomBytes(24).toString("hex");
  const body = [
    "BUZZ_IMAGE=ghcr.io/block/buzz:0.3.0",
    "BUZZ_DOMAIN=localhost",
    `RELAY_URL=${config.relayUrl}`,
    `BUZZ_MEDIA_BASE_URL=http://127.0.0.1:${config.port}/media`,
    "BUZZ_MEDIA_SERVER_DOMAIN=127.0.0.1",
    `BUZZ_CORS_ORIGINS=http://127.0.0.1:${config.port}`,
    "BUZZ_REQUIRE_AUTH_TOKEN=true",
    "BUZZ_REQUIRE_RELAY_MEMBERSHIP=true",
    "BUZZ_ALLOW_NIP_OA_AUTH=true",
    "BUZZ_AUTO_MIGRATE=true",
    "BUZZ_GIT_CONFORMANCE_PROBE=true",
    "BUZZ_PUSH_ENABLED=false",
    "BUZZ_PUSH_GATEWAY_DELIVERY_URL=https://push.buzz.xyz/v1/deliveries/apns",
    "RUST_LOG=buzz_relay=info,buzz_db=info,buzz_auth=info",
    `RELAY_OWNER_PUBKEY=${config.ownerPubkey}`,
    `BUZZ_RELAY_PRIVATE_KEY=${relaySecretHex}`,
    `BUZZ_GIT_HOOK_HMAC_SECRET=${randomBytes(32).toString("hex")}`,
    "POSTGRES_DB=buzz",
    "POSTGRES_USER=buzz",
    `POSTGRES_PASSWORD=${password}`,
    `REDIS_PASSWORD=${randomBytes(24).toString("hex")}`,
    `BUZZ_S3_ACCESS_KEY=${randomBytes(12).toString("hex")}`,
    `BUZZ_S3_SECRET_KEY=${randomBytes(24).toString("hex")}`,
    "BUZZ_S3_BUCKET=buzz-media",
    "BUZZ_S3_ADDRESSING_STYLE=path",
    `BUZZ_HTTP_PORT=${config.port}`,
    "",
  ].join("\n");
  const path = join(dir, ".env");
  writeFileSync(path, body, { mode: 0o600 });
}

export function newRelaySecret(): string {
  return generateKeyPair().secret;
}

export async function compose(home: string, args: string[]): Promise<void> {
  const dir = relayDir(home);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", ["compose", "-p", "yewholt", "-f", "compose.yml", "--env-file", ".env", ...args], {
      cwd: dir,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker compose ${args.join(" ")} exited ${code}`));
    });
  });
}

export async function relayHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_liveness`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForRelay(port: number, timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await relayHealthy(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Buzz relay did not become healthy on :${port}`);
}

/** kind 9007, matching buzz-sdk `build_create_channel` (h, name, visibility, channel_type). */
export function createChannelTags(channelId: string, name: string): string[][] {
  return [
    ["h", channelId],
    ["name", name],
    ["visibility", "open"],
    ["channel_type", "stream"],
  ];
}
