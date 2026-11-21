import WebSocket from "ws";
import { authEvent, pubkeyOf, type NostrEvent } from "./nostr.js";

type OkResult = { ok: boolean; message: string };

export type RelayLoopback = { relayUrl: string; port: number };

export function relayDialTarget(url: string, loopback?: RelayLoopback): { url: string; headers?: { Host: string } } {
  if (loopback?.relayUrl !== url) return { url };
  const relay = new URL(url);
  if (relay.protocol !== "wss:" || ["127.0.0.1", "localhost", "[::1]"].includes(relay.hostname)) return { url };
  return { url: `ws://127.0.0.1:${loopback.port}`, headers: { Host: relay.host } };
}

type Subscription = {
  onEvent: (event: NostrEvent) => void;
  onClosed?: (id: string, reason: string) => void;
  onEose?: () => void;
};

/**
 * One NIP-42 connection. The daemon is a relay client, the same way a Buzz user is.
 * Pass `authTag` (NIP-OA) so an owned agent can be admitted under NIP-AA.
 */
export class RelayClient {
  private socket: WebSocket | undefined;
  private readonly waiters = new Map<string, (result: OkResult) => void>();
  /** One handler per subscription id. EVENT frames go only to the id they name. */
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly closedLogged = new Set<string>();
  /** Ids this client sent CLOSE for; the relay's answer to those is not a relay close. */
  private readonly selfClosed = new Set<string>();
  private challenge: ((value: string) => void) | undefined;

  constructor(
    private readonly url: string,
    private readonly secretHex: string,
    private readonly authTag?: string[],
    private readonly logClosed = true,
    private readonly loopback?: RelayLoopback,
  ) {}

  async connect(timeoutMs = 15_000, onOpen?: () => void): Promise<void> {
    const target = relayDialTarget(this.url, this.loopback);
    const socket = new WebSocket(target.url, target.headers ? { headers: target.headers } : undefined);
    this.socket = socket;
    if (onOpen) socket.once("open", onOpen);
    socket.on("message", (data) => this.onFrame(data.toString()));
    let timer: NodeJS.Timeout | undefined;
    let authId: string | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`AUTH timed out for ${this.url}`)), timeoutMs);
        socket.once("error", reject);
        socket.once("close", () => reject(new Error(`Socket closed before AUTH completed for ${this.url}`)));
        this.challenge = (value) => {
          this.challenge = undefined;
          const event = authEvent(this.secretHex, this.url, value, this.authTag);
          authId = event.id;
          this.waiters.set(event.id, (result) => {
            if (result.ok) resolve();
            else reject(new Error(result.message || "AUTH rejected"));
          });
          this.send(["AUTH", event]);
        };
      });
    } finally {
      clearTimeout(timer);
      this.challenge = undefined;
      if (authId) this.waiters.delete(authId);
    }
  }

  async publish(event: NostrEvent): Promise<OkResult> {
    const result = new Promise<OkResult>((resolve) => this.waiters.set(event.id, resolve));
    this.send(["EVENT", event]);
    return result;
  }

  /**
   * REQ under `id`. A second subscribe with the same id replaces the handler
   * (and, per NIP-01, the relay replaces the filters). `onClosed` receives a
   * relay CLOSED for this id; the subscription is dropped either way.
   * `onEose` marks the end of the relay's stored results.
   */
  subscribe(
    id: string,
    filters: readonly Record<string, unknown>[],
    onEvent: (event: NostrEvent) => void,
    onClosed?: (id: string, reason: string) => void,
    onEose?: () => void,
  ): void {
    this.subscriptions.set(id, { onEvent, onClosed, onEose });
    this.send(["REQ", id, ...filters]);
  }

  /** CLOSE `id` and drop its handler. Late EVENT frames for it are ignored. */
  unsubscribe(id: string): void {
    if (!this.subscriptions.delete(id)) return;
    this.selfClosed.add(id);
    this.send(["CLOSE", id]);
  }

  async close(): Promise<void> {
    this.socket?.close();
    this.socket = undefined;
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private onFrame(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(frame)) return;
    const [type, ...rest] = frame;
    if (type === "AUTH" && typeof rest[0] === "string") {
      this.challenge?.(rest[0]);
      return;
    }
    if (type === "OK" && typeof rest[0] === "string") {
      const waiter = this.waiters.get(rest[0]);
      this.waiters.delete(rest[0]);
      waiter?.({ ok: rest[1] === true, message: typeof rest[2] === "string" ? rest[2] : "" });
      return;
    }
    if (type === "EVENT" && typeof rest[0] === "string" && rest[1] && typeof rest[1] === "object") {
      this.subscriptions.get(rest[0])?.onEvent(rest[1] as NostrEvent);
      return;
    }
    if (type === "EOSE" && typeof rest[0] === "string") {
      this.subscriptions.get(rest[0])?.onEose?.();
      return;
    }
    if (type === "CLOSED" && typeof rest[0] === "string") {
      const id = rest[0];
      const reason = typeof rest[1] === "string" ? rest[1] : "";
      if (this.selfClosed.delete(id)) return;
      const subscription = this.subscriptions.get(id);
      this.subscriptions.delete(id);
      const key = `${id}\n${reason}`;
      if (this.logClosed && !this.closedLogged.has(key)) {
        this.closedLogged.add(key);
        console.error(`relay CLOSED ${id} for ${pubkeyOf(this.secretHex).slice(0, 8)}: ${reason || "(no reason)"}`);
      }
      subscription?.onClosed?.(id, reason);
    }
  }

  private send(frame: unknown): void {
    this.socket?.send(JSON.stringify(frame));
  }
}

export function accepted(result: OkResult): boolean {
  return result.ok || /duplicate/i.test(result.message);
}
