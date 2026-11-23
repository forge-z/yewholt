import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { writeAtomic } from "./control-files.js";
import { logPath } from "./paths.js";

type Launchctl = (args: string[]) => { status: number | null; stderr?: string; error?: Error };

const runLaunchctl: Launchctl = (args) => spawnSync("/bin/launchctl", args, { encoding: "utf8" });

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function string(value: string): string {
  return "<string>" + value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") + "</string>";
}

export function launchAgent(home: string, {
  platform = process.platform, userHome, uid, run = runLaunchctl,
}: {
  platform?: NodeJS.Platform; userHome?: string; uid?: number; run?: Launchctl;
} = {}) {
  if (platform !== "darwin") return undefined;
  home = existsSync(home) ? realpathSync(home) : resolve(home);
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 16);
  const label = `ai.yewholt.daemon.${hash}`;
  const plist = join(userHome ?? homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${uid ?? userInfo().uid}`;
  const service = `${domain}/${label}`;
  const installed = () => existsSync(plist);
  const loaded = () => succeeded(run(["print", service]));
  function succeeded(result: ReturnType<Launchctl>): boolean {
    if (result.error) throw result.error;
    return result.status === 0;
  }
  return {
    installed,
    start(cli: string, node = process.execPath, path = process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"): void {
      if (loaded()) return;
      const existed = installed();
      writeAtomic(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(label)}
  <key>ProgramArguments</key><array>${[node, cli, "daemon", "--home", home].map(string).join("")}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key>${string(path)}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${string(logPath(home))}
  <key>StandardErrorPath</key>${string(logPath(home))}
</dict>
</plist>
`, 0o600);
      try {
        const result = run(["bootstrap", domain, plist]);
        if (!succeeded(result)) {
          throw new Error(`Could not start the macOS daemon LaunchAgent. Run yh start while logged in to macOS: ${result.stderr?.trim() || result.status}`);
        }
      } catch (error) {
        if (!existed) rmSync(plist, { force: true });
        throw error;
      }
    },
    stop(): void {
      if (loaded()) {
        const result = run(["bootout", service]);
        if (!succeeded(result)) {
          throw new Error(`Could not stop the macOS daemon LaunchAgent: ${result.stderr?.trim() || result.status}`);
        }
        // launchd can still list the job right after bootout; a start in that window would skip bootstrap.
        const started = Date.now();
        while (loaded() && Date.now() - started < 10_000) pause(100);
      }
      rmSync(plist, { force: true });
    },
  };
}
