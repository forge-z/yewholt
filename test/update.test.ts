import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { checkoutRoot, update, UpdateError } from "../src/update.js";

for (const archive of [false, true]) {
  for (const bridge of [false, true]) {
    for (const running of [false, true]) {
      test(`update archive=${archive} bridge=${bridge} running=${running}`, async (t) => {
        const checkout = mkdtempSync(join(tmpdir(), "yh-update-"));
        t.after(() => rmSync(checkout, { recursive: true, force: true }));
        if (!archive) mkdirSync(join(checkout, ".git"));
        mkdirSync(join(checkout, "dist"));
        writeFileSync(join(checkout, "dist", "stale.js"), "stale");
        const bridgePath = join(checkout, "bridge");
        if (bridge) writeFileSync(bridgePath, "installed");
        const calls: [string, string[]][] = [];
        const messages: string[] = [];
        const home = join(checkout, "custom home");
        await update({ checkout, home, archive: archive ? "source.tar" : undefined }, {
          bridgePath,
          fetch: () => assert.fail("must not download"),
          readPid: (value) => { assert.equal(value, home); return running ? 123 : null; },
          log: (message) => messages.push(message),
          run: (command, args, cwd) => {
            assert.equal(cwd, checkout);
            if (command === "npm") assert.equal(existsSync(join(checkout, "dist")), false);
            calls.push([command, args]);
            return 0;
          },
        });
        const cli = join(checkout, "dist", "src", "cli.js");
        assert.deepEqual(calls, [
          archive ? ["tar", ["-xf", resolve("source.tar"), "-C", checkout]] : ["git", ["pull", "--ff-only"]],
          ["npm", ["ci"]], ["npm", ["run", "build"]],
          ...(bridge ? [[process.execPath, [cli, "provider", "install"]]] : []),
          ...(running ? [[process.execPath, [cli, "stop", "--home", home]], [process.execPath, [cli, "start", "--home", home]]] : []),
        ]);
        assert.match(messages[0], archive ? /archive extracted/ : /git pulled/);
        assert.match(messages[0], bridge ? /bridge refreshed/ : /bridge not installed/);
        assert.match(messages[0], running ? /daemon restarted/ : /left stopped/);
      });
    }
  }
}

test("update restarts a supervised daemon with no running PID", async (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "yh-update-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  const home = join(checkout, "daemon");
  const calls: string[][] = [];
  const messages: string[] = [];
  await update({ checkout, home, archive: "source.tar" }, {
    bridgePath: join(checkout, "bridge"),
    readPid: () => null,
    supervised: (value) => value === home,
    log: (message) => messages.push(message),
    run: (command, args) => { calls.push([command, ...args]); return 0; },
  });
  const cli = join(checkout, "dist", "src", "cli.js");
  assert.deepEqual(calls.slice(-2), [
    [process.execPath, cli, "stop", "--home", home],
    [process.execPath, cli, "start", "--home", home],
  ]);
  assert.match(messages[0], /daemon restarted/);
});

test("a checkout without git downloads and extracts the main archive before building", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yh-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout");
  const home = join(dir, "daemon");
  mkdirSync(checkout);
  mkdirSync(home);
  writeFileSync(join(home, "state"), "preserved");
  const root = "yewholt-main";
  mkdirSync(join(dir, root));
  writeFileSync(join(dir, root, "package.json"), "{}");
  const fixture = spawnSync("tar", ["-czf", "-", "-C", dir, root]);
  assert.equal(fixture.status, 0, fixture.stderr.toString());
  const calls: string[][] = [];
  const messages: string[] = [];
  const downloads: string[] = [];
  await update({ checkout, home }, {
    fetch: async (url, init) => {
      assert.equal(url, "https://codeload.github.com/forge-z/yewholt/tar.gz/refs/heads/main");
      assert.equal(new Headers(init?.headers).get("accept-encoding"), "identity");
      return new Response(new Uint8Array(fixture.stdout));
    },
    bridgePath: join(checkout, "bridge"),
    readPid: () => null,
    log: (message) => messages.push(message),
    run: (command, args, cwd) => {
      assert.equal(cwd, checkout);
      if (command === "tar") {
        downloads.push(args[1]);
        const result = spawnSync(command, args, { cwd });
        assert.equal(result.status, 0, result.stderr.toString());
      } else {
        assert.equal(readFileSync(join(checkout, "package.json"), "utf8"), "{}");
        calls.push([command, ...args]);
      }
      return 0;
    },
  });
  assert.equal(downloads.length, 1);
  assert.equal(existsSync(downloads[0]), false);
  assert.equal(existsSync(join(checkout, root)), false);
  assert.equal(readFileSync(join(home, "state"), "utf8"), "preserved");
  assert.deepEqual(calls, [["npm", "ci"], ["npm", "run", "build"]]);
  assert.match(messages[0], /main archive extracted/);
});

test("a failed main archive download does not change the checkout or run commands", async (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "yh-update-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  mkdirSync(join(checkout, "dist"));
  await assert.rejects(update({ checkout, home: checkout }, {
    fetch: async () => new Response(null, { status: 503 }),
    readPid: () => null, run: () => assert.fail("must not run"),
  }), (error) => error instanceof UpdateError && error.exitCode === 1 && /HTTP 503/.test(error.message));
  assert.equal(existsSync(join(checkout, "dist")), true);
});

for (let failure = 0; failure < 6; failure++) {
  test(`stops at failing step ${failure} and retains its exit code`, async (t) => {
    const checkout = mkdtempSync(join(tmpdir(), "yh-update-"));
    t.after(() => rmSync(checkout, { recursive: true, force: true }));
    mkdirSync(join(checkout, ".git"));
    const bridgePath = join(checkout, "bridge");
    writeFileSync(bridgePath, "installed");
    let calls = 0;
    await assert.rejects(update({ checkout, home: checkout }, {
      bridgePath, readPid: () => 123, log: () => assert.fail("no success summary"),
      run: () => calls++ === failure ? 42 : 0,
    }), (error) => error instanceof UpdateError && error.exitCode === 42);
    assert.equal(calls, failure + 1);
  });
}

test("checkout root follows the running CLI URL rather than cwd", (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "yh-update-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  writeFileSync(join(checkout, "package.json"), "{}");
  assert.equal(checkoutRoot(pathToFileURL(join(checkout, "dist", "src", "cli.js")).href), checkout);
});
