import { generateKeyPair, signEvent, type NostrEvent } from "../../src/nostr.js";

const relay = generateKeyPair();
const admin = generateKeyPair();
const owner = generateKeyPair();
export const RELAY = relay.pubkey;
export const ADMIN = admin.pubkey;
export const OWNER = owner.pubkey;
export const CODER = generateKeyPair().pubkey;
export const INSTALL = "66666666-6666-4666-8666-666666666666";
export const PRIVATE = "55555555-5555-4555-8555-555555555555";
export const NOT_A_CHANNEL_MEMBER = "restricted: not a channel member";

const start = 1_700_000_000;
const events = [
  signEvent(relay.secret, 39002, "", [
    ["d", PRIVATE], ["t", "stream"], ["P", RELAY],
    ["p", ADMIN, "", "owner"], ["p", CODER, "", "member"],
  ], start + 10),
  signEvent(admin.secret, 9000, "", [["h", PRIVATE], ["p", CODER], ["role", "member"]], start + 10),
  signEvent(admin.secret, 9007, "", [
    ["h", PRIVATE], ["name", "Code"], ["visibility", "private"], ["channel_type", "stream"],
  ], start + 5),
  signEvent(owner.secret, 9000, "", [["h", INSTALL], ["p", CODER], ["role", "bot"]], start),
  signEvent(relay.secret, 39002, "", [
    ["d", INSTALL], ["t", "stream"], ["P", RELAY],
    ["p", OWNER, "", "owner"], ["p", CODER, "", "bot"], ["p", ADMIN, "", "admin"],
  ], start),
  signEvent(admin.secret, 9, "@Coder please reply OK", [["h", PRIVATE], ["p", CODER]], start + 20),
];

export function botEvents(): NostrEvent[] {
  return structuredClone(events);
}

export function byKind(kind: number, d?: string): NostrEvent {
  const event = botEvents().find((item) => item.kind === kind && (d === undefined || item.tags.some((tag) => (tag[0] === "d" || tag[0] === "h") && tag[1] === d)));
  if (!event) throw new Error(`fixture has no kind ${kind} ${d ?? ""}`);
  return event;
}

export function privateListWithoutCoder(bump = 60): NostrEvent {
  const base = byKind(39002, PRIVATE);
  const tags = base.tags.filter((tag) => !(tag[0] === "p" && tag[1] === CODER));
  return signEvent(relay.secret, base.kind, base.content, tags, base.created_at + bump);
}
