import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Storage } from "@earendil-works/pi-durable";
import { listAgents } from "../../src/agents.js";
import { generateKeyPair, ownerAuthTag } from "../../src/nostr.js";
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
    if (edit) return fauxAssistantMessage(fauxToolCall("edit", { path: edit[1]!, oldText: "old", newText: "new" }), { stopReason: "toolUse" });
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

const homes = new WeakMap<Yewholt, string>();
const agentKeys = new Map<string, { pubkey: string; secret: string }>();

export async function openSession(
  storage: Storage,
  home: string,
  piDir: string,
  models: Models = scriptedModels(),
  isolation = new WorkspaceIsolation(home, { YEWHOLT_WORKSPACES: testWorkspaces(home), YEWHOLT_UNSAFE_SHARED_USER: "1" }),
  admins: readonly string[] = [HUMAN],
): Promise<Yewholt> {
  ensureOwnerKey(home);
  const session = await Yewholt.open(storage, { home, models, piDir, isolation, turnTokens: 1000, defaultLimit: 10_000_000, admins });
  homes.set(session, home);
  return session;
}

export function human(eventId: string, text: string, extra: Partial<HumanMessage> = {}): HumanMessage {
  return { channelId: CHANNEL, authorPubkey: HUMAN, eventId, text, createdAt: 1_795_231_700, ...extra };
}

/** Provision an agent file the way a Buzz deploy does; the same name in the same home rewrites that agent's file. */
export async function provisionAgent(session: Yewholt, home: string, name: string, permissions: string[], channelId = CHANNEL): Promise<RegistryState["bots"][number]> {
  const model = { provider: "faux", modelId: "faux-1", label: FAUX_MODEL };
  const dir = join(home, "agents");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `${home}\0${name}`;
  const agent = agentKeys.get(id) ?? generateKeyPair();
  agentKeys.set(id, agent);
  const authTag = ownerAuthTag(generateKeyPair().secret, agent.pubkey);
  writeFileSync(join(dir, `${agent.pubkey}.json`), JSON.stringify({ name, nsec: agent.secret, authTag, permissions, channelId, model }), { mode: 0o600 });
  await session.reconcileAgents(listAgents(home, { relayUrl: "wss://relay.invalid", model }));
  const bot = (await session.snapshot()).bots.find((item) => item.pubkey === agent.pubkey);
  if (!bot) throw new Error(`agent ${name} was not provisioned`);
  return bot;
}

/** Load the agent files already in the home, as the daemon does after a restart. */
export async function reconcileHome(session: Yewholt): Promise<void> {
  const home = homes.get(session);
  if (!home) throw new Error("open the session with openSession");
  await session.reconcileAgents(listAgents(home, { relayUrl: "wss://relay.invalid", model: { provider: "faux", modelId: "faux-1", label: FAUX_MODEL } }));
}

export async function createBot(session: Yewholt, name: string, permissions: string, _prefix = name): Promise<RegistryState["bots"][number]> {
  const home = homes.get(session);
  if (!home) throw new Error("open the session with openSession");
  return provisionAgent(session, home, name, permissions.split(","));
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
