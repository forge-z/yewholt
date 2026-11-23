import { setTimeout as sleep } from "node:timers/promises";
import { record } from "../src/control-files.js";
import { CONTROL_KIND, controlEvent, decryptControl, verifiedEnvelope, type ControlType } from "../src/control-protocol.js";
import { RelayClient, accepted } from "../src/nostr-client.js";
import { pubkeyOf, type NostrEvent } from "../src/nostr.js";
import type { Target, Wake } from "./target.js";

const WINDOW_MS = 120_000;

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

function subscribeConfirmation(client: RelayClient, daemon: string, secret: string, requestId: string,
  agentPubkey: string, onConfirmation: (body: Record<string, unknown>) => void, onClosed: () => void): void {
  const recipient = pubkeyOf(secret);
  client.subscribe("deploy-confirmation", [{ kinds: [CONTROL_KIND], authors: [daemon], "#p": [recipient] }], (incoming) => {
    if (incoming.pubkey !== daemon) return;
    const envelope = verifiedEnvelope(incoming, recipient, "confirmation");
    if (!envelope || envelope.requestId !== requestId || envelope.agentPubkey !== agentPubkey) return;
    try {
      const body = decryptControl(envelope, secret, daemon);
      if (record(body) && body.job === requestId && body.agentPubkey === agentPubkey && typeof body.ok === "boolean") {
        onConfirmation(body);
      }
    } catch {
      // Unreadable confirmations cannot acknowledge a request.
    }
  }, onClosed);
}

export async function probeModelCatalog(client: RelayClient, target: Target, secret: string, requestId: string, timeoutMs: number) {
  const daemon = target.daemonPubkey;
  const event = controlEvent(secret, daemon, "hosted-models", { requestId, agentPubkey: daemon },
    { offset: 0, relay: target.relay, doctor: true });
  let acknowledged = false;
  let timer: NodeJS.Timeout | undefined;
  type Result = Record<string, unknown> | "relay" | "daemon";
  try {
    return await new Promise<Result>((resolve, reject) => {
      timer = setTimeout(() => resolve(acknowledged && client.isOpen() ? "daemon" : "relay"), timeoutMs);
      subscribeConfirmation(client, daemon, secret, requestId, daemon, resolve, () => resolve("relay"));
      client.publish(event).then(({ ok }) => {
        acknowledged = ok;
        if (!ok) resolve("relay");
      }, reject);
    });
  } finally {
    clearTimeout(timer);
  }
}

export const waitForConfirmation: RelayWait = async (target, secret, event, requestId, agentPubkey, timeoutMs, onConfirmation) => {
  const deadline = AbortSignal.timeout(timeoutMs);
  while (!deadline.aborted) {
    const client = new RelayClient(target.relay, secret, undefined, false);
    let poll: NodeJS.Timeout | undefined;
    try {
      await untilAborted(client.connect(), deadline);
      const confirmation = new Promise<"confirmed" | "refused">((resolve) => {
        subscribeConfirmation(client, target.daemonPubkey, secret, requestId, agentPubkey, (body) => {
          onConfirmation?.(body);
          resolve(body.ok ? "confirmed" : "refused");
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

/** Sends a control request, waits one window, wakes the target once on timeout, then waits again with the same event. */
export async function sendControl(target: Extract<Target, { transport: "relay" }>, secret: string,
  op: Exclude<ControlType, "confirmation">, requestId: string, agentPubkey: string, body: unknown,
  services: { wait: RelayWait; wake: (config: Wake, requestId: string, timeoutMs: number) => Promise<void> }, event?: NostrEvent) {
  event ??= controlEvent(secret, target.daemonPubkey, op, { requestId, agentPubkey }, body);
  const wait = () => services.wait(target, secret, event!, requestId, agentPubkey, WINDOW_MS);
  let result = await wait();
  let wakeFailed = false;
  if (result === "timeout") {
    if (target.wake) {
      try {
        await services.wake(target.wake, requestId, WINDOW_MS);
      } catch {
        wakeFailed = true;
      }
    }
    result = await wait();
  }
  return { result, wakeFailed };
}
