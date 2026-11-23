import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelChoice } from "./models.js";
import { pubkeyOf, signEvent, verifyAuthSignature, type NostrEvent } from "./nostr.js";
import { agentsDir } from "./paths.js";
import type { BotRecord } from "./registry.js";

type Defaults = { relayUrl: string; model: ModelChoice };

export type AgentProvisioning = Defaults & {
  pubkey: string;
  ownerPubkey: string;
  name: string;
  nsec: string;
  authTag: string[];
  permissions: string[];
  respondTo: string;
  respondToAllowlist: string[];
  channelId?: string;
};

export type AgentDefinition = AgentProvisioning & {
  mtimeMs: number;
  fileVersion: string;
};

type AgentIssue = { id: string; name: string; pubkey?: string; reason: string };
export type AgentScan = { definitions: AgentDefinition[]; present: Set<string>; invalid: AgentIssue[]; unavailable?: true };
export type AgentDiagnostics = Pick<AgentScan, "invalid" | "unavailable">;
export type AgentStatus = { name: string; pubkey: string; state: string; target?: string; lastDeploy?: string | null };
const hexKey = /^[0-9a-f]{64}$/;

export function listAgents(home: string, defaults: Defaults): AgentScan {
  const dir = agentsDir(home);
  const scan: AgentScan = { definitions: [], present: new Set(), invalid: [] };
  let entries: string[];
  try {
    const info = lstatSync(dir, { throwIfNoEntry: false });
    if (!info) return scan;
    if (!info.isDirectory()) return unavailableScan();
    entries = readdirSync(dir).sort();
  } catch {
    return unavailableScan();
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const expected = entry.slice(0, -5);
    scan.present.add(expected);
    const result = loadAgent(join(dir, entry), expected, defaults);
    if ("nsec" in result) scan.definitions.push(result);
    else scan.invalid.push({ ...result, id: fileId(entry) });
  }
  return scan;
}

function unavailableScan(): AgentScan {
  return {
    definitions: [], present: new Set(), unavailable: true,
    invalid: [{ id: "directory", name: "Agents directory", reason: "cannot read agents directory" }],
  };
}

function fileId(entry: string): string {
  return createHash("sha256").update(entry).digest("hex");
}

export function loadAgent(path: string, expected: string, defaults: Defaults): AgentDefinition | Omit<AgentIssue, "id"> {
  const invalid = (reason: string) => ({ name: "Provisioned agent", reason });
  let raw: string;
  let mtimeMs: number;
  let fileVersion: string;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd, { bigint: true });
      if (!info.isFile() || (info.mode & 0o7777n) !== 0o600n) return invalid("expected a regular file with mode 0600");
      mtimeMs = Number(info.mtimeNs) / 1_000_000;
      fileVersion = `${info.dev}:${info.ino}:${info.mtimeNs}`;
      raw = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return invalid("cannot read provisioning file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid("invalid JSON");
  }
  const validated = validateAgent(parsed, expected, defaults);
  return "nsec" in validated ? { ...validated, mtimeMs, fileVersion } : validated;
}

export function validateAgent(parsed: unknown, expected: string, defaults: Defaults): AgentProvisioning | Omit<AgentIssue, "id"> {
  let pubkey: string | undefined;
  let name = "Provisioned agent";
  const invalid = (reason: string) => ({ name, pubkey, reason });
  if (!object(parsed)) return invalid("expected a JSON object");
  const { nsec, authTag } = parsed;
  if (typeof nsec !== "string" || !hexKey.test(nsec)) return invalid("invalid nsec");
  let derived: string;
  try {
    derived = pubkeyOf(nsec);
  } catch {
    return invalid("invalid nsec");
  }
  if (expected !== derived) return invalid("filename does not match agent pubkey");
  pubkey = derived;
  if (!nonempty(parsed.name) || parsed.name.toLowerCase().includes(nsec)) return invalid("invalid name");
  name = parsed.name;
  let ownerPubkey: string | null = null;
  try {
    if (strings(authTag)) ownerPubkey = verifyAuthSignature(authTag, pubkey);
  } catch {
    // The crypto library can reject malformed keys/signatures by throwing.
  }
  if (!ownerPubkey || !strings(authTag) || authTag.some((value) => value.toLowerCase().includes(nsec))) return invalid("invalid auth tag");

  const relayUrl = parsed.relayUrl === undefined ? defaults.relayUrl : parsed.relayUrl;
  const model = parsed.model === undefined ? defaults.model : parsed.model;
  const permissions = parsed.permissions === undefined ? ["post", "read"] : parsed.permissions;
  const respondTo = parsed.respondTo === undefined ? "anyone" : parsed.respondTo;
  const respondToAllowlist = parsed.respondToAllowlist === undefined ? [] : parsed.respondToAllowlist;
  const channelId = parsed.channelId;
  if (!nonempty(relayUrl) || !websocketUrl(relayUrl)) return invalid("invalid relayUrl");
  if (!object(model) || ![model.provider, model.modelId, model.label].every((value) => typeof value === "string") ||
      (parsed.model !== undefined && ![model.provider, model.modelId, model.label].every(nonempty))) return invalid("invalid model");
  if (!strings(permissions)) return invalid("invalid permissions");
  if (typeof respondTo !== "string") return invalid("invalid respondTo");
  if (!strings(respondToAllowlist) || !respondToAllowlist.every((value) => hexKey.test(value))) return invalid("invalid respondToAllowlist");
  if (channelId !== undefined && !nonempty(channelId)) return invalid("invalid channelId");

  const safeModel = { provider: model.provider as string, modelId: model.modelId as string, label: model.label as string };
  const fields = [relayUrl, ...Object.values(safeModel), ...permissions, respondTo, ...respondToAllowlist, channelId ?? ""];
  if (fields.some((value) => value.toLowerCase().includes(nsec))) return invalid("secret repeated in provisioning fields");
  return { pubkey, ownerPubkey, name, nsec, authTag, relayUrl, model: safeModel, permissions, respondTo, respondToAllowlist, channelId };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function websocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "ws:" || url.protocol === "wss:") && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

/** The provider replaces files by rename, which changes the directory mtime. */
export class AgentFiles {
  private nextPoll = -Infinity;
  private stamp?: string;
  private readonly warned = new Set<string>();

  constructor(
    private readonly home: string,
    private readonly defaults: Defaults,
    private readonly now: () => number = () => performance.now(),
  ) {}

  poll(force = false): AgentScan | null {
    const now = this.now();
    if (!force && now < this.nextPoll) return null;
    this.nextPoll = now + 2000;
    let stamp: string;
    try {
      const info = lstatSync(agentsDir(this.home), { bigint: true, throwIfNoEntry: false });
      stamp = info ? `${info.ino}:${info.mtimeNs}` : "missing";
    } catch {
      stamp = "unavailable";
    }
    if (!force && stamp === this.stamp) return null;
    const scan = listAgents(this.home, this.defaults);
    // Retry directory errors even when the directory's mtime has not changed.
    this.stamp = scan.unavailable ? undefined : stamp;
    for (const issue of scan.invalid) {
      const key = `${issue.id}:${issue.reason}`;
      if (this.warned.has(key)) continue;
      this.warned.add(key);
      console.error(`external agent ${issue.pubkey?.slice(0, 8) ?? "(unknown)"}: ${issue.reason}`);
    }
    return scan;
  }
}

export function agentStatuses(bots: readonly BotRecord[], diagnostics?: AgentDiagnostics,
  deployment?: { target: string; timestamps: ReadonlyMap<string, number> }): AgentStatus[] {
  const external = bots.filter((bot) => bot.external);
  const deployFields = (pubkey?: string) => {
    if (!deployment) return {};
    const time = pubkey ? deployment.timestamps.get(pubkey) : undefined;
    return { target: deployment.target, lastDeploy: time ? new Date(time).toISOString() : null };
  };
  const known = new Map(external.filter((bot) => bot.status === "invalid").map((bot) => [fileId(`${bot.pubkey}.json`), bot]));
  const invalid: AgentStatus[] = (diagnostics?.invalid ?? []).map((issue) => {
    const bot = known.get(issue.id);
    return {
      name: issue.pubkey ? issue.name : bot?.name ?? issue.name,
      pubkey: (issue.pubkey ?? bot?.pubkey)?.slice(0, 8) ?? "unknown",
      state: `invalid:${issue.reason}`,
      ...deployFields(issue.pubkey ?? bot?.pubkey),
    };
  });
  if (diagnostics?.unavailable) {
    for (const bot of known.values()) {
      invalid.push({ name: bot.name, pubkey: bot.pubkey.slice(0, 8), state: "invalid:cannot read agents directory", ...deployFields(bot.pubkey) });
    }
  }
  return [
    ...external.filter((bot) => bot.status !== "invalid").map((bot) => ({
      name: bot.name, pubkey: bot.pubkey.slice(0, 8), state: bot.status,
      ...deployFields(bot.pubkey),
    })),
    ...invalid,
  ];
}

export const RUNTIME_PROFILE = 10100;
export const PRESENCE = 20001;

/** `wakeUrl`, when set, lets any awake daemon wake this agent's VM with a GET (see wake.ts). */
export function runtimeProfile(bot: BotRecord, nsec: string, createdAt: number, wakeUrl?: string): NostrEvent {
  return signEvent(nsec, RUNTIME_PROFILE, JSON.stringify({
    display_name: bot.name, name: bot.name, status: "online",
    respond_to: bot.respondTo, respond_to_allowlist: bot.respondToAllowlist, capabilities: [],
    ...(wakeUrl && { wake_url: wakeUrl, ...(bot.ownerPubkey && { owner: bot.ownerPubkey }) }),
  }), [], createdAt);
}

/** Kind 0 for the daemon's own key, so Buzz member lists show a name instead of a bare pubkey. */
export function daemonProfile(secret: string, name: string, createdAt?: number): NostrEvent {
  return signEvent(secret, 0, JSON.stringify({ name, display_name: name, about: "Yewholt daemon" }), [], createdAt);
}

export function daemonName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.YEWHOLT_NAME?.trim() || undefined;
}

export function presence(nsec: string, status: "online" | "offline", createdAt: number): NostrEvent {
  return signEvent(nsec, PRESENCE, status, [], createdAt);
}
