import { defineDoc } from "@earendil-works/pi-durable";
import type { NostrEvent } from "./nostr.js";

export type BotRecord = {
  conversationId: number;
  name: string;
  pubkey: string;
  modelLabel: string;
  provider: string;
  modelId: string;
  scope: string[];
  permissions: string[];
  status: string;
  role: string;
  limitTokens: number;
  spentTokens: number;
  announced: boolean;
  external?: true;
  ownerPubkey?: string;
  authTag?: string[];
  relayUrl?: string;
  respondTo?: string;
  respondToAllowlist?: string[];
  agentFileVersion?: string;
  stopped?: boolean;
  stoppedAt?: number;
  stoppedFileVersion?: string;
  shutdownEventIds?: string[];
};

/** An unfinished chat turn. A restart cancels it rather than replaying tool side effects. */
export type CodeTurn = {
  relay?: { url: string; primary: boolean };
  requestId: string;
  pubkey: string;
  channelId: string;
  eventId: string;
  author: string;
  text: string;
  createdAt: number;
};

/** A parked tool call waiting for `aprovo`/`rejeito` in its channel (src/coding.ts). */
export type ApprovalRequest = {
  id: string;
  pubkey: string;
  conversationId: number;
  taskId: number;
  key: string;
  channelId: string;
  tool: string;
  subject: string;
  reasons: string[];
  /** The kind 9 that asked; a reply to it resolves this request. */
  eventId: string;
  createdAt: number;
};

export type RegistryState = {
  bots: BotRecord[];
  processed: string[];
  outbox: NostrEvent[];
  highWater: number;
  highWaterByRelay?: Record<string, number>;
  /** Absent in registries written before code bots existed. */
  turns?: CodeTurn[];
  approvals?: ApprovalRequest[];
};

export const RegistryDoc = defineDoc<RegistryState>({
  kind: "yewholt.registry",
  version: 1,
  scope: "session",
  initial: () => ({ bots: [], processed: [], outbox: [], highWater: 0 }),
  checkpointWhen: () => true,
});
