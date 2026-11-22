import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  createAgentSession, createBashToolDefinition, createCodemodeExtension, createMcpExtension,
  createToolSearchExtension, DefaultResourceLoader, getAgentDir, ModelRuntime,
  SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory, type LoadedMcpConfig, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { judgeCall, type ApprovalAsk } from "./coding.js";
import type { BotRecord } from "./registry.js";
import { physicalPath, toolPath, within, workspaceCommand, workspaceId, type Roots } from "./workspace.js";
import { runWorkspaceCommand } from "./workspace-process.js";

export { getAgentDir as piDir };

export type BotSessionHost = {
  roots(): (Roots & { homeAliases: string[] }) | { refusal: string };
  approve(ask: ApprovalAsk): Promise<boolean>;
  bashUser?: string;
};

export async function botModelRuntime(agentDir: string, models?: Models): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
  });
  if (models) {
    for (const provider of models.getProviders()) runtime.registerNativeProvider(provider);
    await runtime.refresh({ allowNetwork: false });
  }
  return runtime;
}

export async function createBotSession(
  bot: BotRecord, cwd: string, agentDir: string, runtime: ModelRuntime,
  instructions: string, host: BotSessionHost,
): Promise<AgentSession> {
  const code = bot.permissions.includes("code");
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const mcpModule = await import(new URL("./extensions/mcp/config.js",
    import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
      loadMcpConfig: (options: { cwd: string; agentDir: string; projectTrusted: boolean }) => LoadedMcpConfig;
    };
  let skillRoots: string[] = [];
  const gate: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\n\n" + instructions }));
    pi.on("before_provider_headers", (event) => { event.headers["Accept-Encoding"] = "identity"; });
    pi.on("tool_call", async (event) => {
      const name = event.toolName;
      if (!["bash", "powershell", "read", "write", "edit", "ls", "grep", "find"].includes(name)) return;
      const input = event.input as Record<string, unknown>;
      if (!code) {
        if (name !== "read" || typeof input.path !== "string") return { block: true, reason: "This bot has no code permission." };
        let path: string;
        try { path = physicalPath(toolPath(input.path, cwd)); }
        catch { return { block: true, reason: "Cannot resolve skill path." }; }
        if (!skillRoots.some((root) => within(path, root))) return { block: true, reason: "This bot may read only installed skill files." };
        return;
      }
      const roots = host.roots();
      if ("refusal" in roots) return { block: true, reason: "Refused. " + roots.refusal };
      if (name === "powershell") return { block: true, reason: "Only the isolated bash tool is available." };
      const path = typeof input.path === "string" ? input.path : ".";
      if (name !== "bash") {
        try {
          const physical = physicalPath(toolPath(path, cwd));
          if (within(physical, physicalPath(join(agentDir, "sessions")))) {
            return { block: true, reason: "Pi session files are private." };
          }
        } catch { return { block: true, reason: "Cannot resolve path." }; }
      }
      const verdict = judgeCall(["ls", "grep", "find"].includes(name) ? "read" : name, { ...input, path }, roots);
      if (verdict.kind === "allow") return;
      if (verdict.kind === "refuse") return { block: true, reason: "Refused (not approvable): " + verdict.reason };
      const allow = await host.approve({ tool: name, subject: verdict.subject, reasons: verdict.reasons });
      return allow ? undefined : { block: true, reason: "A person rejected this in the chat; it was not run: " + verdict.subject };
    });
  };
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: settings, noContextFiles: true,
    agentsFilesOverride: () => {
      try { return { agentsFiles: [{ path: join(agentDir, "AGENTS.md"), content: readFileSync(join(agentDir, "AGENTS.md"), "utf8") }] }; }
      catch { return { agentsFiles: [] }; }
    },
    extensionFactories: [
      createCodemodeExtension({ mode: "on" }), createToolSearchExtension(),
      createMcpExtension({
        loadConfig: () => mcpModule.loadMcpConfig({ cwd, agentDir, projectTrusted: false }),
        logPath: join(agentDir, "mcp.log"),
      }), gate,
    ],
  });
  await loader.reload({ resolveProjectTrust: async () => false });
  settings.applyOverrides({ retry: { enabled: false }, defaultTools: ["read", "bash", "edit", "write", "tool_search"] });
  skillRoots = loader.getSkills().skills.map((skill) => physicalPath(skill.baseDir));
  const sessionDir = join(agentDir, "sessions", "yewholt-" + workspaceId(bot.pubkey));
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const bash = createBashToolDefinition(cwd, {
    exposeSessionEnvironment: false,
    operations: {
      exec: async (command, _cwd, options) => {
        const roots = host.roots();
        if ("refusal" in roots) throw new Error(roots.refusal);
        const result = await runWorkspaceCommand(workspaceCommand(cwd, command, host.bashUser), cwd, {
          timeout: options.timeout,
          onOutput: (text) => options.onData(Buffer.from(text)),
        }, BACKGROUND_CONTEXT, options.signal);
        if (!result.ok) throw result.error;
        return { exitCode: result.value.exitCode };
      },
    },
  });
  const recent = (await SessionManager.listAll(sessionDir))[0];
  const { session } = await createAgentSession({
    cwd, agentDir, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader,
    sessionManager: recent ? SessionManager.open(recent.path, sessionDir, cwd) : SessionManager.create(cwd, sessionDir),
    excludeTools: code ? ["powershell"] : ["bash", "powershell", "write", "edit", "ls", "grep", "find"],
    customTools: code ? [bash as ToolDefinition] : undefined,
  });
  session.setSessionName(bot.name);
  await session.bindExtensions({});
  return session;
}
