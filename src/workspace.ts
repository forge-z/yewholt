import { chmodSync, lstatSync, mkdirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ShellExecOptions } from "@earendil-works/pi-durable/env";

/** `$YEWHOLT_HOME/workspaces`: one folder per `code` bot. */
export function workspacesDir(home: string): string {
  return join(home, "workspaces");
}

/** Stable folder id: the first 16 hex of sha256("yewholt-workspace:" + pubkey). */
export function workspaceId(pubkey: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`yewholt-workspace:${pubkey}`))).slice(0, 16);
}

export function workspaceDir(home: string, pubkey: string): string {
  return join(workspacesDir(home), workspaceId(pubkey));
}

/** Create (or tighten) the bot's workspace and its TMPDIR, mode 0700. Returns the path. */
export function ensureWorkspace(home: string, pubkey: string): string {
  const parent = workspacesDir(home);
  const dir = workspaceDir(home, pubkey);
  mkdirSync(join(dir, ".tmp"), { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  chmodSync(dir, 0o700);
  chmodSync(join(dir, ".tmp"), 0o700);
  return dir;
}

/** Is `dir` exactly one bot workspace folder under this home? */
export function isWorkspaceDir(home: string, dir: string): boolean {
  const parent = resolve(workspacesDir(home));
  const target = resolve(dir);
  return dirname(target) === parent && /^[0-9a-f]{16}$/.test(target.slice(parent.length + 1));
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

/**
 * Adapted from block/buzz-app src/bundled/pi/host.mjs (the Harness `env` option:
 * `new NodeExecutionEnv({ cwd, shellEnv })` per conversation), commit
 * 9657bb35451c99d3cf1687f1af9ca76fa7f001f0, Apache-2.0, see NOTICE.
 *
 * pi-durable's NodeExecutionEnv with its cwd at the workspace, except that every command
 * runs with `workspaceEnvVars()` only (Buzz's inherits the host's environment).
 * NodeExecutionEnv merges process.env into every child unless the call passes
 * `inheritEnv: false`; this forces that for every caller, the built-in `bash` included.
 */
export class WorkspaceEnv extends NodeExecutionEnv {
  private readonly vars: Record<string, string>;

  constructor(readonly workspace: string) {
    super({ cwd: workspace });
    this.vars = workspaceEnvVars(workspace);
  }

  override exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context) {
    return super.exec(command, { ...options, env: { ...this.vars }, inheritEnv: false }, context);
  }
}

export type PathVerdict = { kind: "allow" } | { kind: "approve"; reason: string } | { kind: "refuse"; reason: string };
export type Roots = { home: string; workspace: string };

/**
 * What a `read`, `write` or `edit` call on `rawPath` may do:
 * - inside the bot's own workspace (after resolving symlinks): allow;
 * - anywhere else in $YEWHOLT_HOME (lexically or after resolving symlinks): refuse, not approvable;
 * - elsewhere: read is allowed, write/edit need approval.
 * A path that cannot be resolved is refused (fail closed).
 */
export function judgePath(tool: "read" | "write" | "edit", rawPath: string, roots: Roots): PathVerdict {
  const lexical = toolPath(rawPath, roots.workspace);
  let physical: string;
  let home: string;
  let workspace: string;
  try {
    physical = physicalPath(lexical);
    home = physicalPath(resolve(roots.home));
    workspace = physicalPath(resolve(roots.workspace));
  } catch (error) {
    return { kind: "refuse", reason: `cannot resolve ${rawPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (within(physical, workspace)) return { kind: "allow" };
  // In $YEWHOLT_HOME where the OS lands, or named through it (outside the workspace) even if a link there points elsewhere.
  const homeLexical = resolve(roots.home);
  const workspaceLexical = resolve(roots.workspace);
  const namedInHome =
    (within(lexical, homeLexical) && !within(lexical, workspaceLexical)) || (within(lexical, home) && !within(lexical, workspace));
  if (within(physical, home) || namedInHome) {
    return { kind: "refuse", reason: `${rawPath} is in Yewholt's state folder, outside this bot's workspace` };
  }
  if (tool === "read") return { kind: "allow" };
  return { kind: "approve", reason: `${tool} outside the workspace` };
}

/** The absolute path pi-durable's tools act on: `@` prefix and Unicode spaces as in its path-utils, then resolve(cwd, path). */
export function toolPath(rawPath: string, cwd: string): string {
  const normalized = rawPath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  return resolve(cwd, normalized.startsWith("@") ? normalized.slice(1) : normalized);
}

function within(path: string, root: string): boolean {
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
