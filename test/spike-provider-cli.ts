import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { saveConfig } from "../src/config.js";
import { readKey, writeKey } from "../src/keys.js";
import { generateKeyPair, ownerAuthTag, pubkeyOf } from "../src/nostr.js";
import { agentsDir, ownerKeyPath, statusPath } from "../src/paths.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function main() {
  const [relay, ownerFile, container] = process.argv.slice(2);
  assert.ok(relay && ownerFile && container, "Supply the disposable relay URL, owner file, and container");
  const url = new URL(relay);
  assert.ok(url.port && ["ws://127.0.0.1:" + url.port, "ws://127.0.0.1:" + url.port + "/"].includes(relay));
  assert.match(container, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  const port = spawnSync("docker", ["port", container, "3000/tcp"], { encoding: "utf8", timeout: 5_000 });
  assert.ok(port.status === 0 && port.stdout.trim() === "127.0.0.1:" + url.port);
  const home = mkdtempSync(join(homedir(), "yewholt-phase3-integration-"));
  const provider = join(home, "provider"), bin = join(home, "bin");
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), YEWHOLT_HOME: home,
    YEWHOLT_PROVIDER_HOME: provider, YEWHOLT_PROVIDER_BIN_DIR: bin, YEWHOLT_PROVIDER_FILE_STORAGE: "1",
    YEWHOLT_MODEL: "test/offline" };
  const owner = readKey(ownerFile);
  const daemonPubkey = pubkeyOf(owner);
  const agent = generateKeyPair();
  const envFixture = "phase3-private-environment-fixture";
  const safe = (output: string) => assert.ok(![agent.secret, owner, envFixture].some((secret) => output.includes(secret)));
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 10_000 });
    safe(result.stdout + result.stderr);
    assert.equal(result.status, 0, "CLI operation failed: " + args.slice(0, 2).join(" "));
    return result.stdout;
  };
  const providerPubkey = run("provider", "install").match(/Provider pubkey: ([a-f0-9]{64})/)?.[1];
  assert.ok(providerPubkey);
  const member = (action: string) => assert.equal(
    spawnSync("docker", ["exec", container, "buzz-admin", action, "--pubkey", providerPubkey],
      { stdio: "ignore", timeout: 10_000 }).status, 0, "Disposable relay membership update failed");
  writeKey(ownerKeyPath(home), owner);
  saveConfig(home, { port: Number(url.port), relayUrl: relay, channelId: null, channelName: "Phase 3 integration " + randomUUID() });
  run("targets", "add", "disposable", "--relay", relay, "--daemon", daemonPubkey, "--label", "Disposable VM");
  run("pair", "add", providerPubkey, "--label", "Disposable provider");
  const shim = join(bin, "buzz-backend-yewholt-disposable");
  console.log(JSON.stringify({ disposableHome: home }));
  member("add-member");
  const daemon = spawn(process.execPath, [cli, "daemon"], { env, stdio: "ignore" });
  const exited = once(daemon, "exit");
  try {
    const input = JSON.stringify({
      op: "deploy", request_id: randomUUID(), provider_config: {}, agent: {
        name: "Buzz CLI integration agent", relay_url: relay, private_key_nsec: agent.secret,
        auth_tag: JSON.stringify(ownerAuthTag(owner, agent.pubkey)), respond_to: "anyone",
        model: "offline", provider: "test", env_vars: { PRIVATE_FIXTURE: envFixture },
        launch: { owner_pubkey: daemonPubkey },
      },
    });
    const result = spawnSync(shim, { env, input, encoding: "utf8", timeout: 30_000 });
    safe(result.stdout + result.stderr);
    assert.equal(result.status, 0, "Shim deploy failed");
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, agent_id: agent.pubkey });
    const deadline = Date.now() + 20_000;
    let active = false;
    while (Date.now() < deadline) {
      let status: string | undefined;
      try { status = readFileSync(statusPath(home), "utf8"); } catch { /* daemon is starting */ }
      if (status) {
        safe(status);
        active = JSON.parse(status).bots.some((bot: { pubkey: string; status: string }) =>
          bot.pubkey === agent.pubkey && bot.status === "active");
        if (active) break;
      }
      await sleep(100);
    }
    assert.ok(active);
    const list = run("targets", "list");
    assert.match(list, /disposable \(Disposable VM\).*recent confirmation.*\t1\t/);
    const doctor = run("targets", "doctor", "disposable");
    assert.match(doctor, /NIP-42 authenticated; connect \+ AUTH latency \d+ ms/);
    assert.match(doctor, /Pairing \/ daemon: recent confirmation/);
    run("targets", "remove", "disposable");
    assert.equal(existsSync(shim), false);
    assert.equal(existsSync(join(provider, "targets", "disposable.json")), false);
    assert.equal(existsSync(join(agentsDir(home), agent.pubkey + ".json")), true);
    console.log(JSON.stringify({ install: "ok", shimDeploy: "confirmed", agent: "active",
      list: "1 deployment", doctor: "relay authenticated; recent confirmation", remove: "shim removed; agent retained" }));
  } finally {
    try {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill("SIGTERM");
        if (!(await Promise.race([exited, sleep(5_000, undefined, { ref: false })]))) {
          daemon.kill("SIGKILL");
          await exited;
        }
      }
    } finally {
      member("remove-member");
    }
  }
}

try {
  await main();
} catch {
  console.error("Disposable provider CLI integration failed.");
  process.exitCode = 1;
}
