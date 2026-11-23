import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { record } from "../src/control-files.js";
import { CONTROL_KIND, controlEvent, decryptControl, verifiedEnvelope, type ControlType } from "../src/control-protocol.js";
import { RelayClient, accepted } from "../src/nostr-client.js";
import { pubkeyOf, verifyEvent, type NostrEvent } from "../src/nostr.js";
import { readRelayMembers } from "../src/relay-discovery.js";
import { relaySigningPubkey } from "../src/relay-join.js";
import { publishServiceProfile, readLatestProfiles, serviceProfileEvent, serviceProfileName } from "../src/service-profile.js";
import { httpUrl, RUNTIME_PROFILE_KIND } from "../src/wake.js";
import type { Target, Wake } from "./target.js";

const WINDOW_MS = 120_000;
const READ_WINDOW_MS = 15_000;
const BEFORE_WAKE_MS = 5_000;
const AFTER_WAKE_MS = 30_000;

export async function publishProviderProfile(relay: string, secret: string): Promise<void> {
  const client = new RelayClient(relay, secret, undefined, false);
  try {
    await client.connect(3_000);
    await publishServiceProfile(client, pubkeyOf(secret), (current) => serviceProfileEvent(secret,
      serviceProfileName(process.platform === "darwin" ? "provider do Mac" : "provider"), current));
  } finally {
    await client.close();
  }
}

export async function namedRelayMembers(relay: string, secret: string): Promise<{ pubkey: string; name: string | null }[]> {
  const relayPubkey = await relaySigningPubkey(new URL(relay.replace(/^ws/, "http")).origin);
  const members = [...await readRelayMembers(relay, secret, relayPubkey)];
  if (!members.length) return [];
  const client = new RelayClient(relay, secret, undefined, false);
  try {
    await client.connect(5_000);
    const rows = [];
    for (let i = 0; i < members.length; i += 100) {
      const batch = members.slice(i, i + 100);
      const profiles = await readLatestProfiles(client, new Set(batch));
      for (const pubkey of batch) {
        let name = null;
        try {
          const profile: unknown = JSON.parse(profiles.get(pubkey)?.content ?? "null");
          if (record(profile)) {
            const label = [profile.display_name, profile.name].find((value) => typeof value === "string" && value.trim());
            if (typeof label === "string") name = label.trim();
          }
        } catch { /* Unreadable profile; still include the member. */ }
        rows.push({ pubkey, name });
      }
    }
    return rows;
  } finally {
    await client.close();
  }
}

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

export async function readDaemonWakeUrl(client: RelayClient, daemon: string): Promise<string | undefined> {
  const id = "daemon-runtime-profile";
  let timer: NodeJS.Timeout | undefined;
  let newest: NostrEvent | undefined;
  try {
    const profile = await new Promise<NostrEvent | undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 1_000);
      client.subscribe(id, [{ kinds: [RUNTIME_PROFILE_KIND], authors: [daemon], limit: 1 }], (event) => {
        try {
          if (event.kind !== RUNTIME_PROFILE_KIND || event.pubkey !== daemon ||
              !Number.isSafeInteger(event.created_at) || !verifyEvent(event)) return;
          if (!newest || event.created_at > newest.created_at ||
              (event.created_at === newest.created_at && event.id < newest.id)) newest = event;
        } catch {
          // Ignore malformed events.
        }
      }, () => resolve(undefined), () => resolve(newest));
    });
    const content: unknown = JSON.parse(profile?.content ?? "null");
    if (record(content) && content.daemon === true && httpUrl(content.wake_url)) return content.wake_url;
  } catch {
    // A missing or unreadable profile does not prevent a configured wake or retry.
  } finally {
    clearTimeout(timer);
    client.unsubscribe(id);
  }
}

async function lookupDaemonWakeUrl(target: Target, secret: string): Promise<string | undefined> {
  const client = new RelayClient(target.relay, secret, undefined, false);
  try {
    await client.connect(1_000);
    return await readDaemonWakeUrl(client, target.daemonPubkey);
  } catch {
    return undefined;
  } finally {
    await client.close();
  }
}

/** Wakes on timeout. Writes retry the same event; reads start fresh after waking. */
export async function sendControl(target: Extract<Target, { transport: "relay" }>, secret: string,
  op: Exclude<ControlType, "confirmation">, requestId: string, agentPubkey: string, body: unknown,
  services: { wait: RelayWait; wake: (config: Wake, requestId: string, timeoutMs: number) => Promise<void>;
    onConfirmation?: Parameters<RelayWait>[6] }, mode: "read" | "write" = "write") {
  const makeEvent = (id: string) => controlEvent(secret, target.daemonPubkey, op, { requestId: id, agentPubkey }, body);
  let event = makeEvent(requestId);
  const wait = (timeoutMs: number) => services.wait(target, secret, event, requestId, agentPubkey, timeoutMs, services.onConfirmation);
  const firstWindow = mode === "write" ? WINDOW_MS : (target.wake ? BEFORE_WAKE_MS : READ_WINDOW_MS);
  let result = await wait(firstWindow);
  let wakeFailed = false;
  if (result === "timeout") {
    const url = await lookupDaemonWakeUrl(target, secret);
    const hooks = target.wake ? [target.wake] : [];
    if (url && !(target.wake?.kind === "url" && new URL(target.wake.url).href === new URL(url).href)) {
      hooks.push({ kind: "url", url });
    }
    if (mode === "read" && !hooks.length) return { result, wakeFailed };
    const wakes = await Promise.allSettled(hooks.map(async (hook) => services.wake(hook, requestId, WINDOW_MS)));
    wakeFailed = wakes.some((wake) => wake.status === "rejected");
    if (mode === "read") {
      requestId = randomUUID();
      event = makeEvent(requestId);
    }
    result = await wait(mode === "read" ? AFTER_WAKE_MS : WINDOW_MS);
  }
  return { result, wakeFailed };
}
