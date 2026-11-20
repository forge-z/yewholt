import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("../src/proof-worker.js", import.meta.url));

test("kill -9 resumes the unfinished step without a second side effect", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "yewholt-kill9-"));
  try {
    const first = spawn(process.execPath, [worker, dir], { stdio: "ignore" });
    await waitFor(join(dir, "holding"));
    assert.equal(readFileSync(join(dir, "effects", "1"), "utf8").trim(), "1");
    assert.equal(readFileSync(join(dir, "effects", "2"), "utf8").trim(), "2");
    assert.equal(exists(join(dir, "effects", "3")), false);
    assert.ok(first.pid);
    process.kill(first.pid, "SIGKILL");
    await exitOf(first);
    writeFileSync(join(dir, "release"), "go\n");
    const second = spawn(process.execPath, [worker, dir], { stdio: "inherit" });
    const code = await exitOf(second);
    assert.equal(code, 0);
    assert.equal(readFileSync(join(dir, "effects", "1"), "utf8").trim(), "1");
    assert.equal(readFileSync(join(dir, "effects", "2"), "utf8").trim(), "2");
    assert.equal(readFileSync(join(dir, "effects", "3"), "utf8").trim(), "3");
    const phases = readFileSync(join(dir, "phase-entries.log"), "utf8").trim().split("\n");
    assert.deepEqual(phases.filter((line) => line === "1"), ["1"]);
    assert.deepEqual(phases.filter((line) => line === "2"), ["2", "2"]);
    assert.deepEqual(phases.filter((line) => line === "3"), ["3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function exists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function waitFor(path: string): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (exists(path)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 15_000) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${path}`));
      }
    }, 30);
  });
}

function exitOf(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}
