import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { RelayClient } from "../src/nostr-client.js";
import { generateKeyPair, ownerAuthTag, pubkeyOf, signEvent, unixNow, verifyEvent, type NostrEvent } from "../src/nostr.js";
import { open, seal } from "../src/control-crypto.js";

const kinds = [30079, 1059, 4] as const;
const purpose = "yewholt-control-spike-v1";
type Kind = (typeof kinds)[number];
type Filter = { kinds: Kind[]; "#p": string[] };
type Ack = Awaited<ReturnType<RelayClient["publish"]>>;

async function deadline<T>(operation: string, result: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([result, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${operation}`)), 20_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function connected<T>(url: string, secret: string, authTag: string[] | undefined,
  run: (client: RelayClient) => Promise<T>): Promise<T> {
  const client = new RelayClient(url, secret, authTag);
  try {
    await deadline("NIP-42 AUTH OK", client.connect());
    return await run(client);
  } finally {
    await client.close();
  }
}

async function authWithoutDelegation(relay: string, secret: string): Promise<string> {
  return connected(relay, secret, undefined, async () => "OK").catch((error: unknown) => {
    if (!(error instanceof Error) || !error.message.startsWith("restricted:")) throw error;
    return error.message;
  });
}

async function history(client: RelayClient, filter: Filter) {
  const id = randomUUID();
  const events: NostrEvent[] = [];
  try {
    return await deadline("REQ EOSE or CLOSED", new Promise<{ status: string; events: NostrEvent[] }>((resolve) => {
      client.subscribe(id, [filter], (event) => events.push(event),
        (_id, reason) => resolve({ status: `CLOSED: ${reason}`, events: [...events] }),
        () => resolve({ status: "EOSE", events: [...events] }));
    }));
  } finally {
    client.unsubscribe(id);
  }
}

async function withoutAuth(url: string, filter: Filter, event: NostrEvent) {
  const socket = new WebSocket(url);
  try {
    return await deadline("unauthenticated REQ and EVENT responses",
      new Promise<{ read: string; events: number; publish: Ack }>((resolve, reject) => {
        let read: string | undefined;
        let publish: Ack | undefined;
        let events = 0;
        socket.once("error", reject);
        socket.once("close", () => reject(new Error("Unauthenticated socket closed before both responses")));
        socket.once("open", () => {
          socket.send(JSON.stringify(["REQ", "no-auth", filter]));
          socket.send(JSON.stringify(["EVENT", event]));
        });
        socket.on("message", (raw) => {
          const [type, id, okOrReason, message] = JSON.parse(raw.toString());
          if (id === "no-auth" && type === "EVENT" && !read) events++;
          if (id === "no-auth" && type === "CLOSED") read = `CLOSED: ${okOrReason}`;
          if (id === "no-auth" && type === "EOSE") read = "EOSE";
          if (id === event.id && type === "OK") publish = { ok: okOrReason, message };
          if (read && publish) resolve({ read, events, publish });
        });
      }));
  } finally {
    socket.terminate();
  }
}

function controlEvent(kind: Kind, providerSecret: string, daemonPubkey: string, agentPubkey: string, createdAt: number) {
  const context = { agentPubkey, requestId: randomUUID() };
  const payload = JSON.stringify({ op: "deploy", agentPubkey, requestId: context.requestId, fixture: true });
  const tags = [["p", daemonPubkey]];
  if (kind === 30079) tags.push(["d", agentPubkey]);
  if (kind === 4) tags.push(["t", "yewholt-control-spike"]);
  const signer = kind === 1059 ? generateKeyPair().secret : providerSecret;
  const body = kind === 1059 ? JSON.stringify(signEvent(providerSecret, 30079, payload, tags, createdAt)) : payload;
  const content = JSON.stringify({ ...context, ciphertext: seal(body, signer, daemonPubkey, context, purpose) });
  return { event: signEvent(signer, kind, content, tags, createdAt), payload };
}

function decrypt(received: NostrEvent, daemonSecret: string, provider: string): string {
  assert.ok(verifyEvent(received), "invalid outer signature");
  const { agentPubkey, requestId, ciphertext } = JSON.parse(received.content);
  const plaintext = open(ciphertext, daemonSecret, received.pubkey, { agentPubkey, requestId }, purpose);
  if (received.kind !== 1059) {
    assert.equal(received.pubkey, provider);
    return plaintext;
  }
  const inner = JSON.parse(plaintext) as NostrEvent;
  assert.equal(inner.pubkey, provider);
  assert.ok(verifyEvent(inner), "invalid inner signature");
  return inner.content;
}

async function main() {
  const [relay, ownerKeyFile] = process.argv.slice(2);
  assert.ok(relay && ownerKeyFile, "Usage: node dist/test/spike-control-kind.js ws://127.0.0.1:13000 /path/to/disposable/owner.key");
  const url = new URL(relay);
  assert.ok(url.protocol === "ws:" && url.hostname === "127.0.0.1" && !url.username && !url.password,
    "Run this spike only against a disposable loopback relay");
  const provider = readFileSync(ownerKeyFile, "utf8").trim();
  const providerPubkey = pubkeyOf(provider);
  const daemon = generateKeyPair();
  const bystander = generateKeyPair();
  const unknown = generateKeyPair();
  const agent = generateKeyPair();
  const daemonTag = ownerAuthTag(provider, daemon.pubkey);
  const bystanderTag = ownerAuthTag(provider, bystander.pubkey);

  const [unknownAuth, recipientAuthWithoutDelegation] = await Promise.all([
    authWithoutDelegation(relay, unknown.secret),
    authWithoutDelegation(relay, daemon.secret),
  ]);
  console.log(JSON.stringify({ unknownAuth, recipientAuthWithoutDelegation }));
  assert.notEqual(unknownAuth, "OK", "Expected membership enforcement on the disposable relay");

  let chosen: Kind | undefined;
  for (const kind of kinds) {
    const filter: Filter = { kinds: [kind], "#p": [daemon.pubkey] };
    const createdAt = unixNow();
    const first = controlEvent(kind, provider, daemon.pubkey, agent.pubkey, createdAt - 1);
    const unknownEvent = controlEvent(kind, unknown.secret, daemon.pubkey, agent.pubkey, createdAt).event;
    const unauthenticated = await withoutAuth(relay, filter, unknownEvent);
    const publish = (event: NostrEvent) => connected(relay, provider, undefined,
      (client) => deadline("EVENT OK", client.publish(event)));
    const read = () => connected(relay, daemon.secret, daemonTag, (client) => history(client, filter));
    const publishFirst = await publish(first.event);
    const recipient = await read();
    const retrieved = recipient.events.find((event) => event.id === first.event.id);
    if (retrieved) assert.equal(decrypt(retrieved, daemon.secret, providerPubkey), first.payload);
    if (publishFirst.ok && recipient.status === "EOSE" && retrieved) chosen ??= kind;

    const other = await connected(relay, bystander.secret, bystanderTag, (client) => history(client, filter));
    let replacement;
    if (kind === 30079) {
      const second = controlEvent(kind, provider, daemon.pubkey, agent.pubkey, createdAt);
      const publishSecond = await publish(second.event);
      const after = await read();
      const newer = after.events.find((event) => event.id === second.event.id);
      if (newer) assert.equal(decrypt(newer, daemon.secret, providerPubkey), second.payload);
      replacement = {
        publishSecond, read: after.status, firstPresent: after.events.some((event) => event.id === first.event.id),
        secondPresent: !!newer, secondDecrypted: !!newer,
        replaced: !!retrieved && publishSecond.ok && after.status === "EOSE" && after.events.length === 1 && !!newer,
      };
    }
    console.log(JSON.stringify({
      kind, publishFirst, recipient: { read: recipient.status, events: recipient.events.length, decrypted: !!retrieved },
      otherMember: { read: other.status, events: other.events.length }, unauthenticated, replacement,
    }));
  }
  console.log(JSON.stringify({ chosen: chosen ?? "no store-and-forward; deploy relies on wake + retry" }));
}

await main();
