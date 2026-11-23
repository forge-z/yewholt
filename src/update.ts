import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

export function update(options: { checkout: string; home: string; archive?: string }, dependencies: {
  run?: Runner;
  bridgePath?: string;
  readPid?: typeof readPid;
  supervised?: (home: string) => boolean;
  log?: (message: string) => void;
} = {}): void {
  const { checkout, home, archive } = options;
  const run = dependencies.run ?? runCommand;
  const log = dependencies.log ?? console.log;
  const step = (command: string, args: string[]) => {
    const code = run(command, args, checkout);
    if (code !== 0) throw new UpdateError(`Update stopped: ${command} ${args.join(" ")} exited with ${code}`, code);
  };
  const bridgeInstalled = existsSync(dependencies.bridgePath ?? join(providerBin(), "yewholt-buzz-bridge"));
  const supervised = dependencies.supervised?.(home) ?? launchAgent(home)?.installed();
  const restartDaemon = supervised || (dependencies.readPid ?? readPid)(home) !== null;
  if (archive) {
    step("tar", ["-xf", resolve(archive), "-C", checkout]);
  } else if (existsSync(join(checkout, ".git"))) {
    step("git", ["pull", "--ff-only"]);
  } else {
    throw new Error("This checkout is not a git repository. Pass --archive <tar file> to update it.");
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
  log(`Updated: ${archive ? "archive extracted" : "git pulled"}; built; bridge ${bridgeInstalled ? "refreshed" : "not installed"}; daemon ${restartDaemon ? "restarted" : "not running (left stopped)"}.`);
}
