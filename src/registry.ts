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
};

export type Proposal = {
  id: string;
  action: string;
  name: string;
  modelLabel: string;
  provider: string;
  modelId: string;
  scope: string[];
  permissions: string[];
  summary: string;
};

export type RegistryState = {
  bots: BotRecord[];
  pending: Proposal | null;
  processed: string[];
  outbox: NostrEvent[];
  highWater: number;
};

export const RegistryDoc = defineDoc<RegistryState>({
  kind: "yewholt.registry",
  version: 1,
  scope: "session",
  initial: () => ({ bots: [], pending: null, processed: [], outbox: [], highWater: 0 }),
  checkpointWhen: () => true,
});

export function emptyRegistry(): RegistryState {
  return { bots: [], pending: null, processed: [], outbox: [], highWater: 0 };
}
