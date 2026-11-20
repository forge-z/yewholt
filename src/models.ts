import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export type ModelChoice = {
  provider: string;
  modelId: string;
  label: string;
};

type Env = Record<string, string | undefined>;

/**
 * Official pi-ai providers (`builtinProviders()`), the same catalog pi-bot
 * registers in `src/native-providers.ts`. Cached because each call rebuilds
 * every provider.
 */
let cached: Provider[] | undefined;
function officialProviders(): Provider[] {
  cached ??= builtinProviders();
  return cached;
}

/**
 * Anthropic stays on the API-key route. pi-ai also ships Claude Pro/Max
 * OAuth; this daemon does not collect that login. A key that is itself an
 * OAuth access token (`sk-ant-oat`) is refused. Mirrors pi-bot
 * `anthropicApiKeyProvider`.
 */
function anthropicApiKeyOnly(provider: Provider): Provider {
  const apiKey = provider.auth.apiKey;
  if (!apiKey) return provider;
  return {
    ...provider,
    auth: {
      apiKey: {
        ...apiKey,
        resolve: async (input) => {
          const key = input.credential?.key ?? (await input.ctx.env("ANTHROPIC_API_KEY"));
          input.signal.throwIfAborted();
          if (!key || key.includes("sk-ant-oat")) return undefined;
          return apiKey.resolve({
            ctx: {
              env: async (name: string) => (name === "ANTHROPIC_API_KEY" ? key : undefined),
              fileExists: async () => false,
            },
            credential: { type: "api_key", key },
            signal: input.signal,
          });
        },
      },
    },
  };
}

function installable(provider: Provider): Provider {
  return provider.id === "anthropic" ? anthropicApiKeyOnly(provider) : provider;
}

function envValue(env: Env, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** True when the provider's own api-key resolver accepts this env. OAuth-only providers do not. */
async function hasEnvCredential(provider: Provider, env: Env): Promise<boolean> {
  const apiKey = provider.auth.apiKey;
  if (!apiKey) return false;
  const explicitCredentials = envValue(env, "GOOGLE_APPLICATION_CREDENTIALS");
  try {
    const resolved = await apiKey.resolve({
      ctx: {
        env: async (name) => envValue(env, name),
        fileExists: async (path) => {
          if (!explicitCredentials || path !== explicitCredentials) return false;
          const { accessSync } = await import("node:fs");
          try {
            accessSync(explicitCredentials);
            return true;
          } catch {
            return false;
          }
        },
      },
      signal: AbortSignal.timeout(2000),
    });
    return resolved !== undefined;
  } catch {
    return false;
  }
}

/**
 * Register every built-in pi-ai provider whose env credential resolves.
 * Nothing is required: with an empty env the catalog is empty and chat
 * commands still run. `env` is the only place keys are read; `process.env`
 * is not consulted unless the caller passes it.
 */
export async function loadModels(env: Env = process.env): Promise<Models> {
  const models = createModels();
  for (const provider of officialProviders()) {
    const installed = installable(provider);
    if (!(await hasEnvCredential(installed, env))) continue;
    models.setProvider(installed);
  }
  return models;
}

/** Map a chat label onto a pi-ai provider/model id. `provider/modelId` wins. */
export function parseModelLabel(label: string): ModelChoice {
  const trimmed = label.trim();
  const explicit = trimmed.match(/^([a-z0-9_-]+)\/([^\s]+)$/i);
  if (explicit) {
    return { provider: explicit[1]!.toLowerCase(), modelId: explicit[2]!, label: trimmed };
  }
  const lower = trimmed.toLowerCase();
  let provider = "openai";
  if (lower.includes("claude")) provider = "anthropic";
  else if (lower.includes("gemini")) provider = "google";
  else if (lower.includes("openrouter")) provider = "openrouter";
  const modelId = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return { provider, modelId, label: trimmed };
}

export function defaultModel(): ModelChoice | null {
  const raw = process.env.YEWHOLT_MODEL?.trim();
  if (!raw) return null;
  return parseModelLabel(raw);
}

export function catalogHas(models: Models, choice: ModelChoice): boolean {
  return models.getModel(choice.provider, choice.modelId) !== undefined;
}
