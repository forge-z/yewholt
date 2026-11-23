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
import { gzipSync } from "node:zlib";
import { loadTarget } from "../provider/target.js";
import { saveConfig, loadConfig } from "../src/config.js";
import { writeKey } from "../src/keys.js";
import { generateKeyPair, pubkeyOf, signEvent, verifyEvent, type NostrEvent } from "../src/nostr.js";
import { envFilePath, ownerKeyPath } from "../src/paths.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const origin = "https://buzz.example";
const relay = "wss://buzz.example";
const code = "v2.fake-token";
const invite = `${origin}/invite/${code}`;
const deepLink = `buzz://join?relay=${encodeURIComponent(relay)}&code=${code}`;
const claimPath = "/api/invites/claim";
const policyPath = "/api/join-policy";
const acceptPath = "/api/invites/accept-policy";
const relayIdentity = generateKeyPair();
const relayKey = relayIdentity.pubkey;
const policy = { policy: { version: "v1", terms_markdown: "Test terms", age_attestation_required: true } };

async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "yewholt-relay-join-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const owner = generateKeyPair();
  writeKey(ownerKeyPath(home), owner.secret);
  saveConfig(home, { relayUrl: "wss://primary.example", externalRelayPubkey: relayKey });
  const calls: { path: string; method?: string; auth?: string; body: string; encoding?: string }[] = [];
  const responses = new Map<string, { status: number; type?: string; body: string | Buffer }>();
  let joinPolicy: unknown = policy;
  let refusal = false;
  let alreadyMember = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const path = req.url!;
    calls.push({ path, method: req.method, auth: req.headers.authorization, body: Buffer.concat(chunks).toString(),
      encoding: req.headers["accept-encoding"] });
    const response = responses.get(path);
    if (response) {
      res.writeHead(response.status, response.type ? { "Content-Type": response.type } : {});
      return res.end(response.body);
    }
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
  async function run(args: string[], stdin = "", replies: [string, string][] = [], extraEnv = {}) {
    const setup = `
      const { RelayClient } = await import(${JSON.stringify(new URL("../src/nostr-client.js", import.meta.url).href)});
      RelayClient.prototype.connect = async () => {};
      RelayClient.prototype.subscribe = function(id, filters, onEvent) {
        onEvent(${JSON.stringify(signEvent(relayIdentity.secret, 39000, "", [["d", "test"]]))});
      };
      ${replies.length ? 'Object.defineProperty(process.stdin, "isTTY", {value: true});' : ""}
      const realFetch = globalThis.fetch;
      globalThis.fetch = (url, options) => {
        if (new URL(url).origin !== ${JSON.stringify(origin)}) throw new Error("Unexpected test origin");
        return realFetch("http://127.0.0.1:${port}" + new URL(url).pathname, options);
      };`;
    const child = spawn(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(setup), cli, ...args],
      { env: { ...env, ...extraEnv }, timeout: 8_000 });
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
  return { home, owner, calls, run, responses, setPolicy: (value: unknown) => { joinPolicy = value; },
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
  assert.match(result.stdout, /Terms: https:\/\/buzz.example\/api\/join-policy\/terms/);
  assert.ok(!result.stdout.includes("Test terms"));
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

test("unified join prompts once, admits both Mac identities, and registers the local target", async (t) => {
  const { home, owner, calls, run } = await fixture(t);
  const result = await run(["join"], "", [
    ["Paste Buzz invite URL", invite], ["Accept the policy?", "yes"], ["minimum age?", "yes"],
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /up to 2 invite uses/);
  assert.match(result.stdout, /Mac provider: joined/);
  assert.match(result.stdout, /My Mac daemon: joined/);
  assert.deepEqual(calls.map(({ path }) => path), [policyPath, acceptPath, claimPath, claimPath]);
  verifyClaim(calls[3], owner.pubkey, "policy-receipt");
  assert.equal(loadTarget("mac", join(home, "xdg", "yewholt")).daemonPubkey, owner.pubkey);
  assert.ok(!result.stdout.includes(code));
});

test("yh join --local creates, admits and starts a daemon in an uninitialized home", async (t) => {
  const { home, calls, responses, run } = await fixture(t);
  const daemonHome = join(home, "new daemon");
  responses.set("/", { status: 200, type: "application/nostr+json", body: JSON.stringify({ self: relayKey }) });
  try {
    const result = await run(["join", "--local", "--accept-policy", "--confirm-age"], invite + "\n", [],
      { YEWHOLT_HOME: daemonHome });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(calls.map(({ path }) => path), [policyPath, acceptPath, "/", claimPath, claimPath]);
    assert.equal(loadConfig(daemonHome).relayUrl, relay);
    assert.equal(loadConfig(daemonHome).externalRelayPubkey, relayKey);
    const secret = readFileSync(ownerKeyPath(daemonHome), "utf8").trim();
    const daemon = pubkeyOf(secret);
    verifyClaim(calls[4], daemon, "policy-receipt");
    assert.equal(loadTarget("mac", join(home, "xdg", "yewholt")).daemonPubkey, daemon);
    assert.ok(readFileSync(envFilePath(daemonHome), "utf8").includes("Yewholt provider keys"));
    assert.ok(!(result.stdout + result.stderr).includes(secret));
    const status = await run(["status", "--home", daemonHome]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /^daemon: running \(\d+\)$/m);
  } finally {
    await run(["stop", "--home", daemonHome]);
  }
});

test("unified join continues after exhausted uses and exits nonzero with per-machine reasons", async (t) => {
  const { calls, run, refuse } = await fixture(t);
  refuse();
  const result = await run(["join", "--accept-policy", "--confirm-age"], invite + "\n");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Mac provider: failed: Buzz invite claim failed \(HTTP 403\): invite_exhausted/);
  assert.match(result.stdout, /My Mac daemon: failed: Buzz invite claim failed \(HTTP 403\): invite_exhausted/);
  assert.deepEqual(calls.map(({ path }) => path), [policyPath, acceptPath, claimPath, claimPath]);
  assert.ok(!(result.stdout + result.stderr).includes(code));
});

test("daemon join discovers the relay signing key when no pin was supplied", async (t) => {
  const { home, run } = await fixture(t);
  const result = await run(["relay", "join", invite, "--accept-policy", "--confirm-age"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(loadConfig(home).relays, [{ relayUrl: relay, externalRelayPubkey: relayKey }]);
});

test("daemon join rejects a supplied pin that differs from the discovered key", async (t) => {
  const { home, run } = await fixture(t);
  const result = await run(["relay", "join", invite, "--relay-pubkey", generateKeyPair().pubkey, "--accept-policy", "--confirm-age"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Discovered relay signing key differs/);
  assert.equal(loadConfig(home).relays, undefined);
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
  assert.match(result.stdout, /Terms: https:\/\/buzz.example\/api\/join-policy\/terms/);
  assert.ok(!result.stdout.includes("Test terms"));
  verifyClaim(calls[2], provider, "policy-receipt");
  assert.equal(loadConfig(home).relays, undefined);
  const stored = readFileSync(join(home, "xdg", "yewholt", "secrets", "identity.json"), "utf8");
  assert.ok(!(result.stdout + result.stderr).includes(JSON.parse(stored)));
});

test("policy links stay concise, omit absent or empty privacy text, and support full text opt-in", async (t) => {
  const { run, setPolicy } = await fixture(t);
  setPolicy({ policy: { ...policy.policy, terms_markdown: "T".repeat(84 * 1024),
    privacy_markdown: "P".repeat(26 * 1024) } });
  const result = await run(["provider", "join", invite], "", [
    ["Accept the policy?", "yes"], ["minimum age?", "yes"],
  ]);
  assert.equal(result.status, 0, result.stderr);
  const summary = "Terms: https://buzz.example/api/join-policy/terms\nPrivacy: https://buzz.example/api/join-policy/privacy";
  const prompt = "Accept the policy? Type yes to continue: ";
  assert.equal(result.stdout.split("\n").slice(0, 2).join("\n"), summary);
  assert.ok(result.stderr.includes(prompt));
  assert.ok(!result.stdout.includes("T".repeat(100)) && !result.stdout.includes("P".repeat(100)));
  assert.ok(result.stdout.length < 500);
  t.diagnostic(summary + "\n" + prompt);

  setPolicy({ policy: { ...policy.policy, terms_markdown: "" } });
  const empty = await run(["provider", "join", invite, "--accept-policy", "--confirm-age"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /Terms: https:\/\/buzz.example\/api\/join-policy\/terms/);
  assert.ok(!empty.stdout.includes("Privacy:"));
  for (const privacy_markdown of ["", " \n"]) {
    setPolicy({ policy: { ...policy.policy, privacy_markdown } });
    const noPrivacy = await run(["provider", "join", invite, "--accept-policy", "--confirm-age"]);
    assert.equal(noPrivacy.status, 0, noPrivacy.stderr);
    assert.ok(!noPrivacy.stdout.includes("Privacy:"));
  }

  setPolicy({ policy: { ...policy.policy, terms_markdown: "Test\x1b terms", privacy_markdown: "Test privacy" } });
  const full = await run(["provider", "join", invite, "--accept-policy", "--confirm-age"], "", [], { YH_SHOW_TERMS: "1" });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /Terms for wss:\/\/buzz.example:\nTest terms\nPrivacy policy:\nTest privacy/);
  assert.ok(!full.stdout.includes("\x1b"));
  assert.ok(!full.stdout.includes("Terms: https://"));
});

test("both join commands decode raw gzip without content headers at every HTTP step", async (t) => {
  const { calls, run, responses } = await fixture(t);
  responses.set(policyPath, { status: 200, body: gzipSync(JSON.stringify(policy)) });
  responses.set(acceptPath, { status: 200, body: gzipSync(JSON.stringify({ receipt: "policy-receipt" })) });
  responses.set(claimPath, { status: 200, body: gzipSync(JSON.stringify({ status: "joined" })) });
  for (const command of ["provider", "relay"]) {
    const result = await run([command, "join", invite, "--accept-policy", "--confirm-age",
      ...(command === "relay" ? ["--relay-pubkey", relayKey] : [])]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Terms: https:\/\/buzz.example\/api\/join-policy\/terms/);
    assert.ok(!result.stdout.includes("Test terms"));
    assert.match(result.stdout, /Joined wss:\/\/buzz.example/);
  }
  assert.equal(calls.length, 6);
  assert.ok(calls.every(({ encoding }) => encoding === "identity"));
});

test("gzip errors are decoded and redacted; empty or corrupt gzip is rejected safely", async (t) => {
  const { run, responses } = await fixture(t);
  const cases = [
    { status: 403, body: gzipSync(JSON.stringify({ error: `invalid ${code}` })),
      error: /Could not read Buzz join policy \(HTTP 403\): invalid \[redacted\]/ },
    { status: 200, body: gzipSync(""), error: /HTTP 200\): expected a JSON object/ },
    { status: 200, body: Buffer.from([0x1f, 0x8b, 0x00]), error: /HTTP 200\): expected a JSON object/ },
  ];
  for (const { status, body, error } of cases) {
    responses.set(policyPath, { status, body });
    const result = await run(["provider", "join", invite, "--accept-policy", "--confirm-age"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.ok(!(result.stdout + result.stderr).includes(code));
  }
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

test("join reports the failing HTTP step and safe server details without exposing invite material", async (t) => {
  const { home, calls, run, responses } = await fixture(t);
  const setup = ["relay", "join", "--relay-pubkey", relayKey, "--accept-policy", "--confirm-age"];
  const cases = [
    [policyPath, 200, "text/html", "<html>Not the policy</html>",
      /Could not read Buzz join policy \(HTTP 200\): expected a JSON object/, [policyPath]],
    [acceptPath, 400, "application/json", '{"error":"join_policy_not_accepted"}',
      /Buzz did not accept the join policy \(HTTP 400\): join_policy_not_accepted/, [policyPath, acceptPath]],
    [acceptPath, 200, "application/json", "",
      /Buzz did not accept the join policy \(HTTP 200\): expected a JSON object/, [policyPath, acceptPath]],
    [claimPath, 502, "text/html", "<html>Bad Gateway</html>",
      /Buzz invite claim failed \(HTTP 502\)/, [policyPath, acceptPath, claimPath]],
    [claimPath, 429, "text/plain", `Too many requests for ${invite}\x1b\n(policy-receipt)`,
      /Buzz invite claim failed \(HTTP 429\): Too many requests for https:\/\/buzz\.example\/invite\/\[redacted\] \(\[redacted\]\)/,
      [policyPath, acceptPath, claimPath]],
    [claimPath, 403, "application/json", '{"error":"invite_exhausted"}',
      /Buzz invite claim failed \(HTTP 403\): invite_exhausted/, [policyPath, acceptPath, claimPath]],
  ] as const;
  for (const [path, status, type, body, error, expectedCalls] of cases) {
    const start = calls.length;
    responses.set(path, { status, type, body });
    const result = await run(setup, invite + "\n");
    responses.delete(path);
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.ok(!(result.stdout + result.stderr).includes(code));
    assert.ok(!result.stderr.includes("policy-receipt") && !result.stderr.includes("<html>"));
    assert.deepEqual(calls.slice(start).map((call) => call.path), expectedCalls);
  }
  assert.equal(loadConfig(home).relays, undefined);
});
