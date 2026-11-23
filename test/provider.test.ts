import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocketServer } from "ws";
import { sendControl, waitForConfirmation } from "../provider/relay.js";
import { ProviderSecrets } from "../provider/secrets.js";
import { loadTarget } from "../provider/target.js";
import { runWake } from "../provider/wake.js";
import { controlEvent, decryptControl, verifiedEnvelope } from "../src/control-protocol.js";
import { generateKeyPair, pubkeyOf, signEvent, type NostrEvent } from "../src/nostr.js";
import { RUNTIME_PROFILE_KIND } from "../src/wake.js";

const root = mkdtempSync(join(homedir(), "yewholt-provider-test-"));
after(() => rmSync(root, { force: true, recursive: true }));
const secret = "0".repeat(63) + "1";
const agentPubkey = pubkeyOf(secret);
const owner = generateKeyPair();
const daemon = generateKeyPair();
const relay = { label: "VM", transport: "relay" as const, relay: "ws://127.0.0.1:13000", daemonPubkey: daemon.pubkey };
const envValue = "hidden-env-value-fixture";
const requestId = randomUUID();

function setup(id: string) {
  const provider = join(root, id + "-provider");
  mkdirSync(join(provider, "targets"), { recursive: true });
  const target = join(provider, "targets", id + ".json");
  const writeTarget = (value: unknown, mode = 0o600) => writeFileSync(target, JSON.stringify(value), { mode });
  return { target, provider, writeTarget };
}

test("targets refuse missing, non-private, secret-bearing, mismatched, local, and nonregular files", () => {
  const id = "target";
  const { target, provider, writeTarget } = setup(id);
  const valid = { ...relay, id };
  const refused = () => assert.throws(() => loadTarget(id, provider));
  refused();
  writeTarget(valid, 0o644);
  refused();
  chmodSync(target, 0o600);
  assert.deepEqual(loadTarget(id, provider), { ...relay, wake: undefined });
  writeTarget({ id, label: "Mac", transport: "local" });
  refused();
  writeTarget({ ...valid, token: envValue });
  refused();
  writeTarget({ ...valid, wake: { kind: "command", cmd: "true", password: envValue } });
  refused();
  writeTarget({ ...valid, relay: "wss://relay.example.test/?token=" + envValue });
  refused();
  writeTarget({ ...valid, daemonPubkey: "0".repeat(64) });
  refused();
  writeTarget({ ...valid, id: "another-target" });
  refused();
  const realTarget = target + ".real";
  writeFileSync(realTarget, JSON.stringify(valid), { mode: 0o600 });
  rmSync(target);
  symlinkSync(realTarget, target);
  refused();
});

test("control requests wait two 120s windows, wake only on timeout, and reuse the exact encrypted event", async () => {
  const wake = { kind: "command" as const, cmd: "trusted-hook" };
  const provider = generateKeyPair();
  const attempts: string[] = [];
  let mode: "confirmed" | "refused" | "timeout" = "confirmed";
  let first: NostrEvent | undefined;
  const services: Parameters<typeof sendControl>[6] = {
    wake: async (config, id, timeout) => {
      assert.deepEqual([config, id, timeout], [wake, requestId, 120_000]);
      attempts.push("wake");
    },
    wait: async (_, __, event, job, pubkey, timeout) => {
      assert.deepEqual([job, pubkey, timeout], [requestId, agentPubkey, 120_000]);
      attempts.push("wait");
      if (!first) {
        first = event;
        const envelope = verifiedEnvelope(event, daemon.pubkey, "hosted-activate");
        assert.ok(envelope);
        assert.deepEqual(decryptControl(envelope, daemon.secret, provider.pubkey), { hidden: "body" });
        return mode === "refused" ? mode : "timeout";
      }
      assert.equal(event, first);
      return mode;
    },
  };
  const send = () => sendControl({ ...relay, wake }, provider.secret, "hosted-activate", requestId, agentPubkey, { hidden: "body" }, services);
  assert.deepEqual(await send(), { result: "confirmed", wakeFailed: false });
  assert.deepEqual(attempts.splice(0), ["wait", "wake", "wait"]);
  first = undefined;
  mode = "timeout";
  assert.deepEqual(await send(), { result: "timeout", wakeFailed: false });
  assert.deepEqual(attempts.splice(0), ["wait", "wake", "wait"]);
  first = undefined;
  mode = "refused";
  assert.deepEqual(await send(), { result: "refused", wakeFailed: false });
  assert.deepEqual(attempts, ["wait"]);
});

test("relay control wakes an idle daemon using its signed announcement, with or without a configured hook", async (t) => {
  const provider = generateKeyPair();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const target = { ...relay, relay: "ws://127.0.0.1:" + addr.port };
  const wakeUrl = "https://wake.example.test/";
  const untrusted = JSON.stringify({ daemon: true, wake_url: "https://untrusted.example.test/" });
  const profile = signEvent(daemon.secret, RUNTIME_PROFILE_KIND, JSON.stringify({ daemon: true, wake_url: wakeUrl }), []);
  let advertise = true;
  let asleep = true;
  server.on("connection", (ws) => {
    ws.send(JSON.stringify(["AUTH", "challenge"]));
    ws.on("message", (data) => {
      const [type, item, filter] = JSON.parse(data.toString());
      if (type === "AUTH" || type === "EVENT") ws.send(JSON.stringify(["OK", item.id, true, ""]));
      if (type === "REQ" && filter.kinds.includes(RUNTIME_PROFILE_KIND)) {
        assert.deepEqual(filter.authors, [daemon.pubkey]);
        ws.send(JSON.stringify(["EVENT", item, signEvent(owner.secret, RUNTIME_PROFILE_KIND, untrusted, [])]));
        ws.send(JSON.stringify(["EVENT", item, { ...profile, content: untrusted }]));
        if (advertise) ws.send(JSON.stringify(["EVENT", item, profile]));
        ws.send(JSON.stringify(["EOSE", item]));
      }
      if (type === "EVENT" && !asleep) {
        const context = JSON.parse(item.content);
        const reply = controlEvent(daemon.secret, provider.pubkey, "confirmation", context,
          { job: context.requestId, agentPubkey: context.agentPubkey, ok: true });
        ws.send(JSON.stringify(["EVENT", "deploy-confirmation", reply]));
      }
    });
  });
  const calls: string[] = [];
  const fetchWake: typeof fetch = async (resource, init) => {
    const url = String(resource);
    calls.push(init?.method + " " + url);
    if (url === "https://api.instabox.sh/v1/machines/m_fixture") return Response.json({ state: "running" });
    assert.equal(url, wakeUrl);
    asleep = false;
    return new Response(null, { status: 204 });
  };
  for (const mode of ["read", "write"] as const) {
    asleep = true;
    const wake = mode === "write" ? { kind: "instabox" as const, accountId: "acc_test", machineId: "m_fixture" } : undefined;
    const ids: string[] = [];
    const result = await sendControl({ ...target, wake }, provider.secret, mode === "read" ? "hosted-models" : "deploy",
      requestId, daemon.pubkey, {}, {
        wait: (target, secret, event, id, agent) => {
          ids.push(id);
          return waitForConfirmation(target, secret, event, id, agent, ids.length === 1 ? 250 : 5_000);
        },
        wake: (config, id, timeout) => runWake(config, id, timeout, () => "fixture-token", fetchWake),
      }, mode);
    assert.deepEqual(result, { result: "confirmed", wakeFailed: false });
    assert.equal(ids.length, 2);
    assert.equal(ids[0] === ids[1], mode === "write");
    assert.deepEqual(calls.splice(0), mode === "write" ?
      ["GET https://api.instabox.sh/v1/machines/m_fixture", "GET " + wakeUrl] : ["GET " + wakeUrl]);
  }
  advertise = false;
  const result = await sendControl(target, provider.secret, "hosted-models", requestId, daemon.pubkey, {}, {
    wait: async () => "timeout",
    wake: () => assert.fail("untrusted profiles cannot trigger wake"),
  }, "read");
  assert.deepEqual(result, { result: "timeout", wakeFailed: false });
});

test("relay OK alone is insufficient; confirmation must be signed by the paired daemon and match both ids", async () => {
  const provider = generateKeyPair();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    let allow = false;
    const context = { agentPubkey, requestId: requestId };
    const payload = { agentPubkey, job: context.requestId, ok: true };
    server.on("connection", (ws) => {
      ws.send(JSON.stringify(["AUTH", "challenge"]));
      ws.on("message", (data) => {
        const [type, event] = JSON.parse(data.toString());
        if (type === "AUTH" || type === "EVENT") ws.send(JSON.stringify(["OK", event.id, true, ""]));
        if (type !== "EVENT") return;
        const reply = (key: string, body: object) =>
          ws.send(JSON.stringify(["EVENT", "deploy-confirmation", controlEvent(key, provider.pubkey, "confirmation", context, body)]));
        reply(owner.secret, payload);
        reply(daemon.secret, { ...payload, job: randomUUID() });
        reply(daemon.secret, { ...payload, agentPubkey: owner.pubkey });
        if (allow) reply(daemon.secret, payload);
      });
    });
    const event = controlEvent(provider.secret, daemon.pubkey, "deploy", context, {});
    const target = { ...relay, relay: "ws://127.0.0.1:" + addr.port };
    const wait = (timeout: number) => waitForConfirmation(target, provider.secret, event, context.requestId, agentPubkey, timeout);
    assert.equal(await wait(150), "timeout");
    allow = true;
    assert.equal(await wait(2_000), "confirmed");
  } finally {
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("provider key and InstaBox fallback token are read from private per-account storage", () => {
  const { provider } = setup("storage");
  const storage = new ProviderSecrets(provider, false);
  const identity = storage.identity();
  assert.equal(storage.identity(), identity);
  const file = join(provider, "secrets", "identity.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(/^[a-f0-9]{64}$/.test(pubkeyOf(identity)));
  const token = join(provider, "secrets", "instabox-acc_test.json");
  writeFileSync(token, JSON.stringify("fixture-token"), { mode: 0o600 });
  assert.ok(storage.instabox("acc_test") === "fixture-token");
  chmodSync(token, 0o644);
  assert.throws(() => storage.instabox("acc_test"), /Invalid private secret storage/);
});

test("InstaBox wake starts stopped machines, resumes paused machines, and polls the operation", async () => {
  for (const state of ["stopped", "suspended"]) {
    const traces: string[] = [];
    const mock: typeof fetch = async (resource, init) => {
      const url = new URL(String(resource));
      const headers = new Headers(init?.headers);
      assert.ok(headers.get("x-api-key") === "fixture-token" && init?.redirect === "error");
      assert.equal(url.origin, "https://api.instabox.sh");
      if (init?.method === "POST") assert.equal(headers.get("idempotency-key"), "yewholt-" + requestId);
      traces.push(init?.method + " " + url.pathname + url.search);
      return Response.json(traces.length === 1 ? { state } : traces.length === 2 ? { id: "op_fixture" } :
        { state: traces.length === 3 ? "queued" : "succeeded" });
    };
    await runWake({ kind: "instabox", accountId: "acc_test", machineId: "m_fixture" }, requestId, 1_000,
      (id) => { assert.equal(id, "acc_test"); return "fixture-token"; }, mock, async () => {});
    assert.deepEqual(traces, [
      "GET /v1/machines/m_fixture", "POST /v1/machines/m_fixture/" + (state === "suspended" ? "resume" : "start"),
      "GET /v1/operations/op_fixture?wait=10", "GET /v1/operations/op_fixture?wait=10",
    ]);
  }
});
