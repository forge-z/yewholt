import { createServer, type Server } from "node:http";
import { isPubkey } from "./control-protocol.js";
import { MEMBER_LIST_KIND } from "./membership.js";
import type { NostrEvent } from "./nostr.js";

export const RUNTIME_PROFILE_KIND = 10100;
export const PRESENCE_KIND = 20001;

/** How long a daemon without a recent `online` presence counts as asleep. */
const PRESENCE_FRESH_MS = 150_000;
/** At most one wake request per URL in this window. */
const POKE_INTERVAL_MS = 60_000;
/** How often a channel feed re-reads its member lists to follow new channels. */
const FEED_REFRESH_MS = 60_000;
/** A member-list read with no EOSE by then means the connection is dead. */
const FEED_STALE_MS = 30_000;
/** Buzz's cap on channel ids one filter may name. */
const MAX_FEED_CHANNELS = 2048;
const SEEN_MESSAGES = 1024;

export type WakeSettings = {
  /** Public URL announced in each agent's runtime profile; a GET to it wakes this VM. */
  url?: string;
  /** Local port answering that URL; a request there makes an idle daemon reconnect. */
  port?: number;
  /** Quiet time before a wakeable daemon closes its relay connections. */
  idleMs: number;
  /** Always-on daemon that gets this daemon's agent keys before it dozes, to read their DMs. */
  watcher?: string;
};

export function wakeSettings(env: NodeJS.ProcessEnv = process.env): WakeSettings {
  const url = env.YEWHOLT_WAKE_URL?.trim() || undefined;
  if (url && !httpUrl(url)) throw new Error("YEWHOLT_WAKE_URL must be an http:// or https:// URL");
  const rawPort = env.YEWHOLT_WAKE_PORT?.trim();
  const port = rawPort ? Number(rawPort) : undefined;
  if (port !== undefined && (!/^\d+$/.test(rawPort ?? "") || port < 1 || port > 65535)) {
    throw new Error("YEWHOLT_WAKE_PORT must be a port number from 1 to 65535");
  }
  const rawIdle = env.YEWHOLT_IDLE_MINUTES?.trim();
  const minutes = rawIdle ? Number(rawIdle) : 10;
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("YEWHOLT_IDLE_MINUTES must be a positive number");
  const watcher = env.YEWHOLT_WATCHER_PUBKEY?.trim().toLowerCase() || undefined;
  if (watcher && !isPubkey(watcher)) throw new Error("YEWHOLT_WATCHER_PUBKEY must be a 64-character hex pubkey");
  return { url, port, idleMs: minutes * 60_000, ...(watcher && { watcher }) };
}

export function httpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * When a wakeable daemon may let its VM sleep. Only a daemon with both a wake
 * URL and a wake port dozes: otherwise nothing could bring it back.
 */
export class Doze {
  private last: number;
  private waiters: (() => void)[] = [];
  private awake = true;

  constructor(readonly settings: WakeSettings, private readonly now: () => number = Date.now) {
    this.last = now();
  }

  get enabled(): boolean {
    return this.settings.url !== undefined && this.settings.port !== undefined;
  }

  touch(): void {
    this.last = this.now();
  }

  /** Quiet for the idle time with no turn running. */
  due(busy: boolean): boolean {
    if (!this.enabled || busy) {
      if (busy) this.touch();
      return false;
    }
    return this.now() - this.last >= this.settings.idleMs;
  }

  get asleep(): boolean {
    return !this.awake;
  }

  /** Skipped when something touched the daemon since `due` said yes. */
  sleep(): void {
    if (this.now() - this.last >= this.settings.idleMs) this.awake = false;
  }

  /** Resolves on the next wake request, or at once when not dozing. */
  untilWoken(): Promise<void> {
    if (this.awake) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  wake(): void {
    this.touch();
    this.awake = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** Answers every request with 204 and wakes the daemon. It carries no data in either direction. */
export function startWakeServer(port: number, onWake: () => void): Server {
  const server = createServer((request, response) => {
    request.resume();
    onWake();
    response.writeHead(204, { "Cache-Control": "no-store" }).end();
  });
  server.on("error", (error) => console.error("wake server:", error.message));
  server.listen(port);
  return server;
}

type Agent = { url: string; respondTo?: string; allowlist?: string[]; owner?: string; profileAt: number };

/**
 * Watches the community for messages to agents whose daemon is asleep and
 * requests their wake URL. Agents announce the URL in their runtime profile
 * (kind 10100, `wake_url`); an agent with a fresh `online` presence is awake
 * and is left alone, so this never keeps a VM from sleeping.
 */
export class WakeWatch {
  private readonly agents = new Map<string, Agent>();
  /** Every runtime-profile author: messages from agents never wake anyone, so bots cannot wake each other in a loop. */
  private readonly profiled = new Set<string>();
  private readonly presence = new Map<string, { online: boolean; at: number }>();
  private readonly members = new Map<string, { at: number; id: string; pubkeys: Set<string> }>();
  private readonly poked = new Map<string, number>();
  /** The same message can arrive on the watcher's feed and on an agent's. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly relayPubkey: string,
    private readonly local: () => ReadonlySet<string>,
    private readonly poke: (url: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Profiles and presence. Channel messages come from a `ChannelFeed`: Buzz routes them live only by `#h`. */
  filters(since: number): Record<string, unknown>[] {
    return [
      { kinds: [RUNTIME_PROFILE_KIND] },
      { kinds: [PRESENCE_KIND], since },
    ];
  }

  accept(event: NostrEvent): void {
    if (event.kind === RUNTIME_PROFILE_KIND) this.onProfile(event);
    else if (event.kind === PRESENCE_KIND) this.presence.set(event.pubkey, { online: event.content === "online", at: this.now() });
    else if (event.kind === MEMBER_LIST_KIND) this.onMembers(event);
    else if (event.kind === 9) this.onMessage(event);
  }

  private onProfile(event: NostrEvent): void {
    const known = this.agents.get(event.pubkey);
    if (known && known.profileAt > event.created_at) return;
    this.profiled.add(event.pubkey);
    let content: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(event.content);
      content = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      content = {};
    }
    if (!httpUrl(content.wake_url)) {
      this.agents.delete(event.pubkey);
      return;
    }
    const allowlist = Array.isArray(content.respond_to_allowlist)
      ? content.respond_to_allowlist.filter((key): key is string => typeof key === "string") : undefined;
    this.agents.set(event.pubkey, {
      url: content.wake_url, profileAt: event.created_at,
      respondTo: typeof content.respond_to === "string" ? content.respond_to : undefined,
      allowlist, owner: typeof content.owner === "string" ? content.owner : undefined,
    });
  }

  private onMembers(event: NostrEvent): void {
    if (event.pubkey !== this.relayPubkey) return;
    const channel = event.tags.find((tag) => tag[0] === "d" && tag[1])?.[1];
    if (!channel) return;
    const current = this.members.get(channel);
    if (current && (current.at > event.created_at || (current.at === event.created_at && current.id < event.id))) return;
    const pubkeys = new Set(event.tags.filter((tag) => tag[0] === "p" && tag[1]).map((tag) => tag[1]));
    this.members.set(channel, { at: event.created_at, id: event.id, pubkeys });
  }

  private onMessage(event: NostrEvent): void {
    if (this.profiled.has(event.pubkey) || this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (this.seen.size > SEEN_MESSAGES) this.seen.delete(this.seen.values().next().value as string);
    const local = this.local();
    if (local.has(event.pubkey)) return;
    const channel = event.tags.find((tag) => tag[0] === "h" && tag[1])?.[1];
    const addressed = new Set(event.tags.filter((tag) => tag[0] === "p" && tag[1]).map((tag) => tag[1]));
    for (const pubkey of channel ? this.members.get(channel)?.pubkeys ?? [] : []) addressed.add(pubkey);
    const urls = new Set<string>();
    for (const pubkey of addressed) {
      const agent = this.agents.get(pubkey);
      if (!agent || local.has(pubkey) || this.awake(pubkey) || !answers(agent, event.pubkey)) continue;
      urls.add(agent.url);
    }
    for (const url of urls) {
      const last = this.poked.get(url);
      if (last !== undefined && this.now() - last < POKE_INTERVAL_MS) continue;
      this.poked.set(url, this.now());
      this.poke(url);
    }
  }

  private awake(pubkey: string): boolean {
    const seen = this.presence.get(pubkey);
    return seen !== undefined && seen.online && this.now() - seen.at < PRESENCE_FRESH_MS;
  }
}

function answers(agent: Agent, author: string): boolean {
  if (agent.respondTo === "anyone") return true;
  if (author === agent.owner) return true;
  if (agent.respondTo === "allowlist") return agent.allowlist?.includes(author) === true;
  return agent.owner === undefined;
}

/**
 * GET the wake URL until the VM answers. Providers that resume on traffic hold
 * the request or answer 503 with Retry-After while resuming. Any other answer,
 * even an error page, means the VM is running.
 */
type FeedClient = {
  subscribe(id: string, filters: readonly Record<string, unknown>[], onEvent: (event: NostrEvent) => void,
    onClosed?: (id: string, reason: string) => void, onEose?: () => void): void;
  unsubscribe(id: string): void;
};

/**
 * Live chat messages for a `WakeWatch`. Buzz delivers a channel's live events
 * only to filters naming it in `#h`, so the feed reads the member lists this
 * connection can see (all readable channels, or `member`'s own, DMs included)
 * and subscribes to kind 9 by `#h`, re-reading every minute to follow new
 * channels. A read that never ends means a dead socket: `onStale` fires.
 */
export class ChannelFeed {
  private channels: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly client: FeedClient,
    private readonly accept: (event: NostrEvent) => void,
    private readonly relayPubkey: string,
    private readonly member: string | undefined,
    private readonly onStale: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), FEED_REFRESH_MS);
    this.timer.unref?.();
  }

  refresh(): void {
    if (this.stopped || this.pending) return;
    const ids = new Set<string>();
    this.pending = setTimeout(() => {
      this.pending = undefined;
      if (!this.stopped) this.onStale();
    }, FEED_STALE_MS);
    this.pending.unref?.();
    const done = () => {
      clearTimeout(this.pending);
      this.pending = undefined;
    };
    const filter = { kinds: [MEMBER_LIST_KIND], authors: [this.relayPubkey], ...(this.member && { "#p": [this.member] }) };
    this.client.subscribe("wake-lists", [filter], (event) => {
      this.accept(event);
      const channel = event.tags.find((tag) => tag[0] === "d" && tag[1])?.[1];
      if (event.pubkey === this.relayPubkey && channel) ids.add(channel);
    }, done, () => {
      done();
      this.client.unsubscribe("wake-lists");
      if (!this.stopped) this.follow([...ids].sort().slice(0, MAX_FEED_CHANNELS));
    });
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.pending);
    this.pending = undefined;
  }

  private follow(channels: string[]): void {
    const key = channels.join(",");
    if (key === this.channels) return;
    this.channels = key;
    if (channels.length === 0) {
      this.client.unsubscribe("wake-messages");
      return;
    }
    // A little overlap so nothing falls between two subscriptions; WakeWatch drops repeats.
    const since = Math.floor(this.now() / 1000) - 5;
    this.client.subscribe("wake-messages", [{ kinds: [9], "#h": channels, since }], this.accept, () => {
      this.channels = undefined;
    });
  }
}

export async function requestWake(url: string, fetchApi: typeof fetch = fetch, timeoutMs = 120_000,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let retryMs = 3000;
    try {
      const response = await fetchApi(url, {
        method: "GET", redirect: "manual", headers: { "Accept-Encoding": "identity" },
        signal: AbortSignal.timeout(Math.max(1000, Math.min(60_000, deadline - Date.now()))),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status !== 503 && response.status !== 502 && response.status !== 504) return true;
      const after = Number(response.headers.get("retry-after"));
      if (Number.isFinite(after) && after > 0) retryMs = Math.min(after * 1000, 30_000);
    } catch {
      // still resuming or unreachable; try again until the deadline
    }
    await delay(retryMs);
  }
  return false;
}
