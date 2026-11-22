import assert from "node:assert/strict";
import { test } from "node:test";
import { isolationGroups, lookupGroupId } from "../src/isolation.js";

test("Darwin ignores exactly its implicit everyone/localaccounts groups; Linux retains them", () => {
  const groups = ["everyone", "yewholt-ws", "localaccounts"];
  assert.deepEqual(isolationGroups(groups, "darwin"), ["yewholt-ws"]);
  assert.deepEqual(isolationGroups(groups, "linux"), groups);
  for (const extra of ["admin", "_lpoperator", "com.apple.access_ssh"]) {
    assert.deepEqual(isolationGroups([...groups, extra], "darwin"), ["yewholt-ws", extra]);
  }
  assert.deepEqual(isolationGroups([], "darwin"), []);
  assert.deepEqual(isolationGroups(["everyone", "localaccounts"], "darwin"), []);
});

test("group lookup uses dscl on Darwin and getent on Linux, failing closed", () => {
  for (const platform of ["darwin", "linux"] as const) {
    for (const [stdout, status, expected] of [
      [platform === "darwin" ? "PrimaryGroupID: 402\n" : "yewholt-ws:x:402:\n", 0, 402],
      ["", 0, undefined], ["bad", 0, undefined], ["PrimaryGroupID: 402", 1, undefined],
    ] as const) {
      const run: Parameters<typeof lookupGroupId>[2] = (path, args) => {
        assert.equal(path, platform === "darwin" ? "/usr/bin/dscl" : "/usr/bin/getent");
        assert.deepEqual(args, platform === "darwin" ? [".", "-read", "/Groups/yewholt-ws", "PrimaryGroupID"] : ["group", "yewholt-ws"]);
        return { stdout, stderr: "", status, signal: null, pid: 1, output: [] };
      };
      assert.equal(lookupGroupId("yewholt-ws", platform, run), expected);
    }
  }
});
