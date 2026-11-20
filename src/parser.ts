export type ParsedCommand =
  | { type: "approve" }
  | { type: "reject" }
  | { type: "help" }
  | {
      type: "create";
      name: string | null;
      modelLabel: string | null;
      scope: string | null;
      permissions: string[] | null;
    }
  | { type: "update-model"; name: string; modelLabel: string }
  | { type: "update-scope"; name: string; scope: string }
  | { type: "update-permissions"; name: string; permissions: string[] }
  | { type: "stop"; name: string }
  | { type: "start"; name: string };

/**
 * Commands the Onboarding Specialist handles without a model.
 * Free text returns null so the daemon can hand it to pi-ai when a key is set.
 */
export function parseCommand(input: string): ParsedCommand | null {
  const text = input.trim();
  if (!text) return { type: "help" };
  if (/^(approve|approved|aprovo|aprovado|yes|sim)\b/i.test(text)) return { type: "approve" };
  if (/^(reject|rejected|rejeito|no|não|nao|cancel|cancele)\b/i.test(text)) return { type: "reject" };
  if (/^(help|\?|ajuda)$/i.test(text)) return { type: "help" };

  const stop = text.match(/^(?:stop bot|pare o bot)\s+(.+)$/i);
  if (stop) return { type: "stop", name: stop[1]!.trim() };
  const start = text.match(/^(?:start bot|inicie o bot|iniciar o bot)\s+(.+)$/i);
  if (start) return { type: "start", name: start[1]!.trim() };

  const modelEn = text.match(/^(?:change|set) model of (.+?) to (.+)$/i);
  if (modelEn) return { type: "update-model", name: modelEn[1]!.trim(), modelLabel: modelEn[2]!.trim() };
  const modelPt = text.match(/^mude o modelo de (.+?) para (.+)$/i);
  if (modelPt) return { type: "update-model", name: modelPt[1]!.trim(), modelLabel: modelPt[2]!.trim() };

  const scopeEn = text.match(/^(?:change|set) scope of (.+?) to (.+)$/i);
  if (scopeEn) return { type: "update-scope", name: scopeEn[1]!.trim(), scope: scopeEn[2]!.trim() };
  const scopePt = text.match(/^mude o escopo de (.+?) para (.+)$/i);
  if (scopePt) return { type: "update-scope", name: scopePt[1]!.trim(), scope: scopePt[2]!.trim() };

  const permEn = text.match(/^(?:change|set) permissions of (.+?) to (.+)$/i);
  if (permEn) return { type: "update-permissions", name: permEn[1]!.trim(), permissions: splitPermissions(permEn[2]!) };

  if (/^(?:create|crie)\b/i.test(text) || /\bnovo bot\b/i.test(text)) {
    return {
      type: "create",
      name: field(text, "name") ?? named(text),
      modelLabel: modelPhrase(text),
      scope: field(text, "scope"),
      permissions: field(text, "permissions") ? splitPermissions(field(text, "permissions")!) : null,
    };
  }
  return null;
}

function field(text: string, key: string): string | null {
  const match = text.match(new RegExp(`\\b${key}\\s*[:=]\\s*([^\\n]+?)(?=\\s+\\w+\\s*[:=]|$)`, "i"));
  return match ? match[1]!.trim() : null;
}

function named(text: string): string | null {
  const match = text.match(/\b(?:named|chamado|chamada)\s+(.+?)(?=\s+e\s|\s+com\s|\s+model[o]?\b|$)/i);
  return match ? match[1]!.trim() : null;
}

function modelPhrase(text: string): string | null {
  const explicit = field(text, "model") ?? field(text, "modelo");
  if (explicit) return explicit;
  const pt = text.match(/coloque\s+o\s+(.+?)\s+como\s+modelo/i);
  if (pt) return pt[1]!.trim();
  const en = text.match(/\bmodel\s+(.+?)(?=\s+scope\b|\s+permissions\b|$)/i);
  return en ? en[1]!.trim() : null;
}

export function splitPermissions(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => /^[a-z0-9_-]+$/.test(part));
}

export function helpText(): string {
  return [
    "Onboarding Specialist. I create bots after you approve a summary in this channel.",
    "Create: crie um novo bot e coloque o GPT-6.2 Astra como modelo",
    "Or: create bot name: Alpha model: openai/gpt-6-sol scope: this permissions: post,read",
    "Then reply approve (or sim / aprovo). reject discards the proposal.",
    "Change: change model of Alpha to openai/gpt-6-sol",
    "Scope: change scope of Alpha to this",
    "Permissions: change permissions of Alpha to post,read",
    "Stop or start: stop bot Alpha / start bot Alpha",
    "Each bot is one durable session with its own Nostr key, model, scope, and token budget.",
  ].join("\n");
}
