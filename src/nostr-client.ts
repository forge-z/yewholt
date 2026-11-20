import WebSocket from "ws";
import { authEvent, type NostrEvent } from "./nostr.js";

type OkResult = { ok: boolean; message: string };

/**
 * One NIP-42 connection. The daemon is a relay client, the same way a Buzz user is.
 * Pass `authTag` (NIP-OA) so an owned agent can be admitted under NIP-AA.
 */
export class RelayClient {
  private socket: WebSocket | undefined;
  private readonly waiters = new Map<string, (result: OkResult) => void>();
  private readonly listeners = new Set<(event: NostrEvent) => void>();
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

  subscribe(id: string, filters: readonly Record<string, unknown>[], onEvent: (event: NostrEvent) => void): void {
    this.listeners.add(onEvent);
    this.send(["REQ", id, ...filters]);
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
    if (type === "EVENT" && rest[1] && typeof rest[1] === "object") {
      const event = rest[1] as NostrEvent;
      for (const listener of this.listeners) listener(event);
    }
  }

  private send(frame: unknown): void {
    this.socket?.send(JSON.stringify(frame));
  }
}

export function accepted(result: OkResult): boolean {
  return result.ok || /duplicate/i.test(result.message);
}
