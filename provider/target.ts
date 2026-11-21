import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { record } from "../src/control-files.js";
import { isPubkey } from "../src/control-protocol.js";
import { normalizeRelay } from "../src/relay-url.js";

export type Wake = { kind: "command"; cmd: string } | { kind: "instabox"; accountId: string; machineId: string };
export type Target = { label: string; transport: "relay"; relay: string; daemonPubkey: string; wake?: Wake };

export function providerHome(): string {
  return process.env.YEWHOLT_PROVIDER_HOME ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "yewholt");
}

export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
}

export function relayUrl(value: unknown): value is string {
  return typeof value === "string" && normalizeRelay(value) === value;
}

export class InvalidTargetRelay extends Error {
  constructor(id: string) {
    super(`Invalid relay URL for target ${id}. Use one scheme (ws://, wss://, http:// or https://) and a valid host. Re-run yewholt targets add ${id} --relay <url> --daemon <pubkey> with any existing label and wake options.`);
  }
}

export function privateJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.size > 32 * 1024) throw new Error("Invalid private file");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

function only(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function parseWake(value: unknown): Wake | undefined {
  if (value === undefined) return;
  if (record(value)) {
    if (value.kind === "command" && only(value, ["kind", "cmd"]) && typeof value.cmd === "string" &&
        value.cmd.trim() && !value.cmd.includes("\0")) return { kind: value.kind, cmd: value.cmd };
    if (value.kind === "instabox" && only(value, ["kind", "accountId", "machineId"]) &&
        validId(value.accountId) && validId(value.machineId)) {
      return { kind: value.kind, accountId: value.accountId, machineId: value.machineId };
    }
  }
  throw new Error("Invalid wake configuration");
}

export function loadTarget(id: string, home = providerHome()): Target {
  return validateTarget(id, privateJson(targetFile(id, home)));
}

export function targetFile(id: string, home = providerHome()): string {
  if (!validId(id)) throw new Error("Invalid target id");
  return join(home, "targets", id + ".json");
}

export function validateTarget(id: string, value: unknown): Target {
  if (record(value) && value.id === id && typeof value.label === "string" && value.label.trim()) {
    const { transport, label, relay, daemonPubkey } = value;
    if (transport === "relay" && only(value, ["id", "label", "transport", "relay", "daemonPubkey", "wake"])) {
      const normalized = normalizeRelay(relay);
      if (!normalized) throw new InvalidTargetRelay(id);
      if (isPubkey(daemonPubkey)) return { transport, label, relay: normalized, daemonPubkey, wake: parseWake(value.wake) };
    }
  }
  throw new Error("Invalid target configuration");
}
