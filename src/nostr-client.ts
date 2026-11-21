import WebSocket from "ws";
import { authEvent, pubkeyOf, type NostrEvent } from "./nostr.js";

type OkResult = { ok: boolean; message: string };

type Subscription = {
  onEvent: (event: NostrEvent) => void;
  onClosed?: (id: string, reason: string) => void;
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
  private authed: Promise<void> | undefined;

  constructor(
    private readonly url: string,
    private readonly secretHex: string,
    private readonly authTag?: string[],
  ) {}

  async connect(): Promise<void> {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.on("message", (data) => this.onFrame(data.toString()));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error));
    });
    this.authed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`AUTH timed out for ${this.url}`)), 15_000);
      this.challenge = (value) => {
        clearTimeout(timer);
        const event = authEvent(this.secretHex, this.url, value, this.authTag);
        this.send(["AUTH", event]);
        this.waiters.set(event.id, (result) => {
          if (result.ok) resolve();
          else reject(new Error(result.message || "AUTH rejected"));
        });
      };
    });
    await this.authed;
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
   */
  subscribe(
    id: string,
    filters: readonly Record<string, unknown>[],
    onEvent: (event: NostrEvent) => void,
    onClosed?: (id: string, reason: string) => void,
  ): void {
    this.subscriptions.set(id, { onEvent, onClosed });
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
    if (type === "CLOSED" && typeof rest[0] === "string") {
      const id = rest[0];
      const reason = typeof rest[1] === "string" ? rest[1] : "";
      if (this.selfClosed.delete(id)) return;
      const subscription = this.subscriptions.get(id);
      this.subscriptions.delete(id);
      const key = `${id}\n${reason}`;
      if (!this.closedLogged.has(key)) {
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
