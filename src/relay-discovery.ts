import { isPubkey } from "./control-protocol.js";
import { RelayClient } from "./nostr-client.js";
import { verifyEvent, type NostrEvent } from "./nostr.js";

type DiscoveryClient = Pick<RelayClient, "connect" | "subscribe" | "unsubscribe" | "close">;

export async function discoverRelayPubkey(relay: string, secret: string, expected?: string,
  client: DiscoveryClient = new RelayClient(relay, secret, undefined, false), timeoutMs = 15_000): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(timeoutMs);
        return await new Promise<string>((resolve, reject) => {
          client.subscribe("join-discovery", [{ kinds: [39000, 39002], limit: 5 }], (event) => {
            try {
              if (![39000, 39002].includes(event.kind) || !isPubkey(event.pubkey) || !verifyEvent(event)) return;
            } catch {
              return;
            }
            if (expected !== undefined && expected !== event.pubkey) {
              reject(new Error("Discovered relay signing key differs from the configured or supplied key"));
            } else resolve(event.pubkey);
          }, (_id, reason) => reject(new Error(`Relay signing key discovery rejected: ${reason}`)));
        });
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Relay signing key discovery timed out for ${relay}; no relay-signed group event received`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    client.unsubscribe("join-discovery");
    await client.close();
  }
}

export async function readRelayMembers(relay: string, secret: string, relayPubkey: string,
  client: DiscoveryClient = new RelayClient(relay, secret, undefined, false), timeoutMs = 15_000): Promise<ReadonlySet<string>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(timeoutMs);
        return await new Promise<ReadonlySet<string>>((resolve, reject) => {
          let newest: NostrEvent | undefined;
          client.subscribe("join-members", [{ kinds: [13534], authors: [relayPubkey], limit: 1 }], (event) => {
            try {
              if (event.kind !== 13534 || event.pubkey !== relayPubkey || !verifyEvent(event)) return;
            } catch {
              return;
            }
            if (!newest || event.created_at > newest.created_at ||
                (event.created_at === newest.created_at && event.id < newest.id)) newest = event;
          }, (_id, reason) => reject(new Error(`Relay membership lookup rejected: ${reason}`)), () => {
            if (!newest) return reject(new Error(`No relay-signed community membership roster received from ${relay}`));
            resolve(new Set(newest.tags.filter((tag) => tag[0] === "member" && isPubkey(tag[1])).map((tag) => tag[1])));
          });
        });
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Relay membership lookup timed out for ${relay}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    client.unsubscribe("join-members");
    await client.close();
  }
}
