import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  defineExtension,
  defineSignal,
  hook,
  ToolTask,
  type ConversationId,
  type Extension,
  type TaskId,
} from "@earendil-works/pi-durable";
import { bool, obj, str } from "@earendil-works/pi-schema";
import { classifyBash } from "./danger.js";
import { GATE_EXTENSION } from "./packages.js";
import { judgePath, type Roots } from "./workspace.js";

/**
 * A person's answer to one parked call. Delivered with `harness.signal(taskId, ApprovalDecision, key, ...)`
 * by the session when someone replies `aprovo`/`rejeito` in the channel. Stored in the task record, so it
 * survives a restart; one value per key, so a second answer is a `duplicate` and never runs the call again.
 */
export const ApprovalDecision = defineSignal({
  name: "yewholt.approval",
  version: 1,
  schema: obj({ allow: bool(), by: str() }),
});

/** How long a parked call waits for an answer before it is refused. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export type CallVerdict =
  | { kind: "allow" }
  | { kind: "refuse"; reason: string }
  | { kind: "approve"; subject: string; reasons: string[] };

export type ApprovalAsk = {
  conversationId: ConversationId;
  taskId: TaskId;
  key: string;
  tool: string;
  subject: string;
  reasons: string[];
};

/** What the gate needs from the session. */
export type GateHost = {
  /** Home and workspace of the code bot that owns this conversation; undefined when it has no `code`. */
  roots(conversationId: ConversationId): Promise<(Roots & { homeAliases: string[] }) | undefined>;
  /** Store the request and post it in the channel. Idempotent by (taskId, key): the gate reruns on every wake. */
  request(ask: ApprovalAsk): Promise<void>;
  /** Forget a request whose deadline passed. */
  expire(taskId: TaskId, key: string): Promise<void>;
};

const GATED = new Set(["bash", "read", "write", "edit"]);

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

/**
 * The `yewholt-code` extension: a `beforeTool` gate (pi-durable README, "Gates before a tool
 * runs"). Allowed calls pass; $YEWHOLT_HOME outside the workspace is blocked outright; calls
 * that need approval park on an `ApprovalDecision` signal (with a 24-hour deadline) after the
 * session posted the request. Every wake reruns this from the top, so it reads the signal
 * first and only asks when there is no answer yet.
 */
export function createGateExtension(host: GateHost): Extension {
  return defineExtension({
    name: GATE_EXTENSION,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          if (!GATED.has(call.name)) return undefined;
          const roots = await host.roots(api.conversationId);
          if (!roots) return { block: "This bot has no workspace: its code permission is off." };
          const verdict = judgeCall(call.name, call.arguments as Record<string, unknown> | undefined, roots);
          if (verdict.kind === "allow") return undefined;
          if (verdict.kind === "refuse") return { block: `Refused (not approvable): ${verdict.reason}.` };
          const key = approvalKey(call.name, call.arguments);
          const state = await api.readSignal(ApprovalDecision, key, context);
          if (state !== undefined && "value" in state) {
            return state.value.allow ? undefined : { block: `A person rejected this in the chat; it was not run: ${verdict.subject}` };
          }
          if (state !== undefined) {
            await host.expire(api.taskId, key);
            return { block: `No approval within 24 hours; it was not run: ${verdict.subject}` };
          }
          // One deadline per question: later passes reuse the memoized one.
          const until = await api.memo(`yewholt.approval.until.${key}`, api.now() + APPROVAL_TTL_MS, context);
          await host.request({
            conversationId: api.conversationId,
            taskId: api.taskId,
            key,
            tool: call.name,
            subject: verdict.subject,
            reasons: verdict.reasons,
          });
          return { sleep: { signals: [ApprovalDecision.key(key)], until } };
        },
      }),
    ],
  });
}
