import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { refreshRuntime } from "../provider/runtime-update.js";

test("automatic Buzz updates build separately, throttle checks and publish only a working release", async (t) => {
  const root = mkdtempSync(join(homedir(), "yewholt-runtime-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const template = join(root, "yewholt-main");
  mkdirSync(template);
  writeFileSync(join(template, "package.json"), "{}");
  const archive = execFileSync("tar", ["-czf", "-", "-C", root, "yewholt-main"]);
  const runtime = join(root, "runtime");
  const current = join(runtime, "current");
  const hour = 60 * 60 * 1000;
  let builds = 0;
  let tag = '"first"';
  let broken = false;
  const request: typeof fetch = async (_url, options) => {
    const installed = new Headers(options?.headers).get("if-none-match");
    assert.equal(installed, existsSync(current) ? '"first"' : null);
    return new Response(installed === tag ? null : new Uint8Array(archive), {
      status: installed === tag ? 304 : 200, headers: { etag: tag },
    });
  };
  const check = (now: number) => refreshRuntime({
    root: runtime, now, request,
    run(program, args, cwd, _timeout, input) {
      assert.notEqual(cwd, current);
      if (program === "tar") {
        execFileSync(program, args, { cwd });
        return;
      }
      assert.equal(readFileSync(join(cwd, "package.json"), "utf8"), "{}");
      if (program === "npm" && args[1] === "build") {
        builds++;
        if (broken) throw new Error("Build failed");
      }
      if (input) assert.equal(JSON.parse(input).op, "plugin-ui-v1");
    },
  });
  assert.equal(await check(0), true);
  const first = readlinkSync(current);
  assert.equal(await check(hour - 1), false);
  assert.equal(await check(hour), false);
  assert.equal(builds, 1);

  tag = '"next"';
  broken = true;
  await assert.rejects(check(hour * 2), /Build failed/);
  assert.equal(readlinkSync(current), first);
  assert.deepEqual(readdirSync(runtime).sort(), ["current", "last-check", first].sort());

  broken = false;
  assert.equal(await check(hour * 3), true);
  assert.notEqual(readlinkSync(current), first);
  assert.equal(readFileSync(join(current, "etag"), "utf8"), tag);
  assert.equal(existsSync(join(runtime, first)), true);
});
