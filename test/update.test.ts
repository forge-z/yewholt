import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { checkoutRoot, update, UpdateError } from "../src/update.js";

for (const archive of [false, true]) {
  for (const bridge of [false, true]) {
    for (const running of [false, true]) {
      test(`update archive=${archive} bridge=${bridge} running=${running}`, (t) => {
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
        update({ checkout, home, archive: archive ? "source.tar" : undefined }, {
          bridgePath,
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

test("a checkout without git requires an archive and runs nothing", (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "yh-update-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  assert.throws(() => update({ checkout, home: checkout }, {
    readPid: () => null, run: () => assert.fail("must not run"),
  }), /Pass --archive <tar file>/);
});

for (let failure = 0; failure < 6; failure++) {
  test(`stops at failing step ${failure} and retains its exit code`, (t) => {
    const checkout = mkdtempSync(join(tmpdir(), "yh-update-"));
    t.after(() => rmSync(checkout, { recursive: true, force: true }));
    mkdirSync(join(checkout, ".git"));
    const bridgePath = join(checkout, "bridge");
    writeFileSync(bridgePath, "installed");
    let calls = 0;
    assert.throws(() => update({ checkout, home: checkout }, {
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
