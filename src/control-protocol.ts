import { ECDH } from "node:crypto";
import { open, seal, type ControlContext } from "./control-crypto.js";
import { signEvent, verifyEvent, type NostrEvent } from "./nostr.js";

export const CONTROL_KIND = 1059;
const CONTROL_TAG = "yewholt-control";
const MAX_CONTENT = 48 * 1024;
const hexKey = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type HostedOperation = "hosted-activate" | "hosted-profile" | "hosted-remove" | "hosted-model";
export type ControlType = "deploy" | "confirmation" | "hosted-models" | "wake-delegation" | "pair" | HostedOperation;
export type ControlEnvelope = ControlContext & {
  version: 1;
  type: ControlType;
  issuedAt: number;
  ciphertext: string;
};
export type ModelPage = { models: string[]; next?: number };
export type Confirmation = {
  job: string; ok: boolean; agentPubkey: string; error?: string; catalog?: ModelPage; model?: string | null;
  piLoginMissing?: boolean;
};

export function isModelReference(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 && /^[a-z0-9_-]+\/[^\s\x00-\x1f\x7f]+$/i.test(value);
}

export function isPubkey(value: unknown): value is string {
  if (typeof value !== "string" || !hexKey.test(value)) return false;
  try {
    ECDH.convertKey(`02${value}`, "secp256k1", "hex");
    return true;
  } catch {
    return false;
  }
}

export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}

export function controlEvent(
  secret: string, recipient: string, type: ControlType, context: ControlContext, body: unknown, issuedAt = Date.now(),
): NostrEvent {
  if (!isPubkey(recipient) || !isPubkey(context.agentPubkey) || !isRequestId(context.requestId) ||
      !Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error("Invalid control event context");
  const envelope: ControlEnvelope = {
    version: 1, type, issuedAt, agentPubkey: context.agentPubkey, requestId: context.requestId,
    ciphertext: seal(JSON.stringify(body), secret, recipient, context, purpose(type)),
  };
  const content = JSON.stringify(envelope);
  if (content.length > MAX_CONTENT) throw new Error("Control event is too large");
  return signEvent(secret, CONTROL_KIND, content, [["p", recipient], ["t", CONTROL_TAG]], Math.floor(issuedAt / 1000));
}

export function verifiedEnvelope(event: NostrEvent, recipient: string, type: ControlType): ControlEnvelope | null {
  try {
    if (event.kind !== CONTROL_KIND || typeof event.content !== "string" || event.content.length > MAX_CONTENT ||
        !isPubkey(event.pubkey) || !Array.isArray(event.tags) || event.tags.length !== 2) return null;
    if (!event.tags.some((tag) => tag.length === 2 && tag[0] === "p" && tag[1] === recipient) ||
        !event.tags.some((tag) => tag.length === 2 && tag[0] === "t" && tag[1] === CONTROL_TAG) || !verifyEvent(event)) return null;
    const envelope = JSON.parse(event.content) as ControlEnvelope;
    if (!envelope || envelope.version !== 1 || envelope.type !== type || !isPubkey(envelope.agentPubkey) ||
        !isRequestId(envelope.requestId) || !Number.isSafeInteger(envelope.issuedAt) || envelope.issuedAt <= 0 ||
        Math.floor(envelope.issuedAt / 1000) !== event.created_at || typeof envelope.ciphertext !== "string") return null;
    return envelope;
  } catch {
    return null;
  }
}

export function decryptControl(envelope: ControlEnvelope, secret: string, sender: string): unknown {
  return JSON.parse(open(envelope.ciphertext, secret, sender, envelope, purpose(envelope.type)));
}

function purpose(type: ControlType): string {
  return `yewholt-control-v1/${type}`;
}
