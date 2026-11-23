import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { writeAtomic } from "../src/control-files.js";
import { downloadMainArchive } from "../src/update.js";
import { runtimeBridge, runtimeHome } from "./runtime-paths.js";

const hour = 60 * 60 * 1000;
const lockLimit = 30 * 60 * 1000;
const releaseName = /^release-[a-zA-Z0-9]{6}$/;

function acquire(path: string, now: number): boolean {
  try {
    mkdirSync(path, { mode: 0o700 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const lock = lstatSync(path, { throwIfNoEntry: false });
    if (!lock?.isDirectory() || now - lock.mtimeMs < lockLimit) return false;
    try {
      rmdirSync(path);
      mkdirSync(path, { mode: 0o700 });
      return true;
    } catch (error) {
      if (["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  }
}

function readOptional(path: string, read: (path: string) => string): string | undefined {
  try {
    return read(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

type Run = (program: string, args: string[], cwd: string, timeout: number, input?: string) => void;

const runCommand: Run = (program, args, cwd, timeout, input) => {
  const result = spawnSync(program, args, {
    cwd, timeout, input, encoding: "utf8", killSignal: "SIGKILL",
    env: { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter) },
  });
  if (result.status !== 0) throw new Error(`Yewholt runtime update failed at ${basename(program)} ${args[0]}.`);
  if (input && !JSON.parse(result.stdout).ok) throw new Error("The staged Yewholt bridge did not start.");
};

export async function refreshRuntime({
  root = runtimeHome(), request = fetch, run = runCommand, now = Date.now(),
}: { root?: string; request?: typeof fetch; run?: Run; now?: number } = {}): Promise<boolean> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory()) throw new Error("Invalid Yewholt runtime directory.");
  const attempt = join(root, "last-check");
  const lock = join(root, "update-lock");
  const current = join(root, "current");
  const text = (path: string) => readFileSync(path, "utf8");
  const recent = () => {
    const previous = Number(readOptional(attempt, text) ?? -Infinity);
    return now - previous >= 0 && now - previous < hour;
  };
  if (recent() || !acquire(lock, now)) return false;
  let stage: string | undefined;
  try {
    if (recent()) return false;
    writeAtomic(attempt, String(now), 0o600);
    const previous = readOptional(current, (path) => readlinkSync(path));
    if (previous && !releaseName.test(previous)) throw new Error("Invalid Yewholt runtime release.");
    const etag = previous ? readOptional(join(root, previous, "etag"), text) : undefined;

    stage = mkdtempSync(join(root, "release-"));
    const archive = join(stage, "source.tar.gz");
    const downloaded = await downloadMainArchive(archive, request, etag);
    if (!downloaded) return false;
    run("tar", ["-xf", archive, "--strip-components=1"], stage, 20_000);
    rmSync(archive);
    run("npm", ["ci", "--include=dev"], stage, 240_000);
    run("npm", ["run", "build"], stage, 60_000);
    run(process.execPath, ["--check", "provider/plugin-ui.mjs"], stage, 10_000);
    run(process.execPath, [runtimeBridge], stage, 15_000, JSON.stringify({ op: "plugin-ui-v1" }));
    if (downloaded.etag) writeAtomic(join(stage, "etag"), downloaded.etag, 0o600);

    const installed = basename(stage);
    const link = join(stage, "publish");
    symlinkSync(installed, link);
    renameSync(link, current);
    stage = undefined;
    for (const entry of readdirSync(root)) {
      if (releaseName.test(entry) && entry !== installed && entry !== previous) {
        rmSync(join(root, entry), { recursive: true, force: true });
      }
    }
    return true;
  } finally {
    try {
      if (stage) rmSync(stage, { recursive: true, force: true });
    } finally {
      rmdirSync(lock);
    }
  }
}
