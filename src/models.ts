import { defaultProviderAuthContext, InMemoryCredentialStore, type ApiKeyCredential, type CredentialStore } from "@earendil-works/pi-ai";
import { createModels, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { piAuthStorage } from "./pi-internal.js";

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
export function anthropicApiKeyOnly(provider: Provider): Provider {
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

async function hasCredential(provider: Provider, env: Env, credential?: ApiKeyCredential): Promise<boolean> {
  const apiKey = provider.auth.apiKey;
  if (!apiKey) return false;
  const explicitCredentials = envValue(env, "GOOGLE_APPLICATION_CREDENTIALS");
  try {
    const resolved = await apiKey.resolve({
      credential,
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
 * Register built-in providers with usable ambient auth or a saved Pi credential.
 * Use the same credentials for catalog admission and model requests.
 */
export async function loadModels(env: Env = process.env, authPath?: string): Promise<Models> {
  const stored: CredentialStore = authPath ? await piAuthStorage(authPath) : new InMemoryCredentialStore();
  const ambient = new Set<string>();
  const credentials: CredentialStore = {
    read: (id, options) => ambient.has(id) ? Promise.resolve(undefined) : stored.read(id, options),
    list: (options) => stored.list(options),
    modify: (id, fn, options) => stored.modify(id, fn, options),
    delete: (id, options) => stored.delete(id, options),
  };
  const models = createModels({
    credentials,
    authContext: { ...defaultProviderAuthContext(), env: async (name) => envValue(env, name) },
  });
  for (const provider of officialProviders()) {
    const installed = installable(provider);
    if (await hasCredential(installed, env)) {
      ambient.add(installed.id);
    } else {
      const saved = await stored.read(installed.id);
      if (saved?.type === "oauth") {
        if (!installed.auth.oauth || typeof saved.access !== "string" || !saved.access.trim() ||
            typeof saved.refresh !== "string" || !Number.isFinite(saved.expires)) continue;
      } else if (saved?.type !== "api_key" || typeof saved.key !== "string" || !saved.key.trim() ||
          !(await hasCredential(installed, env, saved))) continue;
    }
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
