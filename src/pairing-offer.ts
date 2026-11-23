import { createHmac, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { readJson, record, writePrivateJson } from "./control-files.js";
import { pubkeyOf, verifyAuthSignature, type NostrEvent } from "./nostr.js";
import { normalizeRelay } from "./relay-url.js";
import { serviceProfileEvent, serviceProfileName } from "./service-profile.js";

/** A daemon joined from its own machine waits for the provider that holds the same invite. */
export type PairingOffer = { key: string; relayUrl: string; label: string; createdAt: number; expiresAt: number; owner?: string };
export const OFFER_TTL_MS = 24 * 60 * 60 * 1000;
export const OFFER_TAG = "yewholt-pairing";
export const OWNER_TAG = "yewholt-owner";
const offerPath = (home: string) => join(home, "state", "pairing-offer.json");
const hmac = (key: string, data: string) => createHmac("sha256", Buffer.from(key, "hex")).update(data).digest("hex");

/** Shared by everyone holding the invite; binds it to one community. The invite code itself is never stored. */
export function offerKey(code: string, relayUrl: string): string {
  return createHmac("sha256", code).update(`yewholt-pair-v1:${normalizeRelay(relayUrl) ?? relayUrl}`).digest("hex");
}

/** Public tag value: proves the daemon holds the invite without revealing it. */
export function offerTag(key: string, daemon: string): string {
  return hmac(key, `offer:${daemon}`);
}

export function pairingProof(key: string, provider: string, daemon: string, requestId: string): string {
  return hmac(key, `pair:${provider}:${daemon}:${requestId}`);
}

export function sameProof(actual: unknown, expected: string): boolean {
  return typeof actual === "string" && actual.length === expected.length &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function machineLabel(name = hostname()): string {
  return name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 120) || "Yewholt VM";
}

export function writePairingOffer(home: string, code: string, relayUrl: string, label = machineLabel(), now = Date.now(),
  owner?: string): PairingOffer {
  const offer: PairingOffer = { key: offerKey(code, relayUrl), relayUrl, label, createdAt: now, expiresAt: now + OFFER_TTL_MS,
    ...(owner ? { owner } : {}) };
  writePrivateJson(offerPath(home), offer);
  return offer;
}

export function readPairingOffer(home: string, now = Date.now()): PairingOffer | undefined {
  const value = readJson(offerPath(home));
  if (!record(value) || typeof value.key !== "string" || !/^[a-f0-9]{64}$/.test(value.key) ||
      typeof value.relayUrl !== "string" || typeof value.label !== "string" || !value.label ||
      !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) ||
      (value.owner !== undefined && (typeof value.owner !== "string" || !/^[a-f0-9]{64}$/.test(value.owner)))) return undefined;
  const offer = value as PairingOffer;
  return offer.expiresAt > now ? offer : undefined;
}

export function removePairingOffer(home: string): void {
  rmSync(offerPath(home), { force: true });
}

/** The daemon's kind 0 profile, tagged while a pairing offer is open. */
export function daemonProfileEvent(secret: string, daemon: string, name?: string, offer?: PairingOffer, createdAt?: number): NostrEvent;
export function daemonProfileEvent(secret: string, daemon: string, name: string | undefined, offer: PairingOffer | undefined,
  createdAt: number | undefined, current: NostrEvent | undefined): NostrEvent | undefined;
export function daemonProfileEvent(secret: string, daemon: string, name?: string, offer?: PairingOffer, createdAt?: number,
  current?: NostrEvent): NostrEvent | undefined {
  const tags = offer ? [[OFFER_TAG, offerTag(offer.key, daemon), name ?? offer.label], ...(offer.owner ? [[OWNER_TAG, offer.owner]] : [])] : [];
  return serviceProfileEvent(secret, serviceProfileName("daemon"), current,
    { name, tags, managedTags: [OFFER_TAG, OWNER_TAG], createdAt });
}

/**
 * An activation the offer's owner signed for an agent whose secret the provider holds. The owner's NIP-OA tag alone is
 * public once the agent posts; holding the agent secret shows this provider created the agent the owner authorized.
 */
export function ownerActivation(offer: PairingOffer, body: unknown, agentPubkey: string): boolean {
  if (!offer.owner || !record(body) || !record(body.agent)) return false;
  const { authTag } = body;
  const { nsec } = body.agent;
  if (!Array.isArray(authTag) || !authTag.every((item) => typeof item === "string") || authTag[1] !== offer.owner ||
      verifyAuthSignature(authTag, agentPubkey) !== offer.owner || typeof nsec !== "string") return false;
  try {
    return pubkeyOf(nsec) === agentPubkey;
  } catch {
    return false;
  }
}
