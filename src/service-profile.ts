import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { record } from "./control-files.js";
import { accepted, type RelayClient } from "./nostr-client.js";
import { signEvent, unixNow, verifyEvent, type NostrEvent } from "./nostr.js";

const NOTICE = "Yewholt service key. Do not remove.";
const LEGACY_DAEMON_ABOUT = "Yewholt daemon";

export function serviceProfileName(role: string, host = hostname()): string {
  const label = host.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 90);
  return "Yewholt · " + role + (label ? " (" + label + ")" : "");
}

export function serviceProfileEvent(secret: string, defaultName: string, current?: NostrEvent,
  options: { name?: string; legacyDaemonName?: string; tags?: string[][]; managedTags?: readonly string[]; createdAt?: number } = {}): NostrEvent | undefined {
  let profile: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(current?.content ?? "{}");
    if (record(value)) profile = value;
  } catch { /* Replace invalid profile content. */ }
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
  const oldAbout = text(profile.about);
  const legacy = options.legacyDaemonName !== undefined &&
    profile.name === options.legacyDaemonName && profile.display_name === options.legacyDaemonName &&
    (oldAbout === LEGACY_DAEMON_ABOUT || oldAbout === NOTICE);
  const override = options.name ?? (legacy ? defaultName : undefined);
  const name = text(profile.display_name) ?? text(profile.name) ?? defaultName;
  const about = oldAbout?.includes(NOTICE) ? oldAbout
    : oldAbout && oldAbout !== LEGACY_DAEMON_ABOUT ? oldAbout + "\n\n" + NOTICE : NOTICE;
  const tags = [...(current?.tags ?? []).filter(([tag]) => tag === undefined || !options.managedTags?.includes(tag)), ...(options.tags ?? [])];
  const next = { ...profile, display_name: override ?? text(profile.display_name) ?? name,
    name: override ?? text(profile.name) ?? name, about };
  if (JSON.stringify(next) === JSON.stringify(profile) && JSON.stringify(tags) === JSON.stringify(current?.tags)) return;
  return signEvent(secret, 0, JSON.stringify(next), tags, Math.max(options.createdAt ?? unixNow(), (current?.created_at ?? -1) + 1));
}

export async function readLatestProfiles(client: Pick<RelayClient, "subscribe" | "unsubscribe">,
  authors: ReadonlySet<string>, timeoutMs = 3_000): Promise<Map<string, NostrEvent>> {
  const id = "yewholt-profile-" + randomUUID();
  let timer: NodeJS.Timeout | undefined;
  const profiles = new Map<string, NostrEvent>();
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Relay profile lookup timed out")), timeoutMs);
      client.subscribe(id, [{ kinds: [0], authors: [...authors], limit: authors.size }], (event) => {
        try {
          if (event.kind !== 0 || !authors.has(event.pubkey) || !Number.isSafeInteger(event.created_at) || !verifyEvent(event)) return;
        } catch {
          return;
        }
        const current = profiles.get(event.pubkey);
        if (!current || event.created_at > current.created_at ||
            (event.created_at === current.created_at && event.id < current.id)) profiles.set(event.pubkey, event);
      }, () => reject(new Error("Relay refused the profile lookup")), resolve);
    });
    return profiles;
  } finally {
    clearTimeout(timer);
    client.unsubscribe(id);
  }
}

export async function publishServiceProfile(client: Pick<RelayClient, "subscribe" | "unsubscribe" | "publish">, pubkey: string,
  build: (current?: NostrEvent) => NostrEvent | undefined, timeoutMs = 3_000): Promise<void> {
  const current = await readLatestProfiles(client, new Set([pubkey]), timeoutMs);
  const event = build(current.get(pubkey));
  if (!event) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      client.publish(event),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Relay service profile publication timed out")), timeoutMs);
      }),
    ]);
    if (!accepted(result)) throw new Error("Relay rejected the service profile");
  } finally {
    clearTimeout(timer);
  }
}
