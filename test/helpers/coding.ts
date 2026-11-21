import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Storage } from "@earendil-works/pi-durable";
import { ensureOwnerKey, Yewholt, type HumanMessage } from "../../src/session.js";
import { WorkspaceIsolation } from "../../src/isolation.js";
import type { RegistryState } from "../../src/registry.js";

export const CHANNEL = "22222222-2222-4222-8222-222222222222";
export const HUMAN = "ab".repeat(32);
export const FAUX_MODEL = "faux/faux-1";

type Message = { role: string; content?: unknown; isError?: boolean };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("");
}

/**
 * A scripted model, offline. The last user message decides the call:
 * `run: <command>` → bash, `read: <path>` → read, `write: <path>` → write "written".
 * After a tool result it answers `done[ok|error]: <result text>`. Anything else: `ok`.
 */
export function scriptedModels(): Models {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const respond = (context: { messages: Message[] }) => {
    const last = [...context.messages].reverse().find((message) => message.role !== "system");
    if (last?.role === "toolResult") return fauxAssistantMessage(`done[${last.isError ? "error" : "ok"}]: ${textOf(last.content).trim()}`);
    const text = last?.role === "user" ? textOf(last.content) : "";
    const run = text.match(/\brun:\s*([\s\S]+)$/);
    if (run) return fauxAssistantMessage(fauxToolCall("bash", { command: run[1]!.trim() }), { stopReason: "toolUse" });
    const read = text.match(/\bread:\s*(\S+)/);
    if (read) return fauxAssistantMessage(fauxToolCall("read", { path: read[1]! }), { stopReason: "toolUse" });
    const write = text.match(/\bwrite:\s*(\S+)/);
    if (write) return fauxAssistantMessage(fauxToolCall("write", { path: write[1]!, content: "written\n" }), { stopReason: "toolUse" });
    const edit = text.match(/\bedit:\s*(\S+)/);
    if (edit) return fauxAssistantMessage(fauxToolCall("edit", { path: edit[1]!, edits: [{ oldText: "old", newText: "new" }] }), { stopReason: "toolUse" });
    return fauxAssistantMessage("ok");
  };
  faux.setResponses(Array.from({ length: 200 }, () => respond as never));
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

/** A Pi settings folder with no packages, so tests never read ~/.pi/agent. */
export function emptyPiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yewholt-pi-"));
  writeFileSync(join(dir, "settings.json"), "{}\n");
  return dir;
}

export function testWorkspaces(home: string): string {
  return join(dirname(home), `${basename(home)}-workspaces`);
}

export async function openSession(
  storage: Storage,
  home: string,
  piDir: string,
  models: Models = scriptedModels(),
  isolation = new WorkspaceIsolation(home, { YEWHOLT_WORKSPACES: testWorkspaces(home), YEWHOLT_UNSAFE_SHARED_USER: "1" }),
  admins: readonly string[] = [HUMAN],
): Promise<Yewholt> {
  ensureOwnerKey(home);
  return Yewholt.open(storage, { home, models, piDir, isolation, turnTokens: 1000, defaultLimit: 10_000_000, admins });
}

export function human(eventId: string, text: string, extra: Partial<HumanMessage> = {}): HumanMessage {
  return { channelId: CHANNEL, authorPubkey: HUMAN, eventId, text, createdAt: 1_795_231_700, ...extra };
}

/** Create a bot through the Onboarding Specialist's proposal flow. */
export async function createBot(session: Yewholt, name: string, permissions: string, prefix = name): Promise<RegistryState["bots"][number]> {
  await session.handleHuman(human(`${prefix}-create`, `create bot name: ${name} model: ${FAUX_MODEL} scope: this permissions: ${permissions}`));
  await session.handleHuman(human(`${prefix}-approve`, "@Onboarding Specialist approve"));
  const bot = (await session.snapshot()).bots.find((item) => item.name === name);
  if (!bot) throw new Error(`bot ${name} was not created`);
  return bot;
}

export async function waitUntil<T>(probe: () => Promise<T | undefined | false>, what: string, ms = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function chatFrom(state: RegistryState, pubkey: string): string[] {
  return state.outbox.filter((event) => event.kind === 9 && event.pubkey === pubkey).map((event) => event.content);
}
