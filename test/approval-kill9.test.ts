import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./helpers/approval-worker.js", import.meta.url));

test("approval survives kill -9 while parked: approve after reopen runs the command exactly once", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "yewholt-approval-kill9-"));
  try {
    const first = spawn(process.execPath, [worker, "park", dir], { stdio: "inherit" });
    await waitFor(join(dir, "parked"), first);
    const parked = JSON.parse(readFileSync(join(dir, "parked"), "utf8")) as { workspace: string; approvals: { subject: string }[] };
    assert.equal(parked.approvals.length, 1);
    assert.equal(parked.approvals[0]!.subject, "mkdir -p junk && rm -rf junk && echo ran >> ran.txt");
    const ran = join(parked.workspace, "ran.txt");
    assert.equal(existsSync(ran), false);
    assert.ok(first.pid);
    process.kill(first.pid, "SIGKILL");
    await exitOf(first);
    assert.equal(existsSync(ran), false);

    const second = spawn(process.execPath, [worker, "approve", dir], { stdio: "inherit" });
    assert.equal(await exitOf(second), 0);
    assert.equal(readFileSync(ran, "utf8"), "ran\n");
    const approved = JSON.parse(readFileSync(join(dir, "approve.json"), "utf8")) as { replies: string[]; approvals: unknown[]; turns: unknown[] };
    assert.deepEqual(approved.approvals, []);
    assert.deepEqual(approved.turns, []);
    assert.ok(approved.replies.some((text) => /done\[ok\]/.test(text)), approved.replies.join("\n---\n"));

    // A further restart has nothing left to run.
    const third = spawn(process.execPath, [worker, "idle", dir], { stdio: "inherit" });
    assert.equal(await exitOf(third), 0);
    assert.equal(readFileSync(ran, "utf8"), "ran\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function waitFor(path: string, child: ReturnType<typeof spawn>): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(timer);
        resolve();
      } else if (child.exitCode !== null || Date.now() - started > 30_000) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${path} (worker exit ${child.exitCode})`));
      }
    }, 30);
  });
}

function exitOf(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}
