import { lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { err, ExecutionError, type ShellExecOptions } from "@earendil-works/pi-durable/env";
import { runWorkspaceCommand } from "./workspace-process.js";

/** Stable folder id: the first 16 hex of sha256("yewholt-workspace:" + pubkey). */
export function workspaceId(pubkey: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`yewholt-workspace:${pubkey}`))).slice(0, 16);
}

export function workspaceDir(workspaces: string, pubkey: string): string {
  return join(workspaces, workspaceId(pubkey));
}

const FALLBACK_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * The whole environment of a `code` bot's commands. Nothing else from the daemon's
 * process.env (which holds provider API keys from $YEWHOLT_HOME/.env) is passed on.
 */
export function workspaceEnvVars(workspace: string): Record<string, string> {
  return {
    PATH: process.env.PATH || FALLBACK_PATH,
    HOME: workspace,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    TMPDIR: join(workspace, ".tmp"),
  };
}

// The bootstrap runs after sudo switches users. Job control gives the command its own
// process group. The stdin watcher also cancels it if the daemon or sudo closes the pipe.
export const WORKSPACE_BOOTSTRAP = [
  'umask 007; cd -- "$1" || exit',
  'set -m',
  'worker=',
  'stop() {',
  '  cancelled=1',
  '  if [[ -n $worker ]]; then',
  '    kill -KILL -- "-$worker" 2>/dev/null',
  '    exit 143',
  '  fi',
  '}',
  'trap stop TERM INT HUP',
  '/bin/bash -c "$2" yewholt "${@:3}" </dev/null &',
  'worker=$!',
  '[[ -z ${cancelled:-} ]] || stop',
  '{ read -r || kill -TERM "$$"; } <&0 &',
  'watcher=$!',
  'wait "$worker"; result=$?',
  'kill "$watcher" 2>/dev/null || :',
  'exit "$result"',
].join("\n");

export function workspaceCommand(workspace: string, command: string | readonly string[], user?: string): string[] {
  const env = Object.entries(workspaceEnvVars(workspace)).map(([key, value]) => `${key}=${value}`);
  const args = typeof command === "string" ? [command] : ['exec "$@"', ...command];
  return [
    ...(user === undefined ? [] : ["sudo", "-n", "-u", user, "--"]),
    "/usr/bin/env", "-i", ...env,
    "/bin/bash", "-c", WORKSPACE_BOOTSTRAP, "yewholt", workspace, ...args,
  ];
}

/**
 * Adapted from block/buzz-app src/bundled/pi/host.mjs (the Harness `env` option:
 * `new NodeExecutionEnv({ cwd, shellEnv })` per conversation), commit
 * 9657bb35451c99d3cf1687f1af9ca76fa7f001f0, Apache-2.0, see NOTICE.
 */
export class WorkspaceEnv extends NodeExecutionEnv {
  private readonly running = new Set<AbortController>();

  constructor(
    readonly workspace: string,
    private readonly user: string | undefined,
    private readonly refusal: () => string | undefined,
  ) {
    super({ cwd: workspace });
  }

  override async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): ReturnType<NodeExecutionEnv["exec"]> {
    const refusal = this.refusal();
    if (refusal) return err(new ExecutionError("spawn_error", refusal));
    if (typeof command !== "string" && command.length === 0) {
      return err(new ExecutionError("spawn_error", "Empty argv: no program to run"));
    }
    const controller = new AbortController();
    this.running.add(controller);
    try {
      return await runWorkspaceCommand(workspaceCommand(this.workspace, command, this.user), this.workspace, options, context, controller.signal);
    } finally {
      this.running.delete(controller);
    }
  }

  override async cleanup(context: Context): Promise<void> {
    for (const controller of this.running) controller.abort();
    await super.cleanup(context);
  }
}

export type PathVerdict = { kind: "allow" } | { kind: "approve"; reason: string } | { kind: "refuse"; reason: string };
export type Roots = { home: string; workspace: string };

/**
 * What a `read`, `write` or `edit` call on `rawPath` may do:
 * - inside the bot's own workspace (after resolving symlinks): allow;
 * - $YEWHOLT_HOME or the shared root outside this bot's workspace: refuse, not approvable;
 * - elsewhere: read is allowed, write/edit need approval.
 * A path that cannot be resolved is refused (fail closed).
 */
export function judgePath(tool: "read" | "write" | "edit", rawPath: string, roots: Roots): PathVerdict {
  const requested = toolPath(rawPath, roots.workspace);
  let lexical: string;
  let physical: string;
  let home: string;
  let workspace: string;
  try {
    lexical = tool === "read" ? resolveReadPath(requested) : requested;
    physical = physicalPath(lexical);
    home = physicalPath(resolve(roots.home));
    workspace = physicalPath(resolve(roots.workspace));
  } catch (error) {
    return { kind: "refuse", reason: `cannot resolve ${rawPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const configuredHome = resolve(roots.home);
  if (within(physical, home) || [requested, lexical].some((path) => within(path, configuredHome) || within(path, home))) {
    return { kind: "refuse", reason: `${rawPath} is in Yewholt's state folder` };
  }
  if (within(physical, workspace)) return { kind: "allow" };
  // Other bot folders were previously covered by the state-folder refusal.
  if (within(physical, dirname(workspace)) || (within(lexical, dirname(resolve(roots.workspace))) && !within(lexical, resolve(roots.workspace)))) {
    return { kind: "refuse", reason: `${rawPath} is in the shared workspaces folder, outside this bot's workspace` };
  }
  if (tool === "read") return { kind: "allow" };
  return { kind: "approve", reason: `${tool} outside the workspace` };
}

/** Match pi-durable's path-utils normalization and NodeExecutionEnv.absolutePath. */
export function toolPath(rawPath: string, cwd: string): string {
  const normalized = rawPath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  let path = normalized.startsWith("@") ? normalized.slice(1) : normalized;
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  else if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      // pi-durable treats malformed file URLs as ordinary paths.
    }
  }
  return resolve(cwd, path);
}

/** The read tool uses the first existing spelling, testing with lstat. */
function resolveReadPath(path: string): string {
  const variants = [
    path,
    path.replace(/ (AM|PM)\./gi, "\u202F$1."),
    path.normalize("NFD"),
    path.replace(/'/g, "\u2019"),
    path.normalize("NFD").replace(/'/g, "\u2019"),
  ];
  for (const variant of new Set(variants)) {
    try {
      lstatSync(variant);
      return variant;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return path;
}

export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The path the OS would reach: every existing component's symlink followed (also dangling
 * ones, whose target is where a write would land), `..` in link targets applied physically.
 * Components after the first missing one are appended as written.
 */
export function physicalPath(input: string): string {
  let queue = resolve(input).split(sep).filter(Boolean);
  let current: string = sep;
  let hops = 0;
  while (queue.length > 0) {
    const segment = queue.shift()!;
    if (segment === ".") continue;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return resolve(next, ...queue);
      throw error;
    }
    if (!isLink) {
      current = next;
      continue;
    }
    if (++hops > 40) throw new Error("too many symbolic links");
    const target = readlinkSync(next);
    if (isAbsolute(target)) current = sep;
    queue = [...target.split(sep).filter(Boolean), ...queue];
  }
  return current;
}
