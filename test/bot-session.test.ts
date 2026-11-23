import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { workspaceDir, workspaceId } from "../src/workspace.js";
import { chatFrom, createBot, human, openSession, reconcileHome, testWorkspaces } from "./helpers/coding.js";

function file(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

test("SDK sessions load global skills, MCP and package extensions, never workspace resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "yewholt-sdk-"));
  const home = join(root, "home");
  const agentDir = join(root, "pi");
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    calls.push(message.method);
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list"
        ? { tools: [{ name: "ping", description: "A fixture tool", inputSchema: { type: "object", properties: {} } }] }
        : { content: [{ type: "text", text: "pong" }] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  file(join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: { fixture: { url: `http://127.0.0.1:${address.port}/mcp`, exposure: "direct" } },
  }));
  file(join(agentDir, "skills", "greeting", "SKILL.md"), "---\nname: greeting\ndescription: A global greeting skill\n---\nSay hello.\n");
  file(join(agentDir, "packages", "fixture", "package.json"), JSON.stringify({
    name: "fixture", type: "module", pi: { extensions: ["./extension.mjs"] },
  }));
  file(join(agentDir, "packages", "fixture", "extension.mjs"), `
import { fauxAssistantMessage, fauxProvider } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/providers/faux"))};

export default (pi) => {
  pi.registerTool({ name: "fixture_tool", label: "Fixture", description: "A trusted tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: {} }) });
  pi.registerProvider("fixture-provider", {
    baseUrl: "https://example.invalid", apiKey: "fixture-key", api: "openai-completions",
    models: [{ id: "fixture-model", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }]
  });
  const native = fauxProvider({ provider: "fixture-native", models: [{ id: "fixture-model" }] });
  native.setResponses([fauxAssistantMessage("Reply from the Pi package provider")]);
  pi.registerProvider(native.provider);
};
`);
  const storage = new MemoryStorage();
  const session = await openSession(storage, home, agentDir);
  try {
    assert.ok(!session.availableModelReferences().includes("fixture-provider/fixture-model"));
    file(join(agentDir, "settings.json"), JSON.stringify({ packages: ["./packages/fixture"] }));
    await session.refreshModels();
    assert.ok(session.availableModelReferences().includes("fixture-provider/fixture-model"));
    assert.ok(session.availableModelReferences().includes("fixture-native/fixture-model"));
    const packageModel = { provider: "fixture-native", modelId: "fixture-model", label: "fixture-native/fixture-model" };
    assert.equal(session.hasModel(packageModel), true);
    const coder = await createBot(session, "Coder", "post,read,code");
    const workspace = workspaceDir(testWorkspaces(home), coder.pubkey);
    const marker = join(root, "workspace-extension-ran");
    const untrusted = `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
export default () => {};`;
    file(join(workspace, ".pi", "settings.json"), JSON.stringify({
      extensions: ["./evil.mjs"], packages: ["./evil-package"], defaultTools: ["powershell"],
    }));
    file(join(workspace, ".pi", "extensions", "evil.mjs"), untrusted);
    file(join(workspace, ".pi", "evil.mjs"), untrusted);
    file(join(workspace, ".pi", "evil-package", "package.json"), JSON.stringify({
      name: "evil", type: "module", pi: { extensions: ["./extension.mjs"] },
    }));
    file(join(workspace, ".pi", "evil-package", "extension.mjs"), untrusted);
    file(join(workspace, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fixture: { enabled: false } } }));
    file(join(workspace, ".pi", "skills", "evil", "SKILL.md"), "---\nname: evil\ndescription: WORKSPACE_SKILL\n---\nBad.\n");
    file(join(workspace, "AGENTS.md"), "WORKSPACE_CONTEXT");
    file(join(workspace, ".pi", "SYSTEM.md"), "WORKSPACE_SYSTEM");
    file(join(workspace, ".pi", "APPEND_SYSTEM.md"), "WORKSPACE_APPEND");
    await session.handleHuman(human("resources", "@Coder hello"));
    const sdk = await session.botSession(coder.pubkey);
    assert.equal((await session.botSession(coder.pubkey)), sdk);
    assert.match(chatFrom(await session.snapshot(), coder.pubkey).at(-1) ?? "", /ok/);
    assert.match(sdk.systemPrompt, /greeting/);
    assert.doesNotMatch(sdk.systemPrompt, /WORKSPACE_/);
    assert.equal(existsSync(marker), false);
    assert.ok(sdk.getActiveToolNames().includes("fixture_tool"));
    assert.ok(sdk.getActiveToolNames().includes("mcp__fixture__ping"));
    assert.ok(calls.includes("tools/list"));
    assert.ok(session.availableModelReferences().includes("fixture-provider/fixture-model"));
    const plain = await createBot(session, "Plain", "post,read");
    await session.handleHuman(human("plain-resource", "@Plain hello"));
    const chat = await session.botSession(plain.pubkey);
    assert.ok(chat.getActiveToolNames().includes("fixture_tool"));
    assert.ok(chat.getActiveToolNames().includes("mcp__fixture__ping"));
    for (const name of ["bash", "write", "edit"]) assert.ok(!chat.getAllTools().some((tool) => tool.name === name));
    await session.handleHuman(human("skill-read", `@Plain read: ${join(agentDir, "skills", "greeting", "SKILL.md")}`));
    assert.match(chatFrom(await session.snapshot(), plain.pubkey).at(-1) ?? "", /Say hello/);
    await session.handleHuman(human("private-read", `@Plain read: ${join(agentDir, "settings.json")}`));
    assert.match(chatFrom(await session.snapshot(), plain.pubkey).at(-1) ?? "", /only installed skill files/);
    const provision = join(home, "agents", plain.pubkey + ".json");
    file(provision, JSON.stringify({ ...JSON.parse(readFileSync(provision, "utf8")), model: packageModel }));
    await reconcileHome(session);
    await session.handleHuman(human("package-provider", "@Plain hello"));
    assert.match(chatFrom(await session.snapshot(), plain.pubkey).at(-1) ?? "", /Reply from the Pi package provider/);
    const dir = join(agentDir, "sessions", "yewholt-" + workspaceId(coder.pubkey));
    assert.equal(readdirSync(dir).filter((name) => name.endsWith(".jsonl")).length, 1);
    const path = sdk.sessionManager.getSessionFile();
    assert.ok(path);
    assert.match(readFileSync(path, "utf8"), /"type":"session_info".*"name":"Coder"/);
    await session.updateHostedName(coder.pubkey, "Renamed");
    assert.match(readFileSync(path, "utf8"), /"name":"Renamed"/);
    assert.ok((await SessionManager.listAll(dir)).some((item) => item.name === "Renamed"));
  } finally {
    await session.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("SDK bot history continues after reopen and prompts to one bot serialize", async () => {
  const root = mkdtempSync(join(tmpdir(), "yewholt-sdk-history-"));
  const home = join(root, "home");
  const agentDir = join(root, "pi");
  file(join(agentDir, "settings.json"), "{}");
  const db = join(root, "registry.sqlite");
  let session = await openSession(await openNodeSqliteStorage(db), home, agentDir);
  try {
    const bot = await createBot(session, "Named bot", "post,read");
    await Promise.all([
      session.handleHuman(human("first", "@Named bot hello")),
      session.handleHuman(human("second", "@Named bot hello again")),
    ]);
    const sdk = await session.botSession(bot.pubkey);
    const path = sdk.sessionManager.getSessionFile();
    assert.ok(path);
    assert.equal(sdk.messages.filter((message) => message.role === "user").length, 2);
    const spent = (await session.snapshot()).bots[0]!.spentTokens;
    assert.ok(spent >= 2000);
    await session.close();
    session = await openSession(await openNodeSqliteStorage(db), home, agentDir);
    await reconcileHome(session);
    await session.resumeTurns();
    await session.updateHostedName(bot.pubkey, "Renamed after restart");
    assert.match(readFileSync(path, "utf8"), /"name":"Renamed after restart"/);
    const resumed = await session.botSession(bot.pubkey);
    assert.equal(resumed.sessionManager.getSessionFile(), path);
    assert.equal(resumed.messages.filter((message) => message.role === "user").length, 2);
    await Promise.all([
      session.handleHuman(human("third", "@Renamed after restart hello")),
      session.handleHuman(human("third", "@Renamed after restart hello")),
    ]);
    assert.equal(resumed.messages.filter((message) => message.role === "user").length, 3);
    const expected = resumed.messages.reduce((sum, message) =>
      sum + (message.role === "assistant" ? Math.max(1000, message.usage.totalTokens) : 0), 0);
    assert.equal((await session.snapshot()).bots[0]!.spentTokens, expected);
  } finally {
    await session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
