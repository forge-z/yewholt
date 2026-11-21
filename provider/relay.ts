import { setTimeout as sleep } from "node:timers/promises";
import { record } from "../src/control-files.js";
import { CONTROL_KIND, decryptControl, verifiedEnvelope } from "../src/control-protocol.js";
import { RelayClient, accepted } from "../src/nostr-client.js";
import { pubkeyOf, type NostrEvent } from "../src/nostr.js";
import type { Target } from "./target.js";

export type RelayWait = (
  target: Extract<Target, { transport: "relay" }>, secret: string, event: NostrEvent,
  requestId: string, agentPubkey: string, timeoutMs: number,
  onConfirmation?: (body: Record<string, unknown>) => void,
) => Promise<"confirmed" | "refused" | "timeout">;

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export const waitForConfirmation: RelayWait = async (target, secret, event, requestId, agentPubkey, timeoutMs, onConfirmation) => {
  const recipient = pubkeyOf(secret);
  const deadline = AbortSignal.timeout(timeoutMs);
  while (!deadline.aborted) {
    const client = new RelayClient(target.relay, secret, undefined, false);
    let poll: NodeJS.Timeout | undefined;
    try {
      await untilAborted(client.connect(), deadline);
      const confirmation = new Promise<"confirmed" | "refused">((resolve) => {
        client.subscribe("deploy-confirmation", [{
          kinds: [CONTROL_KIND], authors: [target.daemonPubkey], "#p": [recipient],
        }], (incoming) => {
          if (incoming.pubkey !== target.daemonPubkey) return;
          const envelope = verifiedEnvelope(incoming, recipient, "confirmation");
          if (!envelope || envelope.requestId !== requestId || envelope.agentPubkey !== agentPubkey) return;
          try {
            const body = decryptControl(envelope, secret, target.daemonPubkey);
            if (record(body) && body.job === requestId && body.agentPubkey === agentPubkey && typeof body.ok === "boolean") {
              onConfirmation?.(body);
              resolve(body.ok ? "confirmed" : "refused");
            }
          } catch {
            // Unreadable confirmations cannot acknowledge a deploy.
          }
        }, () => resolve("refused"));
      });
      const disconnected = new Promise<never>((_, reject) => {
        poll = setInterval(() => {
          if (!client.isOpen()) reject(new Error("Relay disconnected"));
        }, 500);
      });
      const publication = client.publish(event).then((result) => accepted(result) ? confirmation : "refused" as const);
      return await untilAborted(Promise.race([confirmation, publication, disconnected]), deadline);
    } catch {
      try {
        await sleep(2_000, undefined, { signal: deadline });
      } catch {
        return "timeout";
      }
    } finally {
      clearInterval(poll);
      await client.close();
    }
  }
  return "timeout";
};
