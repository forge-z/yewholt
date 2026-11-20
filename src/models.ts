import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

export type ModelChoice = {
  provider: string;
  modelId: string;
  label: string;
};

/**
 * Register pi-ai providers only when an API key is present.
 * Subscription OAuth (Claude Code, Codex) is intentionally not wired.
 */
export function loadModels(): Models {
  const models = createModels();
  if (process.env.OPENAI_API_KEY) models.setProvider(openaiProvider());
  if (process.env.ANTHROPIC_API_KEY) models.setProvider(anthropicProvider());
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) models.setProvider(googleProvider());
  if (process.env.OPENROUTER_API_KEY) models.setProvider(openrouterProvider());
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
