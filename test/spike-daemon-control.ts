import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, mkdtempSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PRESENCE, RUNTIME_PROFILE } from "../src/agents.js";
import { saveConfig } from "../src/config.js";
import { CONTROL_KIND, controlEvent, decryptControl, verifiedEnvelope, type Confirmation } from "../src/control-protocol.js";
import { readKey, writeKey } from "../src/keys.js";
import { RelayClient } from "../src/nostr-client.js";
import { generateKeyPair, ownerAuthTag, pubkeyOf, type NostrEvent } from "../src/nostr.js";
import { agentsDir, ownerKeyPath, statusPath } from "../src/paths.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function waitFor<T>(label: string, probe: () => T | undefined): Promise<T> {
  const end = Date.now() + 20_000;
  do {
    const value = probe();
    if (value !== undefined) return value;
    await sleep(50);
  } while (Date.now() < end);
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const [relay, ownerKeyFile] = process.argv.slice(2);
  assert.ok(relay && ownerKeyFile, "Usage: node dist/test/spike-daemon-control.js ws://127.0.0.1:13000 /path/to/disposable/owner.key");
  const url = new URL(relay);
  assert.ok(url.protocol === "ws:" && url.hostname === "127.0.0.1" && url.port && !url.username && !url.password,
    "Run only against a disposable loopback relay");
  const home = mkdtempSync(join(homedir(), "yewholt-daemon-control-"));
  const ownerSecret = readKey(ownerKeyFile);
  const owner = pubkeyOf(ownerSecret);
  const provider = generateKeyPair();
  const agent = generateKeyPair();
  const envValue = "sensitive-fixture-env-value";
  const fixture = {
    name: "Multi-VM test agent", nsec: agent.secret, authTag: ownerAuthTag(ownerSecret, agent.pubkey),
    model: { provider: "test", modelId: "offline", label: "test/offline" },
    env_vars: { TOKEN: envValue },
  };
  const env = { PATH: process.env.PATH, HOME: home, YEWHOLT_HOME: home, YEWHOLT_MODEL: "test/offline" };
  writeKey(ownerKeyPath(home), ownerSecret);
  const relayPubkey = process.env.YEWHOLT_RELAY_PUBKEY;
  assert.ok(relayPubkey, "Set YEWHOLT_RELAY_PUBKEY to the disposable relay's public key");
  saveConfig(home, { relayUrl: relay, externalRelayPubkey: relayPubkey });
  const runCli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, `CLI failed: ${args.slice(0, 2).join(" ")}`);
    return result.stdout;
  };
  const agentFile = join(agentsDir(home), `${agent.pubkey}.json`);
  const daemonLog = join(home, "integration-daemon.log");
  console.log(JSON.stringify({ disposableHome: home }));
  runCli("pair", "add", provider.pubkey, "--label", "Local integration");
  assert.equal(JSON.parse(runCli("pair", "list"))[0].pubkey, provider.pubkey);

  const client = new RelayClient(relay, provider.secret, ownerAuthTag(ownerSecret, provider.pubkey));
  const confirmations = new Map<string, Confirmation[]>();
  const runtime = new Map<number, NostrEvent>();
  let daemon: ChildProcess | undefined;
  try {
    await client.connect();
    client.subscribe("confirmations", [{ kinds: [CONTROL_KIND], "#p": [provider.pubkey] }], (event) => {
      const envelope = event.pubkey === owner && verifiedEnvelope(event, provider.pubkey, "confirmation");
      if (!envelope || envelope.agentPubkey !== agent.pubkey) return;
      const message = decryptControl(envelope, provider.secret, owner) as Confirmation;
      assert.equal(message.job, envelope.requestId);
      assert.equal(message.agentPubkey, envelope.agentPubkey);
      confirmations.set(message.job, [...(confirmations.get(message.job) ?? []), message]);
    });
    client.subscribe("runtime", [{ kinds: [RUNTIME_PROFILE, PRESENCE], authors: [agent.pubkey] }],
      (event) => runtime.set(event.kind, event));
    const submit = async (requestId: string, body = fixture) => {
      const event = controlEvent(provider.secret, owner, "deploy", { agentPubkey: agent.pubkey, requestId }, body);
      const result = await Promise.race([client.publish(event), sleep(10_000, undefined, { ref: false })]);
      assert.ok(result?.ok, "Relay did not accept the deploy event");
    };
    const first = randomUUID();
    await submit(first);
    const log = openSync(daemonLog, "wx", 0o600);
    try {
      daemon = spawn(process.execPath, [cli, "daemon"], { env, stdio: ["ignore", log, log] });
    } finally {
      closeSync(log);
    }
    assert.equal((await waitFor("confirmation after daemon starts", () => confirmations.get(first)?.[0])).ok, true);
    await waitFor("kind 10100 and online kind 20001", () =>
      runtime.has(RUNTIME_PROFILE) && runtime.get(PRESENCE)?.content === "online" ? true : undefined);
    const conversation = await waitFor("active external agent", () => {
      const state = JSON.parse(readFileSync(statusPath(home), "utf8"));
      const bot = state.bots.find((item: { pubkey: string }) => item.pubkey === agent.pubkey);
      return bot?.status === "active" ? bot.conversationId : undefined;
    });
    const initial = statSync(agentFile, { bigint: true });
    assert.equal(initial.mode & 0o777n, 0o600n);
    const agents = JSON.parse(runCli("agents", "list"));
    assert.equal(agents[0].target, owner);
    assert.equal(agents[0].state, "active");
    assert.ok(agents[0].lastDeploy);
    console.log(JSON.stringify({ offlineReplay: "confirmed", status: "active", published: [RUNTIME_PROFILE, PRESENCE] }));

    await submit(first);
    assert.equal((await waitFor("confirmation on job retry", () => confirmations.get(first)?.[1])).ok, true);
    const duplicate = randomUUID();
    await submit(duplicate);
    assert.equal((await waitFor("confirmation on identical deploy", () => confirmations.get(duplicate)?.[0])).ok, true);
    assert.equal(statSync(agentFile, { bigint: true }).ino, initial.ino);
    assert.equal(JSON.parse(readFileSync(statusPath(home), "utf8")).bots.find((item: { pubkey: string }) => item.pubkey === agent.pubkey).conversationId, conversation);
    console.log(JSON.stringify({ repeatJob: "confirmed", identicalPayload: "confirmed without replacement or duplicate" }));

    runCli("pair", "remove", provider.pubkey);
    assert.deepEqual(JSON.parse(runCli("pair", "list")), []);
    const revoked = randomUUID();
    await submit(revoked, { ...fixture, name: "Must not be installed" });
    const denial = await waitFor("confirmation after revocation", () => confirmations.get(revoked)?.[0]);
    assert.equal(denial.ok, false);
    assert.equal(denial.error, "provider not paired");
    assert.equal(statSync(agentFile, { bigint: true }).ino, initial.ino);
    const observable = [readFileSync(statusPath(home), "utf8"), readFileSync(daemonLog, "utf8"), JSON.stringify(denial),
      JSON.stringify(agents), readFileSync(join(home, "state", "control.json"), "utf8")];
    assert.ok(observable.every((value) => !value.includes(agent.secret) && !value.includes(envValue)), "Secret surfaced");
    console.log(JSON.stringify({ revoked: denial.error, secretOutput: false }));
  } finally {
    await client.close();
    if (daemon && daemon.exitCode === null) {
      const exited = once(daemon, "exit");
      daemon.kill("SIGTERM");
      const exit = await Promise.race([exited, sleep(5_000, undefined, { ref: false })]);
      if (!exit) {
        daemon.kill("SIGKILL");
        await exited;
      }
    }
  }
}

await main();
