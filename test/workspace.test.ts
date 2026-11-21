import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { geteuid } from "node:process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { judgePath, WorkspaceEnv, workspaceDir, workspaceEnvVars, workspaceCommand, WORKSPACE_BOOTSTRAP } from "../src/workspace.js";
import { runWorkspaceCommand } from "../src/workspace-process.js";
import { WorkspaceIsolation } from "../src/isolation.js";

const BOT = "d0".repeat(32);
const OTHER = "e1".repeat(32);

async function withHome(fn: (home: string, outside: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "yewholt-ws-"));
  const home = join(root, "state");
  const outside = join(root, "outside");
  mkdirSync(join(home, "secrets", "bots"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(home, "secrets", "owner.key"), "not-a-real-key\n");
  writeFileSync(join(outside, "notes.txt"), "outside\n");
  try {
    await fn(home, outside);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function workspaces(home: string): string {
  return join(home, "..", "workspaces");
}

function ensureWorkspace(home: string, pubkey: string): string {
  const isolation = new WorkspaceIsolation(home, { YEWHOLT_WORKSPACES: workspaces(home), YEWHOLT_UNSAFE_SHARED_USER: "1" });
  assert.equal(isolation.prepare(pubkey), undefined);
  return isolation.workspace(pubkey);
}

test("workspace: a stable folder per bot pubkey outside $YEWHOLT_HOME, mode 2770", async () => {
  await withHome((home) => {
    const first = ensureWorkspace(home, BOT);
    assert.equal(first, workspaceDir(workspaces(home), BOT));
    assert.equal(ensureWorkspace(home, BOT), first);
    assert.ok(first.startsWith(workspaces(home) + "/"));
    assert.ok(!first.startsWith(home + "/"));
    assert.notEqual(workspaceDir(workspaces(home), OTHER), first);
    assert.equal(statSync(first).mode & 0o7777, 0o2770);
    assert.equal(statSync(workspaces(home)).mode & 0o7777, 0o2770);
  });
});

test("workspace env: only PATH, HOME, LANG, LC_ALL, TERM and TMPDIR; HOME and TMPDIR inside the workspace", async () => {
  await withHome((home) => {
    const workspace = ensureWorkspace(home, BOT);
    const vars = workspaceEnvVars(workspace);
    assert.deepEqual(Object.keys(vars).sort(), ["HOME", "LANG", "LC_ALL", "PATH", "TERM", "TMPDIR"]);
    assert.equal(vars.HOME, workspace);
    assert.equal(vars.TERM, "dumb");
    assert.ok(vars.TMPDIR!.startsWith(workspace + "/"));
  });
});

test("workspace env: a bash command cannot see a variable set in the daemon's process.env", async () => {
  await withHome(async (home) => {
    const workspace = ensureWorkspace(home, BOT);
    process.env.YEWHOLT_FAKE_PROVIDER_KEY = "sk-test-must-not-leak";
    try {
      const env = new WorkspaceEnv(workspace, undefined, () => undefined);
      let out = "";
      // Even a caller that asks to inherit the daemon's env gets the minimal one.
      const result = await env.exec("env; echo cwd=$(pwd)", { inheritEnv: true, onOutput: (text) => (out += text) }, BACKGROUND_CONTEXT);
      assert.ok(result.ok);
      assert.doesNotMatch(out, /sk-test-must-not-leak/);
      assert.doesNotMatch(out, /YEWHOLT_FAKE_PROVIDER_KEY/);
      assert.match(out, new RegExp(`HOME=${workspace}\\n`));
      assert.match(out, new RegExp(`cwd=${workspace}\\n`));
      const names = out
        .split("\n")
        .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line) && !line.startsWith("cwd="))
        .map((line) => line.slice(0, line.indexOf("=")));
      const shellOwn = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
      for (const name of names) {
        assert.ok(["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"].includes(name) || shellOwn.has(name), `unexpected variable ${name}`);
      }
    } finally {
      delete process.env.YEWHOLT_FAKE_PROVIDER_KEY;
    }
  });
});

test("paths: inside the workspace runs freely; outside reads are free, outside writes need approval", async () => {
  await withHome((home, outside) => {
    const workspace = ensureWorkspace(home, BOT);
    const roots = { home, workspace };
    assert.equal(judgePath("read", "notes.md", roots).kind, "allow");
    assert.equal(judgePath("write", "src/new/file.ts", roots).kind, "allow");
    assert.equal(judgePath("edit", join(workspace, "a.txt"), roots).kind, "allow");
    assert.equal(judgePath("read", join(outside, "notes.txt"), roots).kind, "allow");
    assert.equal(judgePath("write", join(outside, "notes.txt"), roots).kind, "approve");
    assert.equal(judgePath("edit", "../../outside/notes.txt", roots).kind, "approve");
    // A symlink inside the workspace to a folder outside it: writing through it is outside.
    symlinkSync(outside, join(workspace, "out-link"));
    assert.equal(judgePath("write", "out-link/x.txt", roots).kind, "approve");
  });
});

test("paths: $YEWHOLT_HOME outside the bot's own workspace is refused, also through symlinks", async () => {
  await withHome((home) => {
    const workspace = ensureWorkspace(home, BOT);
    const other = ensureWorkspace(home, OTHER);
    const roots = { home, workspace };
    for (const tool of ["read", "write", "edit"] as const) {
      assert.equal(judgePath(tool, join(home, "secrets", "owner.key"), roots).kind, "refuse", tool);
      assert.equal(judgePath(tool, "../../state/secrets/owner.key", roots).kind, "refuse", tool);
      assert.equal(judgePath(tool, join(other, "x"), roots).kind, "refuse", tool);
      assert.equal(judgePath(tool, join(home, "config.json"), roots).kind, "refuse", tool);
    }
    symlinkSync(join(home, "secrets"), join(workspace, "keys"));
    assert.equal(judgePath("read", "keys/owner.key", roots).kind, "refuse");
    assert.equal(judgePath("read", "@keys/owner.key", roots).kind, "refuse");
    // A dangling link whose target would be created inside $YEWHOLT_HOME.
    symlinkSync(join(home, "secrets", "planted.key"), join(workspace, "dangling"));
    assert.equal(judgePath("write", "dangling", roots).kind, "refuse");
    // A link chain: workspace/a -> workspace/b -> $YEWHOLT_HOME.
    symlinkSync(home, join(workspace, "b"));
    symlinkSync(join(workspace, "b"), join(workspace, "a"));
    assert.equal(judgePath("read", "a/relay/.env", roots).kind, "refuse");
    // A link inside the workspace that stays inside it is fine.
    writeFileSync(join(workspace, "real.txt"), "x");
    symlinkSync(join(workspace, "real.txt"), join(workspace, "alias.txt"));
    assert.equal(judgePath("read", "alias.txt", roots).kind, "allow");
  });
});

test("workspace bash: exact sudo argv preserves quotes and command substitution", () => {
  const workspace = "/srv/work spaces/-coder";
  const command = "printf '%s\\n' \"$(printf 'hello world')\"";
  assert.deepEqual(workspaceCommand(workspace, command, "yewholt-bot"), [
    "sudo", "-n", "-u", "yewholt-bot", "--",
    "/usr/bin/env", "-i",
    `PATH=${workspaceEnvVars(workspace).PATH}`,
    `HOME=${workspace}`, "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "TERM=dumb",
    `TMPDIR=${workspace}/.tmp`,
    "/bin/bash", "-c", WORKSPACE_BOOTSTRAP,
    "yewholt", workspace, command,
  ]);
});

test("workspace bash: timeout and abort stop the command group", async () => {
  await withHome(async (home) => {
    for (const abort of [false, true]) {
      const workspace = ensureWorkspace(home, BOT);
      const file = abort ? "after-abort" : "after-timeout";
      const controller = new AbortController();
      let output = "";
      let started = false;
      const result = await runWorkspaceCommand(
        workspaceCommand(workspace, `umask; /bin/bash -c 'echo ready; sleep 1; touch ${file}' & wait`),
        workspace,
        {
          timeout: abort ? 3 : 0.3,
          onOutput: (chunk) => {
            output += chunk;
            if (!output.includes("ready")) return;
            assert.match(output, /0007/);
            started = true;
            if (abort) controller.abort();
          },
        },
        withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
      );
      assert.equal(started, true);
      assert.equal(result.ok, false);
      assert.ok(!result.ok);
      assert.equal(result.error.code, abort ? "aborted" : "timeout");
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.throws(() => statSync(join(workspace, file)), { code: "ENOENT" });
    }
  });
});

const realBotSkip = spawnSync("id", ["yewholt-bot"], { stdio: "ignore" }).status !== 0
  ? "yewholt-bot is absent"
  : spawnSync("sudo", ["-n", "-u", "yewholt-bot", "--", "/bin/true"], { stdio: "ignore" }).status !== 0
    ? "sudo cannot run as yewholt-bot"
    : false;

test("workspace bash integration: bot UID cannot read a daemon-owned 0700 directory", { skip: realBotSkip }, async () => {
  const privateDir = mkdtempSync(join(tmpdir(), "yewholt-private-"));
  const workspace = mkdtempSync(join(tmpdir(), "yewholt-bot-shell-"));
  chmodSync(workspace, 0o777);
  const env = new WorkspaceEnv(workspace, "yewholt-bot", () => undefined);
  try {
    const file = join(privateDir, "fixture");
    writeFileSync(file, "synthetic fixture\n", { mode: 0o644 });
    assert.equal(statSync(privateDir).uid, geteuid!());
    assert.equal(statSync(privateDir).mode & 0o777, 0o700);
    let output = "";
    const result = await env.exec(
      ["/bin/bash", "-c", 'id -un; /bin/cat -- "$1"', "fixture", file],
      { timeout: 4, onOutput: (chunk: string) => (output += chunk) },
      BACKGROUND_CONTEXT,
    );
    assert.ok(result.ok);
    assert.notEqual(result.value.exitCode, 0);
    assert.match(output, /^yewholt-bot$/m);
    assert.match(output, /Permission denied/);
    assert.doesNotMatch(output, /synthetic fixture/);
    for (const abort of [false, true]) {
      const marker = abort ? "aborted" : "timed-out";
      const controller = new AbortController();
      let started = false;
      const stopped = await env.exec(`/bin/bash -c 'echo running; sleep 2; touch ${marker}' & wait`, {
        timeout: abort ? 4 : 0.75,
        onOutput: (chunk) => {
          if (!chunk.includes("running")) return;
          started = true;
          if (abort) controller.abort();
        },
      }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
      assert.ok(started);
      assert.ok(!stopped.ok);
      assert.equal(stopped.error.code, abort ? "aborted" : "timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 2100));
    for (const marker of ["aborted", "timed-out"]) {
      assert.throws(() => statSync(join(workspace, marker)), { code: "ENOENT" });
    }
  } finally {
    rmSync(privateDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("isolation: a passing probe is cached for 60 seconds and failures are retried", async () => {
  await withHome((home, outside) => {
    let now = 0;
    let healthy = true;
    let probes = 0;
    const messages: string[] = [];
    const isolation = new WorkspaceIsolation(home, { YEWHOLT_WORKSPACES: outside }, {
      account: () => ({ uid: 2000, gid: 3000, groups: ["yewholt-ws"] }),
      groupId: () => 3000,
      daemon: () => ({ uid: 1000, gid: 1000, groups: [1000, 3000] }),
      sudoWorks: () => { probes++; return healthy; },
      workspaceInfo: () => ({ uid: 2000, gid: 3000, mode: 0o2770, isDirectory: () => true }),
      homeMode: () => 0o750,
      botCanAccessHome: () => false,
      mkdirAsBot: () => assert.fail("status should not create workspaces"),
    }, () => now, (message: string) => messages.push(message));
    assert.equal(isolation.status(), "ok");
    now = 59_999;
    healthy = false;
    assert.equal(isolation.status(), "ok");
    assert.equal(probes, 1);
    now = 60_000;
    assert.match(isolation.status(), /sudo -n.*run sudo scripts\/setup-bot-user\.sh/i);
    assert.match(isolation.status(), /sudo -n/);
    assert.equal(probes, 3);
    assert.equal(messages.length, 1);
    healthy = true;
    assert.equal(isolation.status(), "ok");
  });
});

test("isolation: unsafe mode is explicit, warns on every start and still requires a separate workspace root", async () => {
  await withHome((home, outside) => {
    const warnings: string[] = [];
    const previous = process.umask();
    try {
      for (let start = 0; start < 2; start++) {
        const isolation = new WorkspaceIsolation(home, { YEWHOLT_WORKSPACES: outside, YEWHOLT_UNSAFE_SHARED_USER: "1" }, undefined, undefined, (message: string) => warnings.push(message));
        isolation.start();
        assert.equal(process.umask(), 0o007);
        assert.match(isolation.status(), /UNSAFE/);
      }
      assert.equal(warnings.length, 2);
    } finally {
      process.umask(previous);
    }
    const nested = new WorkspaceIsolation(home, { YEWHOLT_WORKSPACES: join(home, "workspaces"), YEWHOLT_UNSAFE_SHARED_USER: "1" }, undefined, undefined, () => {});
    assert.match(nested.status(), /outside.*YEWHOLT_HOME/);
  });
});

test("paths: the gate checks the same home, file URL and filename variants as the file tools", async () => {
  await withHome((home) => {
    const workspace = ensureWorkspace(home, BOT);
    const roots = { home, workspace };
    const fixture = join(home, "private.txt");
    writeFileSync(fixture, "synthetic fixture");
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      for (const tool of ["read", "write", "edit"] as const) {
        assert.equal(judgePath(tool, "~/private.txt", roots).kind, "refuse");
        assert.equal(judgePath(tool, pathToFileURL(fixture).href, roots).kind, "refuse");
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    symlinkSync(fixture, join(workspace, "coder’s.txt"));
    assert.equal(judgePath("read", "coder's.txt", roots).kind, "refuse");
    assert.equal(judgePath("write", "coder's.txt", roots).kind, "allow");
  });
});
