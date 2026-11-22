import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { physicalPath, within, workspaceDir } from "./workspace.js";

const WORKSPACE_MODE = 0o2770;
const CACHE_MS = 60_000;
const UNSAFE = "UNSAFE: YEWHOLT_UNSAFE_SHARED_USER=1 runs code bots as the daemon user";
const SETUP = `Run sudo scripts/setup-bot-user${process.platform === "darwin" ? "-macos" : ""}.sh.`;

type DirectoryInfo = { uid: number; gid: number; mode: number; isDirectory(): boolean };
type BotAccount = { uid: number; gid: number; groups: string[] };
type Identity = { uid: number; gid: number };

export function isolationGroups(groups: string[], platform: NodeJS.Platform = process.platform): string[] {
  return platform === "darwin" ? groups.filter((group) => group !== "everyone" && group !== "localaccounts") : groups;
}

export type IsolationProbe = {
  account(user: string): BotAccount | undefined;
  groupId(group: string): number | undefined;
  daemon(): Identity & { groups: number[] };
  sudoWorks(user: string): boolean;
  workspaceInfo(path: string): DirectoryInfo | undefined;
  homeMode(): number;
  botCanAccessHome(user: string): boolean;
  mkdirAsBot(user: string, dir: string): boolean;
};

function command(path: string, args: string[]) {
  return spawnSync(path, args, { encoding: "utf8", env: {}, timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
}

export function lookupGroupId(group: string, platform: NodeJS.Platform = process.platform, run = command): number | undefined {
  const entry = platform === "darwin"
    ? run("/usr/bin/dscl", [".", "-read", "/Groups/" + group, "PrimaryGroupID"])
    : run("/usr/bin/getent", ["group", group]);
  if (entry.error || entry.status !== 0) return undefined;
  const raw = platform === "darwin" ? entry.stdout.trim().match(/^PrimaryGroupID:\s+(\d+)$/)?.[1] : entry.stdout.split(":")[2];
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const gid = Number(raw);
  return Number.isSafeInteger(gid) ? gid : undefined;
}

function sudo(user: string, ...args: string[]): boolean {
  const result = spawnSync("/usr/bin/sudo", ["-n", "-u", user, "--", ...args], { env: {}, timeout: 2000, stdio: "ignore" });
  return !result.error && result.status === 0;
}

function info(path: string): DirectoryInfo | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const systemProbe: IsolationProbe = {
  account(user) {
    const separator = process.platform === "darwin" ? [] : ["--"];
    const uid = command("/usr/bin/id", ["-u", ...separator, user]);
    const gid = command("/usr/bin/id", ["-g", ...separator, user]);
    const groups = command("/usr/bin/id", ["-Gn", ...separator, user]);
    if (uid.error || gid.error || groups.error || uid.status !== 0 || gid.status !== 0 || groups.status !== 0) return undefined;
    return { uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()), groups: isolationGroups(groups.stdout.trim().split(/\s+/)) };
  },
  groupId: lookupGroupId,
  daemon: () => ({ uid: process.geteuid!(), gid: process.getegid!(), groups: process.getgroups!() }),
  sudoWorks: (user) => sudo(user, "/bin/true"),
  workspaceInfo: info,
  homeMode: () => statSync(userInfo().homedir).mode,
  botCanAccessHome: (user) =>
    !sudo(user, "/bin/bash", "-c", '[[ ! -r $1 && ! -x $1 ]]', "yewholt", userInfo().homedir),
  mkdirAsBot: (user, dir) =>
    sudo(user, "/bin/bash", "-c", 'umask 007; exec /bin/mkdir -p -- "$1"', "yewholt", dir),
};

type Check = { ok: true; owner?: Identity } | { ok: false; reason: string };

export class WorkspaceIsolation {
  readonly workspaces: string;
  readonly user: string;
  readonly group: string;
  readonly unsafe: boolean;
  private passing?: { check: Check; until: number };
  private warned = false;

  constructor(
    private readonly home: string,
    env: NodeJS.ProcessEnv = process.env,
    private readonly probe: IsolationProbe = systemProbe,
    private readonly now: () => number = () => performance.now(),
    private readonly log: (message: string) => void = console.error,
  ) {
    this.workspaces = resolve(env.YEWHOLT_WORKSPACES || (process.platform === "darwin" ? "/Users/Shared/yewholt/workspaces" : "/srv/yewholt/workspaces"));
    this.user = env.YEWHOLT_BOT_USER || "yewholt-bot";
    this.group = env.YEWHOLT_BOT_GROUP || "yewholt-ws";
    this.unsafe = env.YEWHOLT_UNSAFE_SHARED_USER === "1";
  }

  start(): void {
    process.umask(0o007);
    if (this.unsafe) this.log(UNSAFE);
    this.status();
  }

  status(): string {
    const check = this.check();
    return check.ok ? (this.unsafe ? UNSAFE : "ok") : check.reason;
  }

  workspace(pubkey: string): string {
    return workspaceDir(this.workspaces, pubkey);
  }

  /** A reason blocks the tool. An absent workspace is provisioned after the host passes. */
  prepare(pubkey: string): string | undefined {
    const check = this.check();
    if (!check.ok) return check.reason;
    const dir = this.workspace(pubkey);
    const temp = join(dir, ".tmp");
    try {
      const owner = check.owner;
      if (!owner) {
        for (const path of [this.workspaces, dir, temp]) {
          if (!info(path)) {
            mkdirSync(path, { recursive: path === this.workspaces, mode: WORKSPACE_MODE });
            chmodSync(path, WORKSPACE_MODE);
          }
          if (!info(path)?.isDirectory()) return this.problem(`Workspace path ${path} is not a directory`);
        }
        return undefined;
      }
      const current = this.probe.workspaceInfo(dir);
      if (current && !matches(current, owner)) return this.problem(`Bot workspace ${dir} has the wrong owner, group or mode (expected 2770)`);
      const scratch = this.probe.workspaceInfo(temp);
      if (scratch && !matches(scratch, owner)) return this.problem(`Bot workspace scratch directory ${temp} has the wrong owner, group or mode (expected 2770)`);
      // An unprivileged daemon cannot assign another UID. Creating as the bot gives
      // both directories the correct owner and inherits the parent's setgid group.
      if ((!current || !scratch) && !this.probe.mkdirAsBot(this.user, temp)) {
        return this.problem(`Could not create bot workspace ${dir} as ${this.user}`);
      }
      if ((!current && !matches(this.probe.workspaceInfo(dir), owner)) || (!scratch && !matches(this.probe.workspaceInfo(temp), owner))) {
        return this.problem(`New bot workspace ${dir} has the wrong owner, group or mode (expected 2770)`);
      }
      return undefined;
    } catch (error) {
      return this.problem(`Could not prepare bot workspace ${dir} (${errorCode(error)})`);
    }
  }

  private problem(reason: string): string {
    const message = `${reason}. ${SETUP}`;
    if (!this.warned) {
      this.warned = true;
      this.log(`Code bot isolation failed. ${message}`);
    }
    return message;
  }

  private check(): Check {
    const now = this.now();
    if (this.passing && now < this.passing.until) return this.passing.check;
    const fail = (reason: string): Check => ({ ok: false, reason: this.problem(reason) });
    let step = "resolve the workspace and state folders";
    try {
      const home = resolve(this.home);
      const realHome = physicalPath(home);
      const realRoot = physicalPath(this.workspaces);
      if (within(this.workspaces, home) || within(home, this.workspaces) || within(realRoot, realHome) || within(realHome, realRoot)) {
        return fail("The workspaces folder must be outside $YEWHOLT_HOME");
      }
      if (this.unsafe) return { ok: true };
      step = "look up the bot user";
      if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(this.user)) return fail("Invalid YEWHOLT_BOT_USER");
      const bot = this.probe.account(this.user);
      if (!bot) return fail(`Bot user ${this.user} does not exist`);
      step = "look up the bot group and daemon's groups";
      if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(this.group)) return fail("Invalid YEWHOLT_BOT_GROUP");
      const gid = this.probe.groupId(this.group);
      if (gid === undefined) return fail(`Bot group ${this.group} does not exist`);
      const daemon = this.probe.daemon();
      if (bot.uid === 0 || bot.uid === daemon.uid || bot.gid !== gid || gid === 0 || gid === daemon.gid ||
          bot.groups.length !== 1 || bot.groups[0] !== this.group || this.group === "sudo" || this.group === "docker") {
        return fail(`Bot user ${this.user} must be a separate unprivileged account with only the ${this.group} group`);
      }
      step = "verify sudo access";
      if (!this.probe.sudoWorks(this.user)) return fail(`sudo -n -u ${this.user} -- /bin/true failed`);
      if (!daemon.groups.includes(gid)) return fail(`The daemon process is missing group ${this.group}. Restart from a new login session after setup`);
      step = "stat the workspaces folder";
      const owner = { uid: bot.uid, gid };
      if (!matches(this.probe.workspaceInfo(this.workspaces), owner)) {
        return fail(`Workspaces folder ${this.workspaces} must be a directory owned by ${this.user}:${this.group} with mode 2770`);
      }
      step = "verify the daemon HOME";
      if ((this.probe.homeMode() & 0o007) !== 0 || this.probe.botCanAccessHome(this.user)) {
        return fail("Daemon HOME must grant no access to others and must be inaccessible to the bot user");
      }
      const check: Check = { ok: true, owner };
      this.passing = { check, until: now + CACHE_MS };
      return check;
    } catch (error) {
      return fail(`Could not ${step} (${errorCode(error)})`);
    }
  }
}

function matches(entry: DirectoryInfo | undefined, owner: Identity): boolean {
  return !!entry?.isDirectory() && entry.uid === owner.uid && entry.gid === owner.gid && (entry.mode & 0o7777) === WORKSPACE_MODE;
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? "unavailable";
}
