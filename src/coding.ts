import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { classifyBash } from "./danger.js";
import { judgePath, type Roots } from "./workspace.js";

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export type CallVerdict =
  | { kind: "allow" }
  | { kind: "refuse"; reason: string }
  | { kind: "approve"; subject: string; reasons: string[] };

export type ApprovalAsk = {
  tool: string;
  subject: string;
  reasons: string[];
};

/** Pure decision for one call, given the bot's roots (path checks resolve symlinks on disk). */
export function judgeCall(name: string, args: Record<string, unknown> | undefined, roots: Roots & { homeAliases?: string[] }): CallVerdict {
  if (name === "bash") {
    const command = args?.command;
    if (typeof command !== "string") return { kind: "approve", subject: JSON.stringify(args ?? {}), reasons: ["could not read the command"] };
    const verdict = classifyBash(command, { home: roots.home, homeAliases: roots.homeAliases });
    return verdict.approval ? { kind: "approve", subject: command, reasons: verdict.reasons } : { kind: "allow" };
  }
  if (name === "read" || name === "write" || name === "edit") {
    const path = args?.path;
    if (typeof path !== "string" || path === "") return { kind: "refuse", reason: "no path given" };
    const verdict = judgePath(name, path, roots);
    if (verdict.kind === "allow") return verdict;
    if (verdict.kind === "refuse") return verdict;
    return { kind: "approve", subject: path, reasons: [verdict.reason] };
  }
  return { kind: "allow" };
}

/** One key per tool and exact arguments: an approval binds to what the person saw. */
export function approvalKey(name: string, args: unknown): string {
  return `a${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([name, args ?? null])))).slice(0, 40)}`;
}
