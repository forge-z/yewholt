import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bridge } from "../provider/bridge.js";
import { waitForConfirmation, type RelayWait } from "../provider/relay.js";
import { saveConfig } from "../src/config.js";
import { controlEvent, decryptControl, verifiedEnvelope } from "../src/control-protocol.js";
import { readKey, writeKey } from "../src/keys.js";
import { accepted, RelayClient } from "../src/nostr-client.js";
import { ownerAuthTag, pubkeyOf, verifyAuthSignature, verifyEvent, type NostrEvent } from "../src/nostr.js";
import { agentsDir, ownerKeyPath, statusPath } from "../src/paths.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
async function eventually<T>(get: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 15_000;
  do {
    const value = get();
    if (value !== undefined) return value;
    await sleep(80);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for a hosted agent lifecycle update");
}

async function main() {
  const [relay, ownerFile, container] = process.argv.slice(2);
  assert.ok(relay && ownerFile && container, "Supply the disposable relay, owner file, and container");
  assert.match(relay, /^ws:\/\/127\.0\.0\.1:\d{1,5}$/);
  assert.match(container, /^yewholt-phase0-relay-[0-9]+$/);
  const service = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 10_000 });
  const port = service("port", container, "3000/tcp");
  assert.ok(port.status === 0 && port.stdout.trim() === new URL(relay).host);
  const home = mkdtempSync(join(homedir(), "yewholt-hosted-integration-"));
  const providerHome = join(home, "provider"), bin = join(home, "bin");
  Object.assign(process.env, {
    YEWHOLT_PROVIDER_HOME: providerHome, YEWHOLT_PROVIDER_BIN_DIR: bin, YEWHOLT_PROVIDER_FILE_STORAGE: "1",
  });
  const env = { PATH: process.env.PATH, HOME: home, YEWHOLT_HOME: home, YEWHOLT_PROVIDER_HOME: providerHome,
    YEWHOLT_PROVIDER_BIN_DIR: bin, YEWHOLT_PROVIDER_FILE_STORAGE: "1", YEWHOLT_MODEL: "test/offline" };
  const owner = readKey(ownerFile);
  const daemonKey = pubkeyOf(owner);
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, "Disposable CLI failed");
    return result.stdout;
  };
  const out = run("provider", "install");
  assert.ok(out.includes("Buzz plugin folder: " + join(providerHome, "buzz-plugin")));
  const provider = out.match(/Provider pubkey: ([a-f0-9]{64})/)?.[1];
  assert.ok(provider);
  console.log(JSON.stringify({ disposableHome: home }));
  writeKey(ownerKeyPath(home), owner);
  saveConfig(home, { relayUrl: relay, port: Number(new URL(relay).port), channelId: null, channelName: "Hosted " + randomUUID() });
  run("pair", "add", provider, "--label", "Disposable hosted provider");
  run("targets", "add", "instabox", "--relay", relay, "--daemon", daemonKey);
  const program = join(bin, "yewholt-buzz-bridge");
  const invoke = (payload: unknown) => {
    const result = spawnSync(program, { env, input: JSON.stringify(payload), encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, "Installed bridge failed");
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(invoke({ op: "targets" }), { ok: true, targets: ["instabox"] });
  const create = { op: "provision", target: "instabox", name: "Hosted test", community: relay };
  const reserved = invoke(create) as { ok: true; pubkey: string };
  assert.deepEqual(invoke(create), reserved);
  const pubkey = reserved.pubkey;
  const file = join(agentsDir(home), pubkey + ".json");
  const auth = ownerAuthTag(owner, pubkey);
  const client = new RelayClient(relay, owner, undefined, false);
  const member = (verb: string) => {
    const result = service("exec", container, "buzz-admin", verb, "--pubkey", provider);
    assert.equal(result.status, 0, "Disposable member update failed");
  };
  member("add-member");
  const daemon = spawn(process.execPath, [cli, "daemon"], { env, stdio: "ignore" });
  const exited = once(daemon, "exit");
  try {
    await client.connect();
    const profiles = new Map<number, NostrEvent>();
    client.subscribe("hosted-agent", [{ kinds: [0, 10100, 20001], authors: [pubkey] }], (event) => profiles.set(event.kind, event));
    let captured: { event: NostrEvent; secret: string } | undefined;
    const wait: RelayWait = async (target, secret, event, id, agent, timeout) => {
      if (JSON.parse(event.content).type === "hosted-activate") captured ??= { event, secret };
      return waitForConfirmation(target, secret, event, id, agent, Math.min(timeout, 15_000));
    };
    const params = { pubkey, community: relay };
    assert.deepEqual(await bridge({ ...params, op: "activate", auth }, wait), { ok: true });
    const status = (expected: string) => {
      const bots: { pubkey: string; status: string; name: string; conversationId: number }[] =
        JSON.parse(readFileSync(statusPath(home), "utf8")).bots;
      const matching = bots.filter((bot) => bot.pubkey === pubkey);
      assert.ok(matching.length <= 1);
      return matching[0]?.status === expected ? matching[0] : undefined;
    };
    const active = await eventually(() => status("active"));
    await eventually(() => profiles.has(10100) && profiles.get(20001)?.content === "online" ? true : undefined);
    const profile = await eventually(() => profiles.get(0));
    assert.ok(verifyEvent(profile));
    assert.equal(verifyAuthSignature(profile.tags.find(([type]) => type === "auth")!, pubkey), daemonKey);
    assert.equal(JSON.parse(profile.content).name, create.name);
    const before = statSync(file, { bigint: true });
    const target = { transport: "relay" as const, relay, daemonPubkey: daemonKey, label: "Disposable" };
    assert.ok(captured);
    const { event, secret } = captured;
    const envelope = verifiedEnvelope(event, daemonKey, "hosted-activate")!;
    const body = decryptControl(envelope, secret, daemonKey);
    const retry = async () => {
      const job = randomUUID();
      return waitForConfirmation(target, secret, controlEvent(secret, daemonKey, "hosted-activate",
        { requestId: job, agentPubkey: pubkey }, body, envelope.issuedAt), job, pubkey, 15_000);
    };
    assert.deepEqual(invoke({ ...params, op: "activate", auth }), { ok: true });
    assert.equal(await retry(), "confirmed");
    assert.equal(statSync(file, { bigint: true }).ino, before.ino);
    assert.equal(status("active")?.conversationId, active.conversationId);
    console.log(JSON.stringify({ retry: "same pubkey and conversation", attestedProfile: true, runtime: [10100, 20001] }));

    const renamed = { ...params, op: "profile", name: "Hosted renamed", picture: "https://example.test/agent.png" };
    assert.deepEqual(invoke(renamed), { ok: true });
    await eventually(() => {
      const event = profiles.get(0);
      return event && JSON.parse(event.content).name === renamed.name ? event : undefined;
    });
    assert.equal(statSync(file, { bigint: true }).mtimeNs, before.mtimeNs);
    assert.equal(status("active")?.name, renamed.name);

    assert.deepEqual(invoke({ ...params, op: "remove" }), { ok: true });
    assert.deepEqual(invoke({ ...params, op: "remove" }), { ok: true });
    assert.equal(existsSync(file), false);
    assert.ok(status("retired"));
    assert.equal(await retry(), "refused");
    const oldPublisher = new RelayClient(relay, secret, undefined, false);
    try {
      await oldPublisher.connect();
      assert.ok(accepted(await oldPublisher.publish(event)));
    } finally { await oldPublisher.close(); }
    assert.equal(await retry(), "refused");
    assert.equal(existsSync(file), false);
    assert.ok(status("retired"));
    console.log(JSON.stringify({ editedProfile: true, removed: true, replay: "refused; no provisioning file" }));
  } finally {
    await client.close();
    daemon.kill("SIGTERM");
    await exited;
    member("remove-member");
  }
}

await main().catch(() => {
  console.error("Hosted provider integration failed");
  process.exitCode = 1;
});
