#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AgentStatus } from "./agents.js";
import { loadConfig, saveConfig } from "./config.js";
import { ensureEnvFile, loadEnvFile } from "./env-file.js";
import { readPid, runDaemon } from "./daemon.js";
import { ensureOwnerKey } from "./session.js";
import { pubkeyOf } from "./nostr.js";
import { addPairing, listPairings, removePairing } from "./pairing.js";
import { readKey } from "./keys.js";
import { envFilePath, logPath, ownerKeyPath, pidPath, secretsDir, sqlitePath, statusPath, yewholtHome } from "./paths.js";
import { compose, newRelaySecret, relayHealthy, waitForRelay, writeRelayEnv } from "./relay.js";
import { Yewholt } from "./session.js";
import { runHarness } from "./harness.js";
import { route, usageText, withDefaultModel } from "./route.js";

const args = process.argv.slice(2);

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main(): Promise<void> {
  const target = route(args);
  if (target.kind === "command") {
    const { command, args } = target;
    if (command === "provider" || command === "targets" || (command === "pair" && !args.length)) {
      const { providerCommand } = await import("../provider/cli.js");
      return providerCommand(command, args);
    }
  }
  // Harness arguments belong to pi, so `--home` is read only for Yewholt's own commands.
  const home = (target.kind === "harness" ? undefined : flag("--home")) ?? yewholtHome();
  loadEnvFile(home);
  if (target.kind === "harness") return runHarness(withDefaultModel(target.args, process.env));
  if (target.kind === "usage") {
    console.log(usageText());
    process.exit(target.exitCode);
  }
  switch (target.command) {
    case "install":
      return install(home);
    case "start":
      return start(home);
    case "stop":
      return stop(home);
    case "status":
      return status(home);
    case "admin":
      return admin(home, target.args);
    case "daemon":
      return runDaemon(home);
    case "pair":
      return pair(home, commandArgs(target.args));
    case "agents":
      return agents(home, commandArgs(target.args));
  }
}

function commandArgs(rest: string[]): string[] {
  const index = rest.indexOf("--home");
  return index < 0 ? rest : [...rest.slice(0, index), ...rest.slice(index + 2)];
}

function pair(home: string, rest: string[]): void {
  const [sub, pubkey, flag, label] = rest;
  if (sub === "add" && rest.length === 4 && flag === "--label") {
    addPairing(home, pubkey, label);
  } else if (sub === "remove" && rest.length === 2) {
    if (!removePairing(home, pubkey)) throw new Error("Provider is not paired");
  } else if (sub === "list" && rest.length === 1) {
    const entries = listPairings(home);
    console.log(JSON.stringify(entries.map(({ pubkey, label }) => ({ pubkey, label })), null, 2));
  } else {
    throw new Error("Usage: yewholt pair add <providerPubkey> --label <label> | list | remove <providerPubkey>");
  }
}

function agents(home: string, rest: string[]): void {
  if (rest.length !== 1 || rest[0] !== "list") throw new Error("Usage: yewholt agents list");
  let entries: AgentStatus[] = [];
  try {
    entries = (JSON.parse(readFileSync(statusPath(home), "utf8")) as { agents?: AgentStatus[] }).agents ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Daemon status is unavailable");
  }
  console.log(JSON.stringify(entries.map(({ name, pubkey, state, target, lastDeploy }) =>
    ({ name, pubkey, state, target: target ?? null, lastDeploy: lastDeploy ?? null })), null, 2));
}

async function install(home: string): Promise<void> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  mkdirSync(secretsDir(home), { recursive: true, mode: 0o700 });
  const port = Number(flag("--port") ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1-65535");
  const ownerPubkey = ensureOwnerKey(home);
  const relayUrl = `ws://127.0.0.1:${port}`;
  let existing = false;
  try {
    loadConfig(home);
    existing = true;
  } catch {
    existing = false;
  }
  if (!existing) {
    writeRelayEnv(home, { port, relayUrl, ownerPubkey }, newRelaySecret());
    saveConfig(home, { port, relayUrl, channelId: null, channelName: "yewholt" });
  }
  console.log(`Installed Yewholt in ${home}`);
  console.log(`Owner pubkey: ${ownerPubkey}`);
  console.log("Relay: stock Buzz compose (ghcr.io/block/buzz:0.3.0) with Postgres, Redis, and MinIO.");
  const envFile = ensureEnvFile(home);
  console.log("Back up secrets/ and relay/.env. Buzz has no key rotation; a lost secret is a lost identity.");
  console.log(`Provider keys: ${envFile} (mode 0600). Paste a key, then yewholt start. Restart after changes.`);
  console.log("Next: yewholt start");
}

async function start(home: string): Promise<void> {
  const config = loadConfig(home);
  if (readPid(home)) throw new Error("daemon already running");
  await compose(home, ["up", "-d"]);
  await waitForRelay(config.port);
  const log = openSync(logPath(home), "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "daemon", "--home", home], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (readPid(home)) {
      console.log(`Yewholt daemon ${readPid(home)} on ${config.relayUrl}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`daemon did not write ${pidPath(home)}; see ${logPath(home)}`);
}

async function stop(home: string): Promise<void> {
  const pid = readPid(home);
  if (pid) {
    process.kill(pid, "SIGTERM");
    const started = Date.now();
    while (Date.now() - started < 10_000 && readPid(home)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (readPid(home)) process.kill(pid, "SIGKILL");
  }
  try {
    await compose(home, ["stop"]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  console.log("stopped");
}

async function status(home: string): Promise<void> {
  const config = loadConfig(home);
  const pid = readPid(home);
  const healthy = await relayHealthy(config.port);
  console.log(`relay: ${healthy ? "healthy" : "down"} ${config.relayUrl}`);
  console.log(`daemon: ${pid ? `running (${pid})` : "stopped"}`);
  console.log(`channel: ${config.channelId ?? "(created on first start)"}`);
  try {
    const raw = readFileSync(statusPath(home), "utf8");
    const status = JSON.parse(raw) as { isolation?: string };
    console.log(`isolation: ${status.isolation ?? "unknown until daemon restart"}`);
    console.log(raw);
  } catch {
    console.log("isolation: unknown until daemon start");
    console.log("no daemon status yet");
  }
}

async function admin(home: string, rest: string[]): Promise<void> {
  const sub = rest[0];
  if (sub === "keys") {
    const owner = pubkeyOf(readKey(ownerKeyPath(home)));
    console.log(`owner ${owner}`);
    console.log(`secret ${ownerKeyPath(home)} (mode 0600)`);
    console.log("Back up secrets/ and relay/.env offline. Buzz does not rotate Nostr keys.");
    const bots = await readBots(home);
    for (const bot of bots) console.log(`${bot.role} ${bot.name} ${bot.pubkey}`);
    return;
  }
  if (sub === "bots") {
    const bots = await readBots(home);
    if (bots.length === 0) console.log("no bots yet");
    for (const bot of bots) {
      console.log(`${bot.name} [${bot.status}] model=${bot.model} scope=${bot.scope.join(",")} permissions=${bot.permissions.join(",")} budget=${bot.spentTokens}/${bot.limitTokens} ${bot.pubkey}`);
    }
    return;
  }
  if (sub === "channel") {
    console.log(loadConfig(home).channelId ?? "(created on first start)");
    return;
  }
  if (sub === "budget") {
    const name = rest[1];
    const tokens = Number(rest[2]);
    if (!name || !Number.isInteger(tokens)) throw new Error("usage: yewholt admin budget <name> <tokens>");
    if (readPid(home)) throw new Error("stop the daemon first; the SQLite store has one writer");
    const session = await Yewholt.open(await openNodeSqliteStorage(sqlitePath(home)), { home });
    try {
      await session.setBudget(name, tokens);
    } finally {
      await session.close();
    }
    console.log(`${name} budget ${tokens}`);
    return;
  }
  throw new Error("usage: yewholt admin keys|bots|channel|budget");
}

async function readBots(home: string): Promise<StatusBot[]> {
  if (readPid(home)) {
    try {
      const status = JSON.parse(readFileSync(statusPath(home), "utf8")) as { bots?: StatusBot[] };
      return status.bots ?? [];
    } catch {
      return [];
    }
  }
  try {
    const session = await Yewholt.open(await openNodeSqliteStorage(sqlitePath(home)), { home });
    try {
      const state = await session.snapshot();
      return state.bots.map((bot) => ({
        name: bot.name,
        pubkey: bot.pubkey,
        model: bot.modelLabel,
        scope: bot.scope,
        permissions: bot.permissions,
        status: bot.status,
        role: bot.role,
        spentTokens: bot.spentTokens,
        limitTokens: bot.limitTokens,
      }));
    } finally {
      await session.close();
    }
  } catch {
    return [];
  }
}

type StatusBot = {
  name: string;
  pubkey: string;
  model: string;
  scope: string[];
  permissions: string[];
  status: string;
  role: string;
  spentTokens: number;
  limitTokens: number;
};

function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}
