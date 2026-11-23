import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { writePrivateJson } from "../../dist/src/control-files.js";
import { RelayClient } from "../../dist/src/nostr-client.js";
import { generateKeyPair, ownerAuthTag, signEvent, verifyEvent } from "../../dist/src/nostr.js";
import { loadTarget } from "../../dist/provider/target.js";

const cli = fileURLToPath(new URL("../../dist/src/cli.js", import.meta.url));
const composeFile = fileURLToPath(new URL("./compose.yml", import.meta.url));
const model = "offline/fixture";

function run(file, args, { env, input, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, timeout, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} ${args.at(-1) ?? ""} failed (${error.code ?? error.signal})\n${stdout}${stderr}`));
      else resolve(stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function until(check, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

async function createInvite(origin, owner) {
  const url = `${origin}/api/invites`;
  const body = JSON.stringify({ max_uses: 1 });
  const auth = signEvent(owner, 27235, "", [
    ["u", url], ["method", "POST"], ["payload", createHash("sha256").update(body).digest("hex")],
    ["nonce", randomUUID()],
  ]);
  const response = await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(10_000), headers: {
    "Content-Type": "application/json", Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
  } });
  assert.ok(response.ok, `Buzz invite creation failed (HTTP ${response.status})`);
  const { code, url: invite } = await response.json();
  assert.ok(typeof code === "string" && /^[\w.-]+$/.test(code), "Buzz did not mint an invite code");
  assert.ok(invite === `${origin}/invite/${code}`, "Buzz returned an unexpected invite URL");
  return invite;
}

async function readProfile(client, pubkey) {
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("No hosted agent profile from Buzz")), 10_000);
      client.subscribe("agent-profile", [{ kinds: [0], authors: [pubkey], limit: 1 }], resolve,
        (_id, reason) => reject(new Error(reason)));
    });
  } finally {
    clearTimeout(timer);
    client.unsubscribe("agent-profile");
  }
}

test("onboard a new Yewholt daemon from one Buzz invite, select a model, and host an agent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "yewholt-e2e-"));
  const owner = generateKeyPair();
  const relay = generateKeyPair();
  const port = process.env.YEWHOLT_E2E_PORT ?? "3443";
  const origin = `https://localhost:${port}`;
  const community = `wss://localhost:${port}`;
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  const daemonHome = join(dir, "daemon");
  const providerHome = join(dir, "provider");
  const piHome = join(dir, "pi");
  const bin = join(dir, "bin");
  const childEnv = { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), NODE_EXTRA_CA_CERTS: cert,
    YEWHOLT_HOME: daemonHome, YEWHOLT_PROVIDER_HOME: providerHome, YEWHOLT_PROVIDER_BIN_DIR: bin,
    PI_CODING_AGENT_DIR: piHome };
  const project = `yh-e2e-${randomUUID()}`;
  const compose = (args, timeout) => run("docker", ["compose", "-f", composeFile, "-p", project, ...args], {
    env: { ...process.env, E2E_PORT: port, E2E_OWNER_PUBKEY: owner.pubkey, E2E_RELAY_SECRET: relay.secret, E2E_TLS_DIR: dir }, timeout,
  });
  const yh = (args, input) => run(process.execPath, [cli, ...args], { env: childEnv, input, timeout: 60_000 });
  const bridge = async (op, args = {}) => JSON.parse(await run(join(bin, "yewholt-buzz-bridge"), [], {
    env: childEnv, input: JSON.stringify({ op, community, ...args }),
  }));
  const ownerClient = new RelayClient(community, owner.secret);
  const originalCAs = getCACertificates("default");
  let started = false;
  let joined = false;
  try {
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost", "-keyout", key, "-out", cert]);
    setDefaultCACertificates([...originalCAs, await readFile(cert, "utf8")]);
    started = true;
    await compose(["up", "-d"], 180_000);
    let readinessError;
    await until(async () => {
      try {
        const response = await fetch(origin, { headers: { Accept: "application/nostr+json" }, signal: AbortSignal.timeout(2000) });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).self, relay.pubkey);
        return true;
      } catch (error) {
        readinessError = error;
      }
    }, "Buzz relay readiness").catch((error) => {
      throw new Error(error.message, { cause: readinessError });
    });

    await ownerClient.connect();
    // The daemon discovers Buzz's signing key from a relay-signed channel event.
    const channel = signEvent(owner.secret, 9007, "", [["h", randomUUID()], ["name", "Onboarding smoke test"],
      ["channel_type", "stream"], ["visibility", "open"]]);
    const channelAck = await Promise.race([ownerClient.publish(channel), delay(5000, { ok: false, message: "timed out" }, { ref: false })]);
    assert.ok(channelAck.ok, channelAck.message);
    const invite = await createInvite(origin, owner.secret);
    t.diagnostic("Buzz minted a single-use community invite");

    await mkdir(piHome);
    await writeFile(join(piHome, "models.json"), JSON.stringify({ providers: { offline: {
      baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "test-only", models: [{ id: "fixture" }],
    } } }));
    joined = true;
    const output = await yh(["join", "--daemon"], `${invite}\n`);
    const daemon = /^Joined \S+ as ([a-f0-9]{64})$/m.exec(output)?.[1];
    assert.ok(daemon, "yh join did not confirm new Buzz membership");
    assert.match(await yh(["status"]), /^daemon: running/m);
    t.diagnostic("yh joined from stdin with no relay arguments and started the daemon");

    writePrivateJson(join(providerHome, "secrets", "identity.json"), owner.secret);
    await yh(["provider", "install"]);
    const target = await until(async () => {
      const result = await bridge("targets");
      assert.equal(result.ok, true);
      return result.targets.find((id) => loadTarget(id, providerHome).daemonPubkey === daemon);
    }, "the daemon's owner pairing offer");
    assert.deepEqual(await bridge("models", { target }), { ok: true, models: [model] });
    t.diagnostic("The Buzz bridge discovered the daemon and listed the offline Pi model");

    const name = "Onboarding smoke agent";
    const { ok, pubkey } = await bridge("provision", { target, name, code: false, model });
    assert.equal(ok, true);
    assert.match(pubkey, /^[a-f0-9]{64}$/);
    assert.deepEqual(await bridge("activate", { pubkey, auth: ownerAuthTag(owner.secret, pubkey) }), { ok: true });
    const profile = await readProfile(ownerClient, pubkey);
    assert.ok(verifyEvent(profile) && profile.pubkey === pubkey);
    assert.equal(JSON.parse(profile.content).name, name);
    await until(async () => JSON.parse(await yh(["agents", "list"])).some((agent) =>
      agent.pubkey === pubkey.slice(0, 8) && agent.name === name && agent.state === "active"), "active agent registration");
    assert.deepEqual(await bridge("model", { pubkey }), { ok: true, models: [model], model });
    t.diagnostic("Buzz stored the signed agent profile; Yewholt reports the agent active with the selected model");
  } catch (error) {
    if (joined) t.diagnostic(await readFile(join(daemonHome, "daemon.log"), "utf8").catch(() => "No daemon log yet"));
    if (started) t.diagnostic(await compose(["logs", "--tail=50"]).catch((error) => error.message));
    throw error;
  } finally {
    setDefaultCACertificates(originalCAs);
    await ownerClient.close();
    try {
      if (joined) await yh(["stop"]);
    } finally {
      try {
        if (started) await compose(["down", "-v"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
});
