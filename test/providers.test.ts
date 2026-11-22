import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { ensureEnvFile, loadEnvFile } from "../src/env-file.js";
import { catalogHas, loadModels, parseModelLabel } from "../src/models.js";
import { Yewholt } from "../src/session.js";

const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));
const examplePath = fileURLToPath(new URL("../../.env.example", import.meta.url));

test("an empty env registers no providers and ignores process.env", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "from-the-process";
  try {
    const models = await loadModels({});
    assert.deepEqual(models.getProviders().map((provider) => provider.id), []);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("OpenCode Zen key registers Zen and Go, including free models", async () => {
  const models = await loadModels({ OPENCODE_API_KEY: "test-key" });
  assert.deepEqual(
    models.getProviders().map((provider) => provider.id).sort(),
    ["opencode", "opencode-go"],
  );
  assert.equal(catalogHas(models, parseModelLabel("opencode/big-pickle")), true);
  assert.equal(catalogHas(models, parseModelLabel("opencode/deepseek-v4.1-flash-free")), true);
});

test("a DeepSeek environment key enables its models without a Pi login", async () => {
  const model = parseModelLabel("deepseek/deepseek-v4-pro");
  assert.equal(catalogHas(await loadModels({}), model), false);
  const models = await loadModels({ DEEPSEEK_API_KEY: "test-key" });
  assert.deepEqual(models.getProviders().map((provider) => provider.id), ["deepseek"]);
  assert.equal(catalogHas(models, model), true);
});

test("a saved Pi API key enables DeepSeek in the hosted catalog and authenticates model requests", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yewholt-pi-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    deepseek: { type: "api_key", key: "pi-test-key" },
  }), { mode: 0o600 });
  const session = await Yewholt.open(new MemoryStorage(), { home: join(dir, "state"), piDir: dir });
  try {
    assert.ok(session.availableModelReferences().includes("deepseek/deepseek-flash"));
  } finally {
    await session.close();
  }
  const models = await loadModels({}, authPath);
  assert.equal((await models.getAuth("deepseek"))?.auth.apiKey, "pi-test-key");

  const overridden = await loadModels({ DEEPSEEK_API_KEY: "env-test-key" }, authPath);
  assert.equal((await overridden.getAuth("deepseek"))?.auth.apiKey, "env-test-key");
});

function oauthCredential(expires = Date.now() + 3_600_000) {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url");
  return { type: "oauth", access: `test.${payload}.signature`, refresh: "test-refresh", expires };
}

test("saved OAuth logins list every supporting built-in provider except Anthropic in the daemon catalog", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yewholt-oauth-catalog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const providers = builtinProviders().filter((provider) => provider.auth.oauth);
  writeFileSync(join(dir, "auth.json"), JSON.stringify(Object.fromEntries(
    providers.map((provider) => [provider.id, oauthCredential()]),
  )), { mode: 0o600 });
  const models = await loadModels({}, join(dir, "auth.json"));
  for (const provider of providers) {
    assert.equal(models.getProvider(provider.id) !== undefined, provider.id !== "anthropic", provider.id);
  }
  const session = await Yewholt.open(new MemoryStorage(), { home: join(dir, "state"), piDir: dir });
  try {
    const references = session.availableModelReferences();
    assert.ok(references.some((model) => model.startsWith("openai-codex/")));
    assert.ok(!references.some((model) => model.startsWith("anthropic/")));
  } finally {
    await session.close();
  }
});

test("model requests use the saved Codex OAuth token without modifying auth.json", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yewholt-oauth-request-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json"), credential = oauthCredential();
  const content = JSON.stringify({ "openai-codex": credential });
  writeFileSync(authPath, content, { mode: 0o600 });
  const models = await loadModels({}, authPath);
  const model = models.getModels("openai-codex")[0];
  assert.ok(model);
  let requests = 0;
  const result = await models.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }, {
    transport: "sse", maxRetries: 0,
    fetch: async (input, init) => {
      requests++;
      assert.match(String(input), /^https:\/\/chatgpt.com\/backend-api\/codex\/responses$/);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${credential.access}`);
      assert.equal(headers.get("chatgpt-account-id"), "test-account");
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
        id: "test-response", status: "completed", output: [],
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  assert.equal(result.stopReason, "stop", result.errorMessage ?? "model request failed");
  assert.equal(requests, 1);
  assert.equal(readFileSync(authPath, "utf8"), content);
});

test("OAuth refresh is persisted once under Pi's lock without losing another login", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yewholt-oauth-refresh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json"), refreshed = oauthCredential();
  writeFileSync(authPath, JSON.stringify({
    "openai-codex": oauthCredential(Date.now() - 1),
    deepseek: { type: "api_key", key: "old-key" },
    unrelated: { type: "api_key", key: "preserved" },
  }), { mode: 0o600 });
  const first = await loadModels({}, authPath), second = await loadModels({}, authPath);
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  let requests = 0, started!: () => void, finish!: () => void;
  const refreshing = new Promise<void>((resolve) => { started = resolve; });
  const release = new Promise<void>((resolve) => { finish = resolve; });
  globalThis.fetch = async (input, init) => {
    requests++;
    assert.equal(String(input), "https://auth.openai.com/oauth/token");
    assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "test-refresh");
    started();
    await release;
    return Response.json({ access_token: refreshed.access, refresh_token: "rotated-refresh", expires_in: 3600 });
  };
  const one = first.getAuth("openai-codex");
  await refreshing;
  const two = second.getAuth("openai-codex");
  const login = second.login("deepseek", "api_key", { prompt: async () => "concurrent-key", notify: () => {} });
  finish();
  const [a, b] = await Promise.all([one, two, login]);
  assert.equal(a?.auth.apiKey, refreshed.access);
  assert.equal(b?.auth.apiKey, refreshed.access);
  assert.equal(requests, 1);
  const saved = JSON.parse(readFileSync(authPath, "utf8"));
  assert.equal(saved["openai-codex"].refresh, "rotated-refresh");
  assert.ok(saved["openai-codex"].expires > Date.now());
  assert.equal(saved.deepseek.key, "concurrent-key");
  assert.equal(saved.unrelated.key, "preserved");
  assert.equal(statSync(authPath).mode & 0o777, 0o600);
  assert.equal((await (await loadModels({}, authPath)).getAuth("openai-codex"))?.auth.apiKey, refreshed.access);
  assert.equal(requests, 1);
});

test("failed OAuth refresh preserves the saved credential and rejects auth instead of using a stale token", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yewholt-oauth-error-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json");
  const content = JSON.stringify({ "openai-codex": oauthCredential(Date.now() - 1) });
  writeFileSync(authPath, content, { mode: 0o600 });
  const models = await loadModels({}, authPath);
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
  await assert.rejects(models.getAuth("openai-codex"), /OAuth refresh failed/);
  assert.equal(readFileSync(authPath, "utf8"), content);
});

test("malformed saved OAuth credentials are not advertised", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yewholt-oauth-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ "openai-codex": { type: "oauth" } }), { mode: 0o600 });
  assert.equal((await loadModels({}, authPath)).getProviders().length, 0);
});

test("Anthropic registers an API key and refuses subscription tokens", async () => {
  assert.equal((await loadModels({ ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-subscription" })).getProviders().length, 0);
  assert.equal((await loadModels({ ANTHROPIC_API_KEY: "sk-ant-oat01-subscription" })).getProviders().length, 0);
  assert.equal((await loadModels({ ANTHROPIC_AUTH_TOKEN: "bearer" })).getProviders().length, 0);
  const models = await loadModels({ ANTHROPIC_API_KEY: "sk-ant-api03-test" });
  assert.deepEqual(models.getProviders().map((provider) => provider.id), ["anthropic"]);
});

test("every api-key provider registers from the env vars it asks for", async () => {
  const env: Record<string, string> = {};
  for (const provider of builtinProviders()) {
    const auth = provider.auth.apiKey;
    if (!auth) continue;
    await auth.resolve({
      ctx: {
        env: async (name) => {
          env[name] ??= `value-${name}`;
          return undefined;
        },
        fileExists: async () => false,
      },
      signal: AbortSignal.timeout(2000),
    });
  }
  env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
  env.AWS_SECRET_ACCESS_KEY = "secret";
  const registered = new Set((await loadModels(env)).getProviders().map((provider) => provider.id));
  for (const provider of builtinProviders()) {
    assert.equal(registered.has(provider.id), Boolean(provider.auth.apiKey), provider.id);
  }
  assert.equal(registered.has("openai-codex"), false);
  assert.equal(registered.has("groq"), true);
  assert.equal(registered.has("xai"), true);
  assert.equal(registered.has("mistral"), true);
});

test("the daemon env file is mode 0600 and does not override the shell", () => {
  const home = mkdtempSync(join(tmpdir(), "yewholt-env-"));
  const path = ensureEnvFile(home);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(
    path,
    ["OPENAI_API_KEY=from-file", "GROQ_API_KEY=from-file", "EMPTY=", "# comment", 'export XAI_API_KEY="quoted"', ""].join("\n"),
    { mode: 0o644 },
  );
  const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "from-shell" };
  loadEnvFile(home, env);
  assert.equal(env.OPENAI_API_KEY, "from-shell");
  assert.equal(env.GROQ_API_KEY, "from-file");
  assert.equal(env.XAI_API_KEY, "quoted");
  assert.equal(env.EMPTY, undefined);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  ensureEnvFile(home);
  assert.match(readFileSync(path, "utf8"), /from-file/);
});

test("README and .env.example name every built-in provider and the host env file", () => {
  const readme = readFileSync(readmePath, "utf8");
  const example = readFileSync(examplePath, "utf8");
  assert.match(readme, /~\/\.yewholt\/\.env/);
  assert.match(readme, /0600/);
  assert.match(readme, /opencode\/big-pickle/);
  assert.match(example, /YEWHOLT_MODEL=opencode\/big-pickle/);
  for (const provider of builtinProviders()) {
    assert.ok(readme.includes(`\`${provider.id}\``), provider.id);
    assert.ok(example.includes(provider.id) || provider.id === "openai-codex", provider.id);
  }
  assert.match(readme, /openai-codex/);
  assert.match(example, /openai-codex/);
  for (const name of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENCODE_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "MISTRAL_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "CLOUDFLARE_GATEWAY_ID",
    "HF_TOKEN",
  ]) {
    assert.ok(readme.includes(name), name);
    assert.ok(example.includes(name), name);
  }
});
