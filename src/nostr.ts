import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** A signed NIP-01 event. Tags are string arrays, as on the wire. */
export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type KeyPair = {
  secret: string;
  pubkey: string;
};

const text = new TextEncoder();

export function generateKeyPair(): KeyPair {
  const secret = schnorr.utils.randomSecretKey();
  return { secret: bytesToHex(secret), pubkey: bytesToHex(schnorr.getPublicKey(secret)) };
}

export function pubkeyOf(secretHex: string): string {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(secretHex)));
}

/**
 * NIP-OA auth tag. The owner signs SHA-256(`nostr:agent-auth:` || agent || `:` || conditions).
 * Empty conditions authorize every kind. A `kind=N` condition is checked by clients
 * against the event that carries the tag (docs/nips/NIP-OA.md).
 */
export function ownerAuthTag(ownerSecretHex: string, agentPubkey: string, conditions = ""): string[] {
  const ownerPubkey = pubkeyOf(ownerSecretHex);
  if (ownerPubkey === agentPubkey) throw new Error("NIP-OA rejects self-attestation");
  const preimage = `nostr:agent-auth:${agentPubkey}:${conditions}`;
  const digest = sha256(text.encode(preimage));
  const sig = schnorr.sign(digest, hexToBytes(ownerSecretHex));
  return ["auth", ownerPubkey, conditions, bytesToHex(sig)];
}

/** Verify a NIP-OA tag against an event pubkey and created_at. Returns the owner pubkey or null. */
export function verifyAuthTag(tag: readonly string[], eventPubkey: string, createdAt: number, kind: number): string | null {
  return authConditionsMatch(tag[2] ?? "", createdAt, kind) ? verifyAuthSignature(tag, eventPubkey) : null;
}

/** Verify the delegation itself. A consumer of a particular event also checks its conditions. */
export function verifyAuthSignature(tag: readonly string[], eventPubkey: string): string | null {
  if (tag.length !== 4 || tag[0] !== "auth") return null;
  const [, owner, conditions, sig] = tag;
  if (!owner || !sig || owner === eventPubkey) return null;
  if (!/^[0-9a-f]{64}$/.test(owner) || !/^[0-9a-f]{128}$/.test(sig)) return null;
  const preimage = `nostr:agent-auth:${eventPubkey}:${conditions ?? ""}`;
  const digest = sha256(text.encode(preimage));
  const ok = schnorr.verify(hexToBytes(sig), digest, hexToBytes(owner));
  return ok ? owner : null;
}

function authConditionsMatch(conditions: string, createdAt: number, kind: number): boolean {
  if (conditions === "") return true;
  if (!/^(?:kind=\d+|created_at[<>]\d+)(?:&(?:kind=\d+|created_at[<>]\d+))*$/.test(conditions)) return false;
  for (const clause of conditions.split("&")) {
    if (clause.startsWith("kind=")) {
      const value = clause.slice(5);
      if (!canonical(value) || Number(value) !== kind) return false;
    } else if (clause.startsWith("created_at<")) {
      const value = clause.slice("created_at<".length);
      if (!canonical(value) || !(createdAt < Number(value))) return false;
    } else if (clause.startsWith("created_at>")) {
      const value = clause.slice("created_at>".length);
      if (!canonical(value) || !(createdAt > Number(value))) return false;
    } else {
      return false;
    }
  }
  return true;
}

function canonical(decimal: string): boolean {
  return decimal === "0" || /^[1-9][0-9]*$/.test(decimal);
}

/** NIP-01 event id and Schnorr signature. `created_at` defaults to now. */
export function signEvent(secretHex: string, kind: number, content: string, tags: string[][], createdAt = unixNow()): NostrEvent {
  const pubkey = pubkeyOf(secretHex);
  const body = JSON.stringify([0, pubkey, createdAt, kind, tags, content]);
  const id = bytesToHex(sha256(text.encode(body)));
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(secretHex)));
  return { id, pubkey, created_at: createdAt, kind, tags, content, sig };
}

export function verifyEvent(event: NostrEvent): boolean {
  const body = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const id = bytesToHex(sha256(text.encode(body)));
  if (id !== event.id) return false;
  return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
}

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

/** NIP-42 AUTH event (kind 22242). Optional NIP-OA tag admits an owned agent (NIP-AA). */
export function authEvent(secretHex: string, relayUrl: string, challenge: string, authTag?: string[]): NostrEvent {
  const tags = [
    ["relay", relayUrl],
    ["challenge", challenge],
  ];
  if (authTag) tags.push(authTag);
  return signEvent(secretHex, 22242, "", tags);
}
