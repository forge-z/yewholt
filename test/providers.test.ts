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
    "openai-codex": { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 3_600_000 },
  }), { mode: 0o600 });
  const session = await Yewholt.open(new MemoryStorage(), { home: join(dir, "state"), piDir: dir });
  try {
    assert.ok(session.availableModelReferences().includes("deepseek/deepseek-flash"));
    assert.equal(session.availableModelReferences().some((model) => model.startsWith("openai-codex/")), false);
  } finally {
    await session.close();
  }
  const models = await loadModels({}, authPath);
  assert.equal((await models.getAuth("deepseek"))?.auth.apiKey, "pi-test-key");
  assert.equal(models.getProvider("openai-codex"), undefined);

  const overridden = await loadModels({ DEEPSEEK_API_KEY: "env-test-key" }, authPath);
  assert.equal((await overridden.getAuth("deepseek"))?.auth.apiKey, "env-test-key");
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
