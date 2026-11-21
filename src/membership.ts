import type { NostrEvent } from "./nostr.js";

/** NIP-29 group members list. Buzz signs it with the relay key (`BUZZ_RELAY_PRIVATE_KEY`). */
export const MEMBER_LIST_KIND = 39002;

/**
 * Newest trusted member list per channel (`d` tag). Only events whose pubkey is
 * the relay key count; with no relay key nothing is trusted (fail closed).
 * Newest is the larger created_at; on a tie the lower id wins (NIP-01 rule for
 * addressable events). Signatures are not re-verified here: the relay checked
 * them on ingest and these arrive over our own authenticated connection.
 */
export function newestMemberLists(events: Iterable<NostrEvent>, relayPubkey: string | null): Map<string, NostrEvent> {
  const newest = new Map<string, NostrEvent>();
  if (!relayPubkey) return newest;
  for (const event of events) {
    if (event.kind !== MEMBER_LIST_KIND || event.pubkey !== relayPubkey) continue;
    const channel = event.tags.find((tag) => tag[0] === "d" && typeof tag[1] === "string" && tag[1] !== "")?.[1];
    if (!channel) continue;
    const current = newest.get(channel);
    if (!current || newer(event, current)) newest.set(channel, event);
  }
  return newest;
}

/** Channel ids whose newest trusted list names `botPubkey` in a `p` tag, any role. Sorted. */
export function memberChannels(events: Iterable<NostrEvent>, botPubkey: string, relayPubkey: string | null): Set<string> {
  const channels: string[] = [];
  for (const [channel, event] of newestMemberLists(events, relayPubkey)) {
    if (event.tags.some((tag) => tag[0] === "p" && tag[1] === botPubkey)) channels.push(channel);
  }
  return new Set(channels.sort());
}

/** Two distinct members on the newest trusted list make a direct conversation. */
export function directChannels(events: Iterable<NostrEvent>, botPubkey: string, relayPubkey: string | null): Set<string> {
  const channels: string[] = [];
  for (const [channel, event] of newestMemberLists(events, relayPubkey)) {
    const members = new Set(event.tags.filter((tag) => tag[0] === "p" && tag[1]).map((tag) => tag[1]));
    if (members.size === 2 && members.has(botPubkey)) channels.push(channel);
  }
  return new Set(channels.sort());
}

/** Stored scope first, then member channels not already in it. Stored records are not changed. */
export function effectiveScope(stored: readonly string[], member: ReadonlySet<string> | undefined): string[] {
  const out = [...new Set(stored)];
  for (const channel of member ?? []) if (!out.includes(channel)) out.push(channel);
  return out;
}

function newer(a: NostrEvent, b: NostrEvent): boolean {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at;
  return a.id < b.id;
}
