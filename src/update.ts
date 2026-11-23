import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { providerBin } from "../provider/install.js";
import { readPid } from "./daemon.js";
import { launchAgent } from "./launch-agent.js";

export class UpdateError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

export function checkoutRoot(url: string): string {
  let dir = dirname(fileURLToPath(url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Cannot find the running CLI's package.json");
    dir = parent;
  }
  return dir;
}

type Runner = (command: string, args: string[], cwd: string) => number;

const runCommand: Runner = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw new UpdateError(`${command}: ${result.error.message}`, 1);
  return result.status ?? 1;
};

const mainArchiveUrl = "https://codeload.github.com/forge-z/yewholt/tar.gz/refs/heads/main";

export async function downloadMainArchive(path: string, request: typeof fetch, etag?: string): Promise<{ etag: string | null } | null> {
  try {
    const response = await request(mainArchiveUrl, {
      headers: { "Accept-Encoding": "identity", ...(etag && { "If-None-Match": etag }) },
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    const receivedTag = response.headers.get("etag");
    if (etag && (response.status === 304 || (response.ok && receivedTag === etag))) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    await pipeline(response.body, createWriteStream(path));
    return { etag: receivedTag };
  } catch (error) {
    throw new UpdateError(`Could not download the Yewholt main archive: ${error instanceof Error ? error.message : error}`, 1);
  }
}

export async function update(options: { checkout: string; home: string; archive?: string }, dependencies: {
  run?: Runner;
  fetch?: typeof fetch;
  bridgePath?: string;
  readPid?: typeof readPid;
  supervised?: (home: string) => boolean;
  log?: (message: string) => void;
} = {}): Promise<void> {
  const { checkout, home, archive } = options;
  const run = dependencies.run ?? runCommand;
  const log = dependencies.log ?? console.log;
  const step = (command: string, args: string[]) => {
    const code = run(command, args, checkout);
    if (code !== 0) throw new UpdateError(`Update stopped: ${command} ${args.join(" ")} exited with ${code}`, code);
  };
  const extractArchive = (path: string, ...flags: string[]) => step("tar", ["-xf", path, "-C", checkout, ...flags]);
  const bridgeInstalled = existsSync(dependencies.bridgePath ?? join(providerBin(), "yewholt-buzz-bridge"));
  const supervised = dependencies.supervised?.(home) ?? launchAgent(home)?.installed();
  const restartDaemon = supervised || (dependencies.readPid ?? readPid)(home) !== null;
  let source: string;
  if (archive) {
    extractArchive(resolve(archive));
    source = "archive extracted";
  } else if (existsSync(join(checkout, ".git"))) {
    step("git", ["pull", "--ff-only"]);
    source = "git pulled";
  } else {
    const temp = mkdtempSync(join(tmpdir(), "yh-update-"));
    try {
      const path = join(temp, "main.tar.gz");
      await downloadMainArchive(path, dependencies.fetch ?? fetch);
      extractArchive(path, "--strip-components=1");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    source = "main archive extracted";
  }
  rmSync(join(checkout, "dist"), { recursive: true, force: true });
  step("npm", ["ci"]);
  step("npm", ["run", "build"]);
  const cli = join(checkout, "dist", "src", "cli.js");
  if (bridgeInstalled) step(process.execPath, [cli, "provider", "install"]);
  if (restartDaemon) {
    step(process.execPath, [cli, "stop", "--home", home]);
    step(process.execPath, [cli, "start", "--home", home]);
  }
  log(`Updated: ${source}; built; bridge ${bridgeInstalled ? "refreshed" : "not installed"}; daemon ${restartDaemon ? "restarted" : "not running (left stopped)"}.`);
}
