import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ProviderSecrets } from "../provider/secrets.js";
import { provisioning } from "../provider/package.js";
import { PRESENCE, RUNTIME_PROFILE } from "../src/agents.js";
import { saveConfig } from "../src/config.js";
import { writePrivateJson } from "../src/control-files.js";
import { readKey, writeKey } from "../src/keys.js";
import { RelayClient } from "../src/nostr-client.js";
import { generateKeyPair, ownerAuthTag, pubkeyOf, verifyEvent } from "../src/nostr.js";
import { agentsDir, ownerKeyPath, statusPath } from "../src/paths.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const engine = fileURLToPath(new URL("../provider/engine.js", import.meta.url));
const shq = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const pause = (ms: number) => sleep(ms);

async function until<T>(label: string, check: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 20_000;
  do {
    try {
      const value = check();
      if (value !== undefined) return value;
    } catch {
      // Files and status may not be available until after daemon start.
    }
    await pause(100);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for " + label);
}

async function main() {
  const [relay, ownerFile, container, payloadFile] = process.argv.slice(2);
  assert.ok(relay && ownerFile && container, "Usage: node dist/test/spike-provider.js ws://127.0.0.1:13000 /path/to/disposable/owner.key disposable-relay-container [deploy.json]");
  const url = new URL(relay);
  assert.equal(url.href, "ws://127.0.0.1:" + url.port + "/", "Use a disposable loopback relay only");
  assert.ok(url.port && /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(container));
  const portCheck = spawnSync("docker", ["port", container, "3000/tcp"], { encoding: "utf8", timeout: 5_000 });
  assert.ok(portCheck.status === 0 && portCheck.stdout.trim() === "127.0.0.1:" + url.port, "Container must publish only the disposable loopback relay port");
  const home = mkdtempSync(join(homedir(), "yewholt-phase2-integration-"));
  const providerHome = join(home, "provider");
  const ownerSecret = readKey(ownerFile);
  const daemonPubkey = pubkeyOf(ownerSecret);
  const providerSecret = new ProviderSecrets(providerHome, false).identity();
  const providerPubkey = pubkeyOf(providerSecret);
  const key = generateKeyPair();
  const fixture = "phase2-private-environment-fixture";
  const makeRequest = () => ({
    op: "deploy", request_id: randomUUID(), provider_config: {},
    agent: {
      name: "Phase 2 Buzz agent", relay_url: relay, private_key_nsec: key.secret,
      auth_tag: JSON.stringify(ownerAuthTag(ownerSecret, key.pubkey)), respond_to: "anyone", respond_to_allowlist: [],
      model: "offline", provider: "test", env_vars: { BUZZ_PRIVATE_KEY: fixture },
      launch: { owner_pubkey: daemonPubkey },
    },
  });
  const request = payloadFile ? JSON.parse(readFileSync(payloadFile, "utf8")) as ReturnType<typeof makeRequest> : makeRequest();
  assert.ok(request.agent.relay_url === relay, "Package agent relay must be the disposable loopback relay");
  const agent = provisioning(request.agent);
  assert.notEqual(agent.pubkey, daemonPubkey);
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "xdg"),
    YEWHOLT_HOME: home, YEWHOLT_PROVIDER_HOME: providerHome, YEWHOLT_MODEL: "test/offline" };
  const agentFile = join(agentsDir(home), agent.pubkey + ".json");
  const daemonLog = join(home, "daemon.log"), pidFile = join(home, "integration-daemon.pid");
  const start = "umask 077; " + [process.execPath, cli, "daemon"].map(shq).join(" ") +
    " </dev/null >>" + shq(daemonLog) + " 2>&1 & echo $! >" + shq(pidFile);
  const providerTarget = join(providerHome, "targets", "vm.json");
  const target = { id: "vm", label: "Phase 2 integration", transport: "relay", relay, daemonPubkey };
  const sensitive = [agent.file.nsec, request.agent.private_key_nsec, ...Object.values(request.agent.env_vars ?? {})]
    .filter((value) => typeof value === "string" && value.length > 0);
  const safe = (s: string) => assert.ok(sensitive.every((secret) => !s.includes(secret)), "Secret surfaced");
  function membership(action: "add-member" | "remove-member") {
    const result = spawnSync("docker", ["exec", container, "buzz-admin", action, "--pubkey", providerPubkey],
      { stdio: "ignore", timeout: 10_000 });
    assert.equal(result.status, 0, "Could not " + action + " on the disposable relay");
  }
  async function send(input: unknown) {
    const child = spawn(process.execPath, [engine, "vm"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value) => { stderr += value; });
    const status = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    child.stdin.end(JSON.stringify(input));
    assert.equal(await status, 0, "Provider returned a failure");
    safe(stdout + stderr);
    assert.deepEqual(JSON.parse(stdout), { ok: true, agent_id: agent.pubkey });
  }
  async function stop() {
    let pid: number;
    try {
      pid = Number(readFileSync(pidFile, "utf8"));
    } catch {
      return;
    }
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return;
    }
    await until("daemon exit", () => {
      try {
        process.kill(pid, 0);
        if (process.platform === "linux" && /\) Z /.test(readFileSync("/proc/" + pid + "/stat", "utf8"))) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH" || (error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
    });
  }

  console.log(JSON.stringify({ disposableHome: home }));
  writePrivateJson(providerTarget, target);
  writeKey(ownerKeyPath(home), ownerSecret);
  saveConfig(home, { port: Number(url.port), relayUrl: relay, channelId: null, channelName: "Phase 2 integration " + randomUUID() });
  const pinned = spawnSync(process.execPath, [cli, "pair", "add", providerPubkey, "--label", "Phase 2 integration"],
    { env, stdio: "ignore", timeout: 10_000 });
  assert.equal(pinned.status, 0);
  const observer = new RelayClient(relay, ownerSecret, undefined, false);
  membership("add-member");
  try {
    await observer.connect();
    const kinds = new Set<number>();
    observer.subscribe("runtime", [{ kinds: [RUNTIME_PROFILE, PRESENCE], authors: [agent.pubkey] }], (event) => {
      if (event.pubkey === agent.pubkey && verifyEvent(event) && (event.kind !== PRESENCE || event.content === "online")) {
        kinds.add(event.kind);
      }
    });
    const launched = spawnSync("/bin/sh", ["-c", start], { env, stdio: "ignore", timeout: 5_000 });
    assert.equal(launched.status, 0);
    await send(request);
    const snapshot = () => JSON.parse(readFileSync(statusPath(home), "utf8"));
    const external = () => snapshot().bots.filter((bot: { pubkey: string }) => bot.pubkey === agent.pubkey);
    await until("agent active and runtime events", () =>
      external()[0]?.status === "active" && kinds.has(RUNTIME_PROFILE) && kinds.has(PRESENCE) ? true : undefined);
    const info = statSync(agentFile, { bigint: true });
    assert.equal(info.mode & 0o777n, 0o600n);
    console.log(JSON.stringify({ deploy: "confirmed", status: "active", published: [RUNTIME_PROFILE, PRESENCE] }));
    await send(request);
    await send({ ...request, request_id: randomUUID() });
    assert.equal(statSync(agentFile, { bigint: true }).ino, info.ino);
    assert.equal(external().length, 1);
    assert.deepEqual(readdirSync(agentsDir(home)), [agent.pubkey + ".json"]);
    console.log(JSON.stringify({ repeatedDeploy: "confirmed without replacement or duplication" }));

    await stop();
    const oldPid = readFileSync(pidFile, "utf8");
    const wake = { kind: "command", cmd: start };
    writePrivateJson(providerTarget, { ...target, wake });
    await send({ ...request, request_id: randomUUID() });
    assert.notEqual(readFileSync(pidFile, "utf8"), oldPid);
    assert.equal(statSync(agentFile, { bigint: true }).ino, info.ino);
    safe(readFileSync(daemonLog, "utf8"));
    safe(readFileSync(statusPath(home), "utf8"));
    console.log(JSON.stringify({ commandWake: "started stopped daemon", retry: "confirmed", secretOutput: false }));
  } finally {
    await observer.close();
    try {
      await stop();
    } finally {
      membership("remove-member");
    }
  }
}

try {
  await main();
} catch {
  console.error("Disposable provider integration failed; inspect the private daemon log in the reported home.");
  process.exitCode = 1;
}
