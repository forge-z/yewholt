import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { handle } from "../provider/engine.js";
import { decodeNsec } from "../provider/package.js";
import { waitForConfirmation } from "../provider/relay.js";
import { ProviderSecrets } from "../provider/secrets.js";
import { runWake } from "../provider/wake.js";
import { controlEvent, decryptControl, verifiedEnvelope } from "../src/control-protocol.js";
import { generateKeyPair, ownerAuthTag, pubkeyOf, type NostrEvent } from "../src/nostr.js";

const root = mkdtempSync(join(homedir(), "yewholt-provider-test-"));
after(() => rmSync(root, { force: true, recursive: true }));
const engine = fileURLToPath(new URL("../provider/engine.js", import.meta.url));
const secret = "0".repeat(63) + "1";
const nsec = "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsmhltgl";
const agentPubkey = pubkeyOf(secret);
const owner = generateKeyPair();
const daemon = generateKeyPair();
const relay = { label: "VM", transport: "relay" as const, relay: "ws://127.0.0.1:13000", daemonPubkey: daemon.pubkey };
const envValue = "hidden-env-value-fixture";
const agent = {
  name: "Agent from Buzz", relay_url: "wss://relay.example.test", private_key_nsec: nsec,
  model: "offline", provider: "test", auth_tag: JSON.stringify(ownerAuthTag(owner.secret, agentPubkey)),
  respond_to: "owner-only", respond_to_allowlist: [], launch: { owner_pubkey: owner.pubkey },
  env_vars: { BUZZ_PRIVATE_KEY: envValue, BUZZ_RELAY_URL: envValue, BUZZ_AUTH_TAG: envValue, NOSTR_PRIVATE_KEY: envValue },
};
const request = { op: "deploy", request_id: randomUUID(), provider_config: {}, agent };
const success = { ok: true, agent_id: agentPubkey };

function setup(id: string) {
  const provider = join(root, id + "-provider"), home = join(root, id + "-daemon");
  mkdirSync(join(provider, "targets"), { recursive: true });
  const target = join(provider, "targets", id + ".json");
  const local = { id, label: "Mac", transport: "local" };
  const writeTarget = (value: unknown, mode = 0o600) => writeFileSync(target, JSON.stringify(value), { mode });
  const run = (input: string) => {
    const result = spawnSync(process.execPath, [engine, id], {
      env: { ...process.env, YEWHOLT_PROVIDER_HOME: provider, YEWHOLT_HOME: home },
      input, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.error, undefined);
    assert.ok(![nsec, secret, envValue].some((value) => (result.stdout + result.stderr).includes(value)), "Secret in output");
    return { status: result.status, output: JSON.parse(result.stdout), stderr: result.stderr };
  };
  return { target, provider, home, local, writeTarget, run };
}

test("provider info golden JSON reads no target or secret and advertises no forbidden fields", () => {
  const { run } = setup("info");
  const reply = run(JSON.stringify({ op: "info", request_id: request.request_id }));
  assert.deepEqual(reply, {
    status: 0, stderr: "",
    output: {
      ok: true, name: "Yewholt", version: "0.1.0", protocol_version: 1,
      description: "Deploy an agent to a configured Yewholt target.", config_schema: { type: "object", properties: {} },
    },
  });
  const check = (schema: object) => {
    for (const [key, value] of Object.entries(schema)) {
      assert.doesNotMatch(key, /key|token|secret|auth|password|credential|passphrase|nsec/i);
      if (value && typeof value === "object") check(value);
    }
  };
  check(reply.output.config_schema);
});

test("provider exits nonzero with one safe JSON response for empty, malformed, or unsupported calls", () => {
  const { run } = setup("error");
  for (const [input, error] of [
    ["", "Expected one JSON request"], ["{" + nsec, "Expected one JSON request"],
    [JSON.stringify({ op: envValue, request_id: request.request_id }), "Unsupported operation"],
    [JSON.stringify({ ...request, request_id: "not-a-uuid" }), "Invalid request"],
    [JSON.stringify({ ...request, provider_config: { token: envValue } }), "Invalid provider configuration"],
  ]) assert.deepEqual(run(input), { status: 1, stderr: "", output: { ok: false, error } });
});

test("provider refuses missing, non-private, secret-bearing, mismatched, and nonregular targets", () => {
  const { target, local, writeTarget, run } = setup("target");
  const call = () => assert.deepEqual(run(JSON.stringify(request)), {
    status: 1, stderr: "", output: { ok: false, error: "Invalid or missing target configuration" },
  });
  call();
  writeTarget(local, 0o644);
  call();
  chmodSync(target, 0o600);
  writeTarget({ ...local, token: envValue });
  call();
  writeTarget({ ...relay, id: local.id, wake: { kind: "command", cmd: "true", password: envValue } });
  call();
  writeTarget({ ...relay, id: local.id, relay: "wss://relay.example.test/?token=" + envValue });
  call();
  writeTarget({ ...relay, id: local.id, daemonPubkey: "0".repeat(64) });
  call();
  writeTarget({ ...local, id: "another-target" });
  call();
  const realTarget = target + ".real";
  writeFileSync(realTarget, JSON.stringify(local), { mode: 0o600 });
  rmSync(target);
  symlinkSync(realTarget, target);
  call();
});

test("local deploy golden JSON validates Buzz identity and atomically writes a single private provisioning file", () => {
  const { home, provider, local, writeTarget, run } = setup("local");
  writeTarget(local);
  assert.equal(decodeNsec(nsec), secret);
  for (const patch of [
    { private_key_nsec: undefined }, { private_key_nsec: nsec.slice(0, -1) + "q" },
    { private_key_nsec: "0".repeat(64) }, { auth_tag: "not JSON " + nsec },
    { auth_tag: JSON.stringify(ownerAuthTag(owner.secret, daemon.pubkey)) },
    { relay_url: "https://not-a-websocket.example" }, { launch: { owner_pubkey: daemon.pubkey } },
    { respond_to: "allowlist" }, { env_vars: { TOKEN: { value: envValue } } },
  ]) {
    assert.deepEqual(run(JSON.stringify({ ...request, agent: { ...agent, ...patch } })), {
      status: 1, stderr: "", output: { ok: false, error: "Invalid agent provisioning package" },
    });
  }
  const call = (input = request) => run(JSON.stringify(input));
  assert.deepEqual(call(), { status: 0, stderr: "", output: success });
  const path = join(home, "agents", agentPubkey + ".json");
  const inode = statSync(path, { bigint: true }).ino;
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    name: agent.name, nsec: secret, authTag: JSON.parse(agent.auth_tag), relayUrl: agent.relay_url,
    model: { provider: "test", modelId: "offline", label: "offline" },
    permissions: ["post", "read", "code"], respondTo: "allowlist", respondToAllowlist: [owner.pubkey],
  });
  assert.equal(call({ ...request, agent: { ...agent, name: "Ignored repeat" } }).status, 0);
  assert.equal(call({ ...request, request_id: randomUUID() }).status, 0);
  assert.equal(statSync(path, { bigint: true }).ino, inode);
  const other = generateKeyPair();
  assert.equal(call({ ...request, agent: { ...agent, private_key_nsec: other.secret,
    auth_tag: JSON.stringify(ownerAuthTag(owner.secret, other.pubkey)) } }).status, 1);
  assert.deepEqual(readdirSync(join(home, "agents")), [agentPubkey + ".json"]);
  assert.deepEqual(readdirSync(provider), ["targets"]);
});

test("relay deploy waits two 120s windows, wakes only on timeout, and reuses the exact encrypted event", async () => {
  const wake = { kind: "command" as const, cmd: "trusted-hook" };
  const provider = generateKeyPair();
  const attempts: string[] = [];
  let mode: "confirmed" | "refused" | "timeout" = "confirmed";
  let first: NostrEvent | undefined;
  const services: NonNullable<Parameters<typeof handle>[2]> = {
    loadTarget: () => ({ ...relay, wake }),
    identity: () => provider.secret,
    wake: async (config, id, timeout) => {
      assert.deepEqual([config, id, timeout], [wake, request.request_id, 120_000]);
      attempts.push("wake");
    },
    wait: async (_, __, event, job, pubkey, timeout) => {
      assert.deepEqual([job, pubkey, timeout], [request.request_id, agentPubkey, 120_000]);
      attempts.push("wait");
      if (!first) {
        first = event;
        const envelope = verifiedEnvelope(event, daemon.pubkey, "deploy");
        assert.ok(envelope);
        const contents = JSON.stringify(decryptControl(envelope, daemon.secret, provider.pubkey));
        assert.ok(!contents.includes(envValue) && !contents.includes("env_vars"));
        return mode === "refused" ? mode : "timeout";
      }
      assert.equal(event, first);
      return mode;
    },
  };
  assert.deepEqual(await handle("vm", request, services), success);
  assert.deepEqual(attempts.splice(0), ["wait", "wake", "wait"]);
  first = undefined;
  mode = "timeout";
  assert.deepEqual(await handle("vm", request, services), { ok: false, error: "No daemon confirmation received" });
  assert.deepEqual(attempts.splice(0), ["wait", "wake", "wait"]);
  first = undefined;
  mode = "refused";
  assert.deepEqual(await handle("vm", request, services), { ok: false, error: "Deploy refused by the relay or daemon" });
  assert.deepEqual(attempts, ["wait"]);
  assert.deepEqual(await handle("vm", request, { ...services, wait: async () => { throw new Error(nsec + envValue); } }),
    { ok: false, error: "Deploy failed" });
});

test("relay OK alone is insufficient; confirmation must be signed by the paired daemon and match both ids", async () => {
  const provider = generateKeyPair();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    let allow = false;
    const context = { agentPubkey, requestId: request.request_id };
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
      if (init?.method === "POST") assert.equal(headers.get("idempotency-key"), "yewholt-" + request.request_id);
      traces.push(init?.method + " " + url.pathname + url.search);
      return Response.json(traces.length === 1 ? { state } : traces.length === 2 ? { id: "op_fixture" } :
        { state: traces.length === 3 ? "queued" : "succeeded" });
    };
    await runWake({ kind: "instabox", accountId: "acc_test", machineId: "m_fixture" }, request.request_id, 1_000,
      (id) => { assert.equal(id, "acc_test"); return "fixture-token"; }, mock, async () => {});
    assert.deepEqual(traces, [
      "GET /v1/machines/m_fixture", "POST /v1/machines/m_fixture/" + (state === "suspended" ? "resume" : "start"),
      "GET /v1/operations/op_fixture?wait=10", "GET /v1/operations/op_fixture?wait=10",
    ]);
  }
});
