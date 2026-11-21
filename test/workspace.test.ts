import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ensureWorkspace, judgePath, WorkspaceEnv, workspaceDir, workspaceEnvVars } from "../src/workspace.js";

const BOT = "d0".repeat(32);
const OTHER = "e1".repeat(32);

function withHome(fn: (home: string, outside: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "yewholt-ws-"));
  const home = join(root, "state");
  const outside = join(root, "outside");
  mkdirSync(join(home, "secrets", "bots"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(home, "secrets", "owner.key"), "not-a-real-key\n");
  writeFileSync(join(outside, "notes.txt"), "outside\n");
  return Promise.resolve(fn(home, outside)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("workspace: a stable folder per bot pubkey under $YEWHOLT_HOME/workspaces, mode 0700", async () => {
  await withHome((home) => {
    const first = ensureWorkspace(home, BOT);
    assert.equal(first, workspaceDir(home, BOT));
    assert.equal(ensureWorkspace(home, BOT), first);
    assert.ok(first.startsWith(join(home, "workspaces") + "/"));
    assert.notEqual(workspaceDir(home, OTHER), first);
    assert.equal(statSync(first).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, "workspaces")).mode & 0o777, 0o700);
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
      const env = new WorkspaceEnv(workspace);
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
    assert.equal(judgePath("edit", "../../../outside/notes.txt", roots).kind, "approve");
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
      assert.equal(judgePath(tool, "../../secrets/owner.key", roots).kind, "refuse", tool);
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
