import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { launchAgent } from "../src/launch-agent.js";

function fixture(t: TestContext) {
  const userHome = realpathSync(mkdtempSync(join(tmpdir(), "yh-launch-agent-")));
  t.after(() => rmSync(userHome, { recursive: true, force: true }));
  const home = join(userHome, "daemon & state");
  mkdirSync(home);
  const agentsDir = join(userHome, "Library", "LaunchAgents");
  const calls: string[][] = [];
  let loaded = false;
  let failure: string | undefined;
  const agent = launchAgent(home, {
    platform: "darwin", userHome, uid: 501,
    run: (args) => {
      calls.push(args);
      if (args[0] === failure) return { status: 5, stderr: "launchctl failed" };
      if (args[0] === "print") return { status: loaded ? 0 : 113 };
      loaded = args[0] === "bootstrap";
      return { status: 0 };
    },
  })!;
  return { agent, agentsDir, calls, fail: (command: string) => { failure = command; } };
}

test("user LaunchAgent starts at login, uses the selected daemon home and stops persistently", (t) => {
  const { agent, agentsDir, calls } = fixture(t);
  assert.equal(agent.installed(), false);
  agent.start("/repo <one>/dist/src/cli.js", "/opt/node/bin/node", "/opt/node/bin:/usr/bin");
  const [file] = readdirSync(agentsDir);
  const plist = join(agentsDir, file);
  const service = "gui/501/" + file.replace(/\.plist$/, "");
  const contents = readFileSync(plist, "utf8");
  assert.match(contents, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(contents, /<key>KeepAlive<\/key><true\/>/);
  assert.match(contents, /<string>\/opt\/node\/bin\/node<\/string><string>\/repo &lt;one&gt;\/dist\/src\/cli\.js<\/string><string>daemon<\/string><string>--home<\/string><string>[^<]*\/daemon &amp; state<\/string>/);
  assert.match(contents, /<key>PATH<\/key><string>\/opt\/node\/bin:\/usr\/bin<\/string>/);
  assert.match(contents, /<key>StandardOutPath<\/key><string>[^<]*\/daemon &amp; state\/daemon\.log<\/string>/);
  assert.match(contents, /<key>StandardErrorPath<\/key><string>[^<]*\/daemon &amp; state\/daemon\.log<\/string>/);
  assert.equal(agent.installed(), true);
  agent.start("/repo <one>/dist/src/cli.js");
  agent.stop();
  assert.deepEqual(calls, [
    ["print", service], ["bootstrap", "gui/501", plist], ["print", service], ["print", service], ["bootout", service],
  ]);
  assert.equal(agent.installed(), false);
  assert.equal(existsSync(plist), false);
});

test("a failed bootstrap leaves no new login job and a failed bootout keeps the registration", (t) => {
  const { agent, fail } = fixture(t);
  fail("bootstrap");
  assert.throws(() => agent.start("/repo/cli.js"), /Could not start.*launchctl failed/);
  assert.equal(agent.installed(), false);
  fail("bootout");
  agent.start("/repo/cli.js");
  assert.throws(() => agent.stop(), /Could not stop.*launchctl failed/);
  assert.equal(agent.installed(), true);
});

test("Linux does not use launchctl", () => {
  assert.equal(launchAgent("/var/lib/yewholt", {
    platform: "linux",
    run: () => assert.fail("launchctl must not run on Linux"),
  }), undefined);
});
