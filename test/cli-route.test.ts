import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DAEMON_COMMANDS, route, usageText, withDefaultModel } from "../src/route.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("no arguments opens the harness with nothing forwarded", () => {
  assert.deepEqual(route([]), { kind: "harness", args: [] });
});

test("code forwards every following argument unchanged", () => {
  assert.deepEqual(route(["code"]), { kind: "harness", args: [] });
  assert.deepEqual(route(["code", "--help"]), { kind: "harness", args: ["--help"] });
  assert.deepEqual(route(["code", "--version"]), { kind: "harness", args: ["--version"] });
  assert.deepEqual(route(["code", "-p", "hi"]), { kind: "harness", args: ["-p", "hi"] });
  assert.deepEqual(route(["code", "--model", "x", "-p", "hi there", "--home", "h"]), {
    kind: "harness",
    args: ["--model", "x", "-p", "hi there", "--home", "h"],
  });
  assert.deepEqual(route(["code", "install", "npm:pkg"]), { kind: "harness", args: ["install", "npm:pkg"] });
  assert.deepEqual(route(["code", "help"]), { kind: "harness", args: ["help"] });
});

test("help, --help and -h print usage and exit 0", () => {
  for (const arg of ["help", "--help", "-h"]) {
    assert.deepEqual(route([arg]), { kind: "usage", exitCode: 0 }, arg);
  }
});

test("each daemon command still routes to itself", () => {
  assert.deepEqual([...DAEMON_COMMANDS], ["install", "start", "stop", "status", "admin", "daemon"]);
  for (const command of DAEMON_COMMANDS) {
    assert.deepEqual(route([command]), { kind: "command", command, args: [] }, command);
    assert.deepEqual(route([command, "--home", "/tmp/y"]), { kind: "command", command, args: ["--home", "/tmp/y"] }, command);
  }
  assert.deepEqual(route(["admin", "budget", "Alpha", "5"]), { kind: "command", command: "admin", args: ["budget", "Alpha", "5"] });
});

test("an unknown command prints usage and exits 1", () => {
  assert.deepEqual(route(["bogus"]), { kind: "usage", exitCode: 1 });
  assert.deepEqual(route(["--home", "/tmp/y"]), { kind: "usage", exitCode: 1 });
  assert.deepEqual(route(["-p", "hi"]), { kind: "usage", exitCode: 1 });
});

test("YEWHOLT_MODEL is the default model only when --model is absent", () => {
  const env = { YEWHOLT_MODEL: "opencode/big-pickle" };
  assert.deepEqual(withDefaultModel([], env), ["--model", "opencode/big-pickle"]);
  assert.deepEqual(withDefaultModel(["-p", "hi"], env), ["--model", "opencode/big-pickle", "-p", "hi"]);
  assert.deepEqual(withDefaultModel(["--model", "anthropic/claude-sonnet-5"], env), ["--model", "anthropic/claude-sonnet-5"]);
  assert.deepEqual(withDefaultModel(["-p", "hi", "--model=openai/gpt-6-sol"], env), ["-p", "hi", "--model=openai/gpt-6-sol"]);
  assert.deepEqual(withDefaultModel(["--model="], env), ["--model="]);
  // After `--` everything is message text, so a literal "--model" there is not the flag.
  assert.deepEqual(withDefaultModel(["--", "--model"], env), ["--model", "opencode/big-pickle", "--", "--model"]);
});

test("no YEWHOLT_MODEL, or an empty one, forwards args untouched", () => {
  assert.deepEqual(withDefaultModel([], {}), []);
  assert.deepEqual(withDefaultModel(["-p", "hi"], {}), ["-p", "hi"]);
  assert.deepEqual(withDefaultModel(["-p", "hi"], { YEWHOLT_MODEL: "  " }), ["-p", "hi"]);
});

test("pi subcommands do not get a default model", () => {
  const env = { YEWHOLT_MODEL: "opencode/big-pickle" };
  for (const sub of ["install", "uninstall", "remove", "update", "list", "config", "auth", "mcp"]) {
    assert.deepEqual(withDefaultModel([sub, "x"], env), [sub, "x"], sub);
  }
});

test("usage lists the harness first, then the daemon commands", () => {
  const text = usageText();
  const harness = text.search(/^ {2}yewholt {2,}Open the pi coding harness/m);
  const code = text.indexOf("yewholt code [");
  assert.ok(harness >= 0 && code >= 0, "harness lines");
  assert.match(text, /yewholt code --help/);
  for (const command of DAEMON_COMMANDS.filter((c) => c !== "daemon")) {
    const at = text.indexOf(`yewholt ${command}`);
    assert.ok(at > code && at > harness, command);
  }
});

function runCli(args: string[]): { status: number | null; stdout: string } {
  const home = mkdtempSync(join(tmpdir(), "yewholt-cli-"));
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, YEWHOLT_HOME: home, HOME: home },
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout };
}

test("the CLI prints usage for help flags with exit 0 and exit 1 for unknown", () => {
  for (const arg of ["help", "--help", "-h"]) {
    const result = runCli([arg]);
    assert.equal(result.status, 0, arg);
    assert.match(result.stdout, /yewholt code --help/, arg);
  }
  const unknown = runCli(["bogus"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /yewholt code --help/);
});
