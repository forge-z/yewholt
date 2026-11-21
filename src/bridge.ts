import { MEMBER_LIST_KIND, directChannels, effectiveScope, memberChannels, newestMemberLists } from "./membership.js";
import { accepted } from "./nostr-client.js";
import type { NostrEvent } from "./nostr.js";
import type { HumanMessage } from "./session.js";
import type { BotRecord } from "./registry.js";

/** Relay-side bookkeeping between the daemon's connections and the session. No sockets here. */

export type OkResult = { ok: boolean; message: string };

/** The part of RelayClient the bridge uses. Tests pass a fake. */
export interface ChatClient {
  subscribe(
    id: string,
    filters: readonly Record<string, unknown>[],
    onEvent: (event: NostrEvent) => void,
    onClosed?: (id: string, reason: string) => void,
  ): void;
  unsubscribe(id: string): void;
  publish(event: NostrEvent): Promise<OkResult>;
  close(): Promise<void>;
  isOpen(): boolean;
}

export type LinkBot = Pick<BotRecord, "pubkey" | "name" | "status" | "external" | "relayUrl" | "authTag"> & { scope: readonly string[] };

const SEEN_CAP = 10_000;
const HOSTED_MEMBERS_REFRESH_MS = 10_000;

/** A kind 9 as the session sees it. The channel is the event's own `h` tag. */
export function humanMessageFrom(event: NostrEvent): HumanMessage | null {
  if (event.kind !== 9 || typeof event.id !== "string") return null;
  const channelId = event.tags?.find((tag) => tag[0] === "h" && typeof tag[1] === "string" && tag[1] !== "")?.[1];
  if (!channelId) return null;
  const message: HumanMessage = {
    channelId,
    authorPubkey: event.pubkey,
    eventId: event.id,
    text: event.content ?? "",
    createdAt: event.created_at,
  };
  // Replies (NIP-10 `e` tags) let a person answer one approval request among several.
  const replyTo = event.tags?.filter((tag) => tag[0] === "e" && typeof tag[1] === "string" && tag[1] !== "").map((tag) => tag[1]!) ?? [];
  if (replyTo.length > 0) message.replyTo = replyTo;
  return message;
}

/**
 * One inbox for every connection (owner and each bot). The same event id seen on
 * several connections, or replayed on one, is handed on once.
 */
export class Inbox {
  private readonly seen = new Set<string>();

  constructor(private readonly onMessage: (message: HumanMessage) => void) {}

  readonly accept = (event: NostrEvent): void => {
    if (!event || typeof event.id !== "string" || this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.values().next().value!);
    const message = humanMessageFrom(event);
    if (message) this.onMessage(message);
  };
}

type LinkOptions = {
  relayPubkey: string | null;
  /** NIP-01 `since` for kind 9 subscriptions (inclusive). Omitted when undefined or 0. */
  since?: () => number | undefined;
  onEvent: (event: NostrEvent) => void;
  onMembership: (pubkey: string, channels: ReadonlySet<string>, direct: ReadonlySet<string>) => void;
};

/**
 * One bot's persistent connection. Subscriptions:
 * - `members`: kind 39002 `#p` = this bot. The relay sends every member list that names it.
 * - `members-d`: kind 39002 `#d` = channels it is a member of, so the newer list that
 *   no longer names it (removal in the app) is seen too. `#p` alone would miss it.
 * - `chat:<channel>`: kind 9 `#h` = one effective channel each, so a relay CLOSED
 *   ("restricted: not a channel member") on one channel does not silence the others.
 */
class BotLink<T extends LinkBot> {
  private lists = new Map<string, NostrEvent>();
  private nextMembersRefresh = 0;
  private member: ReadonlySet<string> = new Set();
  private direct: ReadonlySet<string> = new Set();
  private stored: string[];
  /** Channel -> the exact subscription id currently open for it. */
  private readonly chat = new Map<string, string>();
  private readonly refused = new Set<string>();
  private memberD: string[] = [];
  private memberDId: string | undefined;
  /** Fresh suffix per subscription, so a late CLOSED for an old REQ cannot match a live one. */
  private counter = 0;

  constructor(
    public bot: T,
    readonly client: ChatClient,
    private readonly options: LinkOptions,
  ) {
    this.stored = [...bot.scope];
  }

  start(): void {
    this.refreshMembers();
    this.refresh();
  }

  refreshMembers(): void {
    if (!this.options.relayPubkey) return;
    const now = performance.now();
    if (now < this.nextMembersRefresh) return;
    this.nextMembersRefresh = now + HOSTED_MEMBERS_REFRESH_MS;
    this.client.subscribe("members", [{ kinds: [MEMBER_LIST_KIND], "#p": [this.bot.pubkey] }], this.onList);
  }

  channels(): string[] {
    return effectiveScope(this.stored, this.member);
  }

  setStoredScope(scope: readonly string[]): void {
    if (sameList(scope, this.stored)) return;
    this.stored = [...scope];
    this.refresh();
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private readonly onList = (event: NostrEvent): void => {
    const relay = this.options.relayPubkey;
    if (!relay || event?.kind !== MEMBER_LIST_KIND || event.pubkey !== relay) return;
    this.lists = newestMemberLists([...this.lists.values(), event], relay);
    const next = memberChannels(this.lists.values(), this.bot.pubkey, relay);
    const direct = this.bot.external ? directChannels(this.lists.values(), this.bot.pubkey, relay) : new Set<string>();
    if (sameList([...next], [...this.member]) && sameList([...direct], [...this.direct])) return;
    for (const channel of next) if (!this.member.has(channel)) this.refused.delete(channel);
    this.member = next;
    this.direct = direct;
    this.options.onMembership(this.bot.pubkey, next, direct);
    this.refresh();
  };

  private refresh(): void {
    const want = this.channels();
    for (const [channel, id] of [...this.chat]) {
      if (want.includes(channel)) continue;
      this.chat.delete(channel);
      this.client.unsubscribe(id);
    }
    for (const channel of want) {
      if (this.chat.has(channel) || this.refused.has(channel)) continue;
      const filter: Record<string, unknown> = { kinds: [9], "#h": [channel] };
      const since = this.options.since?.();
      if (since) filter.since = since;
      const id = `chat:${channel}#${++this.counter}`;
      this.chat.set(channel, id);
      this.client.subscribe(id, [filter], this.options.onEvent, () => {
        // RelayClient already logged the reason. Do not retry until the relay lists us there.
        if (this.chat.get(channel) !== id) return;
        this.chat.delete(channel);
        this.refused.add(channel);
      });
    }
    if (!this.options.relayPubkey) return;
    const d = want.filter((channel) => this.member.has(channel));
    if (sameList(d, this.memberD)) return;
    if (this.memberD.length > 0 && this.memberDId) this.client.unsubscribe(this.memberDId);
    this.memberD = d;
    if (d.length > 0) {
      const id = `members-d#${++this.counter}`;
      this.memberDId = id;
      this.client.subscribe(id, [{ kinds: [MEMBER_LIST_KIND], "#d": d }], this.onList, () => {
        if (this.memberDId !== id) return;
        this.memberD = [];
        this.memberDId = undefined;
      });
    }
  }
}

export type BotLinksOptions<T extends LinkBot = LinkBot> = LinkOptions & {
  /** Open and authenticate a connection with the bot's own key (and owner NIP-OA tag). */
  open: (bot: T) => Promise<ChatClient>;
  onDisconnect?: (pubkey: string) => void;
};

/** Every active bot's persistent connection while `serve` runs. */
export class BotLinks<T extends LinkBot = LinkBot> {
  private readonly links = new Map<string, BotLink<T>>();
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: BotLinksOptions<T>) {}

  /** Open links for active bots, close links for bots that are not, apply stored scope changes. Serialized. */
  sync(bots: readonly T[]): Promise<void> {
    const run = this.chain.then(() => this.apply(bots));
    this.chain = run.catch(() => undefined);
    return run;
  }

  client(pubkey: string): ChatClient | undefined {
    return this.links.get(pubkey)?.client;
  }

  channels(pubkey: string): string[] {
    return this.links.get(pubkey)?.channels() ?? [];
  }

  connectedAgents(): string[] {
    return [...this.links.values()].filter((link) => link.bot.external && link.client.isOpen()).map((link) => link.bot.pubkey);
  }

  /** A daemon-created bot whose connection dropped. External links reconnect independently. */
  lost(): T | undefined {
    for (const link of this.links.values()) if (!link.bot.external && !link.client.isOpen()) return link.bot;
    return undefined;
  }

  /** Close every link. Later syncs (a turn that finishes after `serve` ended) open nothing. */
  async closeAll(): Promise<void> {
    this.closed = true;
    await this.chain;
    for (const [pubkey, link] of [...this.links]) await this.drop(pubkey, link);
  }

  private async apply(bots: readonly T[]): Promise<void> {
    if (this.closed) return;
    const active = new Map(bots.filter((bot) => bot.status === "active").map((bot) => [bot.pubkey, bot]));
    for (const [pubkey, link] of [...this.links]) {
      const bot = active.get(pubkey);
      if (!bot || (bot.external && (!link.client.isOpen() || bot.relayUrl !== link.bot.relayUrl ||
          !sameList(bot.authTag ?? [], link.bot.authTag ?? [])))) await this.drop(pubkey, link);
    }
    for (const bot of active.values()) {
      const existing = this.links.get(bot.pubkey);
      if (existing) {
        existing.bot = bot;
        existing.setStoredScope(bot.scope);
        // Buzz can store a new DM's member list without delivering it to the live REQ.
        if (bot.external) existing.refreshMembers();
        continue;
      }
      let client: ChatClient;
      try {
        client = await this.options.open(bot);
      } catch (error) {
        console.error(`bot connect ${bot.name} ${bot.pubkey.slice(0, 8)}:`, error instanceof Error ? error.message : error);
        continue;
      }
      const link = new BotLink(bot, client, this.options);
      this.links.set(bot.pubkey, link);
      link.start();
    }
  }

  private async drop(pubkey: string, link: BotLink<T>): Promise<void> {
    this.links.delete(pubkey);
    this.options.onMembership(pubkey, new Set(), new Set());
    this.options.onDisconnect?.(pubkey);
    try {
      await link.close();
    } catch {
      // already closed
    }
  }
}

/**
 * Publish outbox events, each on its signer's own open connection (owner events
 * first, as before). A signer without one gets a temporary connection that is
 * closed afterwards. Returns the ids the relay accepted.
 */
export async function publishAll(
  events: readonly NostrEvent[],
  ownerPubkey: string,
  connectionFor: (pubkey: string) => ChatClient | undefined,
  openTemporary: (pubkey: string) => Promise<ChatClient>,
): Promise<string[]> {
  const ordered = [...events].sort((a, b) => Number(b.pubkey === ownerPubkey) - Number(a.pubkey === ownerPubkey));
  const temporary = new Map<string, ChatClient>();
  const failed = new Set<string>();
  const acked: string[] = [];
  try {
    for (const event of ordered) {
      let client = connectionFor(event.pubkey);
      if (client && !client.isOpen()) client = undefined;
      client ??= temporary.get(event.pubkey);
      if (!client) {
        if (failed.has(event.pubkey)) continue;
        try {
          client = await openTemporary(event.pubkey);
          temporary.set(event.pubkey, client);
        } catch (error) {
          failed.add(event.pubkey);
          console.error(`bot connect ${event.pubkey}:`, error instanceof Error ? error.message : error);
          continue;
        }
      }
      const result = await client.publish(event);
      if (accepted(result)) acked.push(event.id);
      else console.error(`publish ${event.kind} ${event.id}: ${result.message}`);
    }
  } finally {
    for (const client of temporary.values()) await client.close();
  }
  return acked;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
