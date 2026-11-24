import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeStatus } from "../src/daemon.js";
import { statusPath } from "../src/paths.js";

test("status.json is replaced atomically, so a reader never sees a truncated or partial file", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yewholt-status-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = JSON.stringify({ pid: 1, agents: [{ name: "previous" }] }) + "\n";
  writeFileSync(statusPath(home), old, { mode: 0o600 });
  const session = {
    snapshot: async () => ({ bots: [], approvals: [], outbox: [] }),
    isolationStatus: () => ({ ok: false, reason: "fixture" }),
  } as unknown as Parameters<typeof writeStatus>[1];
  const config = { relayUrl: "wss://relay.example.test" } as Parameters<typeof writeStatus>[2];
  // A reader that opened the file before the write must keep the complete previous version,
  // which holds only if the daemon publishes a new file instead of truncating it in place.
  const reader = openSync(statusPath(home), "r");
  try {
    await writeStatus(home, session, config, "vm", undefined, new Map());
    assert.equal(readFileSync(reader, "utf8"), old);
  } finally {
    closeSync(reader);
  }
  const current = JSON.parse(readFileSync(statusPath(home), "utf8")) as { pid: number; agents: unknown[]; outbox: number };
  assert.deepEqual([current.pid, current.agents, current.outbox], [process.pid, [], 0]);
  assert.equal(statSync(statusPath(home)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(home), ["status.json"]);
});
