import { homedir } from "node:os";
import { join } from "node:path";

/** State directory. Override with YEWHOLT_HOME or `yewholt --home`. */
export function yewholtHome(explicit?: string): string {
  return explicit ?? process.env.YEWHOLT_HOME ?? join(homedir(), ".yewholt");
}

export function secretsDir(home: string): string {
  return join(home, "secrets");
}

export function ownerKeyPath(home: string): string {
  return join(secretsDir(home), "owner.key");
}

export function botKeyPath(home: string, pubkey: string): string {
  return join(secretsDir(home), "bots", `${pubkey}.key`);
}

export function agentsDir(home: string): string {
  return join(home, "agents");
}

export function sqlitePath(home: string): string {
  return join(home, "state", "sessions.sqlite");
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

export function statusPath(home: string): string {
  return join(home, "status.json");
}

export function pidPath(home: string): string {
  return join(home, "daemon.pid");
}

export function logPath(home: string): string {
  return join(home, "daemon.log");
}

/** Host configuration and provider keys for the daemon. */
export function envFilePath(home: string): string {
  return join(home, ".env");
}
