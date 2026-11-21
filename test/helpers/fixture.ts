import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { NostrEvent } from "../../src/nostr.js";

/** Verbatim capture from the live Buzz relay. Read-only. */
const path = fileURLToPath(new URL("../../../test/fixtures/buzz-membership-20261121.json", import.meta.url));

type Capture = {
  owner_req_private_channel_closed: [string, string, string];
  events_seen_by_bot_key: NostrEvent[];
  events_seen_by_owner_key: NostrEvent[];
};

export function capture(): Capture {
  return JSON.parse(readFileSync(path, "utf8")) as Capture;
}

export const RELAY = "ba84bd729501e811cfa977b2b08e137e2c680dbb158e89a3d4d19291ebd01828";
export const OWNER = "34dc7e841f2f234b30d78450a63d0eae1f31353afb81a6f71231e7acb90d641d";
export const ADMIN = "5637d12aaf60b013eebd7fc1f0a10ea689a252f05f38247a370c2d2dcdd40c54";
export const CODER = "d0f5216753ec23182567cbf8b5ff2f04afeda8dd7f685d44322925c8381cc555";
export const INSTALL = "9784e5ec-925b-4e1e-af91-ce7bb6ef2268";
export const PRIVATE = "50fb784e-b7a8-43a3-a5ed-306f88629f65";

export function botEvents(): NostrEvent[] {
  return capture().events_seen_by_bot_key;
}

export function byKind(kind: number, d?: string): NostrEvent {
  const event = botEvents().find((item) => item.kind === kind && (d === undefined || item.tags.some((tag) => (tag[0] === "d" || tag[0] === "h") && tag[1] === d)));
  if (!event) throw new Error(`fixture has no kind ${kind} ${d ?? ""}`);
  return event;
}

/**
 * The fixture's private-channel 39002, as the relay would re-issue it after the
 * app removes Coder: same tags in the same order, Coder's p tag dropped, newer
 * created_at, id recomputed. The relay signature is kept as-is (we hold no relay
 * secret); membership trusts the relay pubkey, it does not re-verify signatures.
 */
export function privateListWithoutCoder(bump = 60): NostrEvent {
  const base = byKind(39002, PRIVATE);
  const tags = base.tags.filter((tag) => !(tag[0] === "p" && tag[1] === CODER));
  const created_at = base.created_at + bump;
  const id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, base.pubkey, created_at, base.kind, tags, base.content]))));
  return { ...base, tags, created_at, id };
}
