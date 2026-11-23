import { randomUUID } from "node:crypto";
import { CONTROL_KIND, controlEvent, decryptControl, verifiedEnvelope } from "./control-protocol.js";
import { pubkeyOf, type NostrEvent } from "./nostr.js";

/** Most agents one watcher reads for; later delegations are ignored. */
const MAX_READERS = 32;

export type Reader = { close(): Promise<void> };
export type OpenReader = (agentPubkey: string, secret: string, authTag: string[] | undefined) => Promise<Reader>;

/**
 * Sent by a dozing daemon to its watcher: the agent's key sealed to the watcher,
 * so the watcher can read the agent's DMs and private channels while the VM sleeps.
 */
export function delegationEvent(ownerSecret: string, watcher: string, agentPubkey: string, agentSecret: string,
  authTag?: string[], issuedAt = Date.now()): NostrEvent {
  return controlEvent(ownerSecret, watcher, "wake-delegation", { agentPubkey, requestId: randomUUID() },
    { secret: agentSecret, ...(authTag && { authTag }) }, issuedAt);
}

/** The watcher side: one read-only agent connection per delegated agent, newest delegation wins. */
export class DelegatedReaders {
  private readonly readers = new Map<string, { at: number; key: string; reader: Promise<Reader | undefined> }>();
  private readonly pubkey: string;

  constructor(private readonly secret: string, private readonly open: OpenReader) {
    this.pubkey = pubkeyOf(secret);
  }

  filters(): Record<string, unknown>[] {
    return [{ kinds: [CONTROL_KIND], "#p": [this.pubkey] }];
  }

  accept(event: NostrEvent): void {
    const envelope = verifiedEnvelope(event, this.pubkey, "wake-delegation");
    if (!envelope) return;
    let body: unknown;
    try {
      body = decryptControl(envelope, this.secret, event.pubkey);
    } catch {
      return;
    }
    const { secret, authTag } = (body ?? {}) as { secret?: unknown; authTag?: unknown };
    if (typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret)) return;
    if (authTag !== undefined && !(Array.isArray(authTag) && authTag.every((part) => typeof part === "string"))) return;
    const agent = envelope.agentPubkey;
    try {
      if (pubkeyOf(secret) !== agent) return;
    } catch {
      return;
    }
    const current = this.readers.get(agent);
    if (current && current.at >= event.created_at) return;
    if (!current && this.readers.size >= MAX_READERS) return;
    const key = JSON.stringify([secret, authTag ?? null]);
    if (current?.key === key) {
      current.at = event.created_at;
      return;
    }
    if (current) void current.reader.then((reader) => reader?.close());
    const reader = this.open(agent, secret, authTag as string[] | undefined).catch(() => {
      console.error(`wake: unable to read for agent ${agent.slice(0, 8)}`);
      if (this.readers.get(agent)?.reader === reader) this.readers.delete(agent);
      return undefined;
    });
    this.readers.set(agent, { at: event.created_at, key, reader });
  }

  async closeAll(): Promise<void> {
    const readers = [...this.readers.values()];
    this.readers.clear();
    await Promise.all(readers.map(async ({ reader }) => (await reader)?.close()));
  }
}
