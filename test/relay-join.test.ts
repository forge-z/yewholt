import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { saveConfig, loadConfig } from "../src/config.js";
import { writeKey } from "../src/keys.js";
import { generateKeyPair, verifyEvent, type NostrEvent } from "../src/nostr.js";
import { ownerKeyPath } from "../src/paths.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const origin = "https://buzz.example";
const relay = "wss://buzz.example";
const code = "v2.fake-token";
const invite = `${origin}/invite/${code}`;
const deepLink = `buzz://join?relay=${encodeURIComponent(relay)}&code=${code}`;
const claimPath = "/api/invites/claim";
const policyPath = "/api/join-policy";
const acceptPath = "/api/invites/accept-policy";
const relayKey = generateKeyPair().pubkey;
const policy = { policy: { version: "v1", terms_markdown: "Test terms", age_attestation_required: true } };

async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "yewholt-relay-join-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const owner = generateKeyPair();
  writeKey(ownerKeyPath(home), owner.secret);
  saveConfig(home, { relayUrl: "wss://primary.example", externalRelayPubkey: relayKey });
  const calls: { path: string; method?: string; auth?: string; body: string }[] = [];
  let joinPolicy: unknown = policy;
  let refusal = false;
  let alreadyMember = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const path = req.url!;
    calls.push({ path, method: req.method, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.setHeader("Content-Type", "application/json");
    if (path === policyPath) return res.end(JSON.stringify(joinPolicy));
    if (path === acceptPath) return res.end(JSON.stringify({ receipt: "policy-receipt" }));
    if (path === claimPath && !refusal) return res.end(JSON.stringify({ status: alreadyMember ? "already_member" : "joined" }));
    res.statusCode = 403;
    res.end(JSON.stringify({ error: "invite_exhausted" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), YEWHOLT_HOME: home,
    YEWHOLT_PROVIDER_FILE_STORAGE: "1" };
  async function run(args: string[], stdin = "", replies: [string, string][] = []) {
    const setup = `
      ${replies.length ? 'Object.defineProperty(process.stdin, "isTTY", {value: true});' : ""}
      const realFetch = globalThis.fetch;
      globalThis.fetch = (url, options) => {
        if (new URL(url).origin !== ${JSON.stringify(origin)}) throw new Error("Unexpected test origin");
        return realFetch("http://127.0.0.1:${port}" + new URL(url).pathname, options);
      };`;
    const child = spawn(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(setup), cli, ...args],
      { env, timeout: 8_000 });
    let stdout = "", stderr = "", answered = 0;
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      if (answered < replies.length && stderr.includes(replies[answered][0])) {
        child.stdin.write(replies[answered++][1] + "\n");
      }
    });
    if (!replies.length) child.stdin.end(stdin);
    const [status] = await once(child, "close");
    assert.ok(!(stdout + stderr).includes(owner.secret));
    return { status, stdout, stderr };
  }
  return { home, owner, calls, run, setPolicy: (value: unknown) => { joinPolicy = value; },
    refuse: () => { refusal = true; }, alreadyMember: () => { alreadyMember = true; } };
}

function verifyClaim(call: { path: string; method?: string; auth?: string; body: string }, pubkey: string, receipt?: string) {
  assert.equal(call.path, claimPath);
  assert.equal(call.method, "POST");
  assert.deepEqual(JSON.parse(call.body), { code, ...(receipt ? { policy_receipt: receipt } : {}) });
  assert.match(call.auth ?? "", /^Nostr /);
  const event = JSON.parse(Buffer.from(call.auth!.slice(6), "base64").toString()) as NostrEvent;
  assert.equal(event.kind, 27235);
  assert.equal(event.pubkey, pubkey);
  assert.equal(event.content, "");
  assert.ok(verifyEvent(event));
  assert.deepEqual(event.tags.slice(0, 3), [
    ["u", origin + claimPath], ["method", "POST"], ["payload", createHash("sha256").update(call.body).digest("hex")],
  ]);
}

test("daemon joins from stdin with explicit policy and age flags, then adds the relay", async (t) => {
  const { home, owner, calls, run, alreadyMember } = await fixture(t);
  const result = await run(["relay", "join", "--relay-pubkey", relayKey, "--accept-policy", "--confirm-age"], invite + "\n");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Test terms/);
  assert.ok(!(result.stdout + result.stderr).includes(code));
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
    [policyPath, "GET"], [acceptPath, "POST"], [claimPath, "POST"],
  ]);
  assert.deepEqual(JSON.parse(calls[1].body), { code, policy_version: "v1", age_confirmed: true });
  verifyClaim(calls[2], owner.pubkey, "policy-receipt");
  assert.deepEqual(loadConfig(home).relays, [{ relayUrl: relay, externalRelayPubkey: relayKey }]);
  alreadyMember();
  const repeated = await run(["relay", "join", deepLink, "--accept-policy", "--confirm-age"]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /Already a member of/);
  assert.notEqual(calls[5].auth, calls[2].auth);
});

test("provider accepts consent prompts and claims a deep link with its own key", async (t) => {
  const { home, calls, run } = await fixture(t);
  const pair = await run(["pair"]);
  const provider = /Provider pubkey: ([a-f0-9]{64})/.exec(pair.stdout)?.[1];
  assert.ok(provider, pair.stderr);
  const result = await run(["provider", "join"], "", [
    ["Paste Buzz invite URL", deepLink], ["Accept the policy?", "yes"], ["minimum age?", "yes"],
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Test terms/);
  verifyClaim(calls[2], provider, "policy-receipt");
  assert.equal(loadConfig(home).relays, undefined);
  const stored = readFileSync(join(home, "xdg", "yewholt", "secrets", "identity.json"), "utf8");
  assert.ok(!(result.stdout + result.stderr).includes(JSON.parse(stored)));
});

test("explicit refusals and invalid or exhausted invites don't change relay config", async (t) => {
  const { home, calls, run, setPolicy, refuse } = await fixture(t);
  const setup = ["relay", "join", "--relay-pubkey", relayKey];
  const missingConsent = await run([...setup, "--accept-policy"], invite + "\n");
  assert.equal(missingConsent.status, 1);
  assert.match(missingConsent.stderr, /Explicit consent required/);
  const declined = await run(["provider", "join", invite], "", [["Accept the policy?", "no"]]);
  assert.equal(declined.status, 1);
  assert.match(declined.stderr, /policy not accepted/);
  assert.deepEqual(calls.map(({ path }) => path), [policyPath, policyPath]);
  for (const invalid of [
    "http://buzz.example/invite/" + code, "https://user@buzz.example/invite/" + code,
    deepLink + "&code=second", `${invite}?query=yes`,
  ]) {
    const result = await run([...setup, invalid, "--accept-policy", "--confirm-age"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid Buzz invite URL/);
    assert.ok(!(result.stdout + result.stderr).includes(code));
  }
  const missingPin = await run(["relay", "join", invite]);
  assert.equal(missingPin.status, 1);
  assert.match(missingPin.stderr, /pass --relay-pubkey/);
  assert.equal(calls.length, 2);
  setPolicy({});
  refuse();
  const refused = await run([...setup, invite]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /invite_exhausted/);
  assert.deepEqual(calls.slice(2).map(({ path }) => path), [policyPath, claimPath]);
  assert.deepEqual(JSON.parse(calls[3].body), { code });
  assert.equal(loadConfig(home).relays, undefined);
});
