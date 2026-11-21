import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { generateKeyPair, ownerAuthTag } from "../src/nostr.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const exec = promisify(execFile);
const agent = generateKeyPair();
const daemon = generateKeyPair();
const hidden = "private-environment-fixture";

function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(homedir(), "yewholt-provider-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin with 'quotes'");
  const config = join(home, "xdg", "yewholt");
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "xdg"),
    YEWHOLT_HOME: home, YEWHOLT_PROVIDER_BIN_DIR: bin, YEWHOLT_PROVIDER_FILE_STORAGE: "1" };
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 5_000 });
    assert.equal(result.error, undefined);
    assert.ok(![agent.secret, hidden].some((value) => (result.stdout + result.stderr).includes(value)));
    return result;
  };
  const shim = (id: string) => join(bin, "buzz-backend-yewholt-" + id);
  const target = (id: string) => join(config, "targets", id + ".json");
  return { home, bin, config, env, run, shim, target };
}

test("provider install, target add, shim info, pair and remove end to end", (t) => {
  const { home, bin, config, env, run, shim, target } = fixture(t);
  const initial = run("provider", "install");
  assert.equal(initial.status, 0, initial.stderr);
  const installed = join(bin, "yewholt-provider-engine");
  const key = JSON.parse(readFileSync(join(config, "secrets", "identity.json"), "utf8"));
  assert.ok(!(initial.stdout + initial.stderr).includes(key));
  assert.match(initial.stdout, /Provider pubkey: [a-f0-9]{64}/);
  const pair = run("pair");
  assert.equal(pair.status, 0);
  assert.equal(initial.stdout, `Buzz plugin folder: ${join(config, "buzz-plugin")}\n${pair.stdout}`);
  assert.equal(run("pair", "list").stdout.trim(), "[]");
  const label = "Mac's $(ignored)";
  assert.equal(run("targets", "add", "mac", "--local", "--label", label).status, 0);
  assert.equal(statSync(target("mac")).mode & 0o777, 0o600);
  assert.equal(statSync(shim("mac")).mode & 0o777, 0o700);
  const first = [installed, shim("mac")].map((file) => statSync(file, { bigint: true }).ino);
  assert.equal(run("provider", "install").stdout, initial.stdout);
  assert.deepEqual([installed, shim("mac")].map((file) => statSync(file, { bigint: true }).ino), first);
  const staged = join(home, "staged-shim");
  copyFileSync(shim("mac"), staged);
  const invoke = (file: string, input: unknown) =>
    spawnSync(file, { input: JSON.stringify(input), env, encoding: "utf8", timeout: 5_000 });
  const info = invoke(staged, { op: "info", request_id: randomUUID() });
  assert.equal(info.status, 0, info.stderr);
  assert.equal(JSON.parse(info.stdout).name, label);
  assert.equal(info.stderr, "");
  assert.match(run("targets", "list").stdout, /mac \(Mac's \$\(ignored\)\)\t—\tno running local PID\t—\t0\t—/);
  const deploy = {
    op: "deploy", request_id: randomUUID(), provider_config: {}, agent: {
      name: "Test agent", auth_tag: JSON.stringify(ownerAuthTag(daemon.secret, agent.pubkey)),
      relay_url: "wss://relay.example", private_key_nsec: agent.secret, respond_to: "anyone", env_vars: { TEST: hidden },
    },
  };
  assert.equal(invoke(shim("mac"), deploy).status, 0);
  assert.equal(invoke(shim("mac"), deploy).status, 0);
  assert.equal(invoke(shim("mac"), { ...deploy, agent: { private_key_nsec: hidden } }).status, 1);
  assert.match(run("targets", "list").stdout, /\t—\t1\t\d{4}-.*\(invalid package\)/);
  assert.match(run("targets", "doctor", "mac").stdout, /Pairing: not required \(local\)/);
  assert.equal(run("targets", "remove", "mac").status, 0);
  assert.equal(existsSync(shim("mac")), false);
  assert.equal(existsSync(target("mac")), false);
  assert.equal(existsSync(join(home, "agents", agent.pubkey + ".json")), true);
});

test("targets validate IDs, relay, daemon and wake; commands never echo malformed arguments", (t) => {
  const { run, shim, target } = fixture(t);
  for (const args of [
    ["../escaped", "--local"], ["UPPER", "--local"], ["mac", "--local", "--daemon", daemon.pubkey],
    ["vm", "--relay", "wss://user:" + hidden + "@relay.example", "--daemon", daemon.pubkey],
    ["vm", "--relay", "https://relay.example", "--daemon", daemon.pubkey],
    ["vm", "--relay", "wss://relay.example", "--daemon", agent.secret.slice(0, 33)],
    ["vm", "--relay", "wss://relay.example", "--daemon", daemon.pubkey, "--token", hidden],
  ]) assert.equal(run("targets", "add", ...args).status, 1);
  assert.equal(existsSync(target("vm")), false);
  const options = ["--relay", "wss://relay.example", "--daemon", daemon.pubkey];
  assert.equal(run("targets", "add", "vm", ...options, "--wake", "instabox", "--account", "acc_test", "--machine", "m_test").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(target("vm"), "utf8")).wake, { kind: "instabox", accountId: "acc_test", machineId: "m_test" });
  assert.equal(run("targets", "add", "vm", ...options, "--wake", "command", "--cmd", "/path/to/wake").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(target("vm"), "utf8")).wake, { kind: "command", cmd: "/path/to/wake" });
  writeFileSync(shim("foreign"), "not generated by Yewholt", { mode: 0o700 });
  assert.equal(run("targets", "add", "foreign", "--local").status, 1);
  assert.equal(run("targets", "remove", "foreign").status, 1);
  assert.equal(readFileSync(shim("foreign"), "utf8"), "not generated by Yewholt");
});

test("targets doctor measures relay AUTH and never prints a relay-supplied refusal", async (t) => {
  const { run, env } = fixture(t);
  assert.equal(run("provider", "install").status, 0);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    let allow = true;
    server.on("connection", (ws) => {
      ws.send(JSON.stringify(["AUTH", "test"]));
      ws.on("message", (data) => {
        const [type, event] = JSON.parse(data.toString());
        assert.equal(type, "AUTH");
        ws.send(JSON.stringify(["OK", event.id, allow, hidden + agent.secret]));
      });
    });
    assert.equal(run("targets", "add", "vm", "--relay", "ws://127.0.0.1:" + addr.port, "--daemon", daemon.pubkey).status, 0);
    const doctor = () => exec(process.execPath, [cli, "targets", "doctor", "vm"], { env, timeout: 7_000 });
    const accepted = await doctor();
    assert.match(accepted.stdout, /reachable, NIP-42 authenticated; connect \+ AUTH latency \d+ ms/);
    assert.match(accepted.stdout, /no confirmation \(recorded evidence only; no live daemon probe\)/);
    assert.match(accepted.stdout, /Daemon version: unavailable/);
    allow = false;
    const rejected = await doctor();
    assert.match(rejected.stdout, /reachable, NIP-42 AUTH failed or timed out/);
    assert.ok(!(rejected.stdout + rejected.stderr).includes(hidden) && !(rejected.stdout + rejected.stderr).includes(agent.secret));
  } finally {
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
