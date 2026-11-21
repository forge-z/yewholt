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

  const permissionChange = text.match(/^(?:(?:change|set) permiss(?:ions|[õo]es) of (.+?) to|mude (?:as )?permiss[õo]es de (.+?) para)\s+(.+)$/i);
  if (permissionChange) {
    const raw = permissionChange[3]!;
    return { type: "update-permissions", name: (permissionChange[1] ?? permissionChange[2]!).trim(), permissions: splitPermissions(field(raw, PERMISSIONS) ?? raw) };
  }
  const permissionField = text.match(/^(?:change bot|set bot|mude o bot)\s+(.+?)\s+permiss(?:ions|[õo]es)\s*[:=]\s*(.+)$/i);
  if (permissionField) {
    return { type: "update-permissions", name: permissionField[1]!.trim(), permissions: splitPermissions(permissionField[2]!) };
  }

  if (/^(?:create|crie)\b/i.test(text) || /\bnovo bot\b/i.test(text)) {
    const permissions = field(text, PERMISSIONS);
    return {
      type: "create",
      name: field(text, "name") ?? named(text),
      modelLabel: modelPhrase(text),
      scope: field(text, "scope"),
      permissions: permissions ? splitPermissions(permissions) : CODE_PHRASE.test(text) ? ["post", "read", "code"] : null,
    };
  }
  return null;
}

const PERMISSIONS = "permiss(?:ions|[õo]es)";
const CODE_PHRASE = /\b(?:e\s+)?com\s+permiss[ãa]o\s+(?:code|de\s+c[óo]digo)\b/i;
const FIELD_END = `\\s+(?:[\\p{L}\\p{N}_]+\\s*[:=]|${CODE_PHRASE.source})|$`;

function field(text: string, key: string): string | null {
  const match = text.match(new RegExp(`\\b${key}\\s*[:=]\\s*([^\\n]+?)(?=${FIELD_END})`, "iu"));
  return match ? match[1]!.trim() : null;
}

function named(text: string): string | null {
  const match = text.match(/\b(?:named|chamado|chamada)\s+(.+?)(?=\s+e\s|\s+com\s|\s+usando\s|\s+using\s|\s+with\s|\s+model[o]?\b|\s+permiss(?:ions|[õo]es)\s*[:=]|$)/i);
  return match ? match[1]!.trim() : null;
}

function modelPhrase(text: string): string | null {
  const explicit = field(text, "model") ?? field(text, "modelo");
  if (explicit) return explicit;
  const pt = text.match(/coloque\s+o\s+(.+?)\s+como\s+modelo/i);
  if (pt) return pt[1]!.trim();
  // "com o modelo X", "com modelo X", "usando o modelo X", "with model X", "using model X".
  const phrase = text.match(/\b(?:com(?:\s+o)?|usando(?:\s+o)?|with|using)\s+(?:the\s+)?modelo?\s+(.+?)(?=\s+(?:scope|escopo|permissions|permiss[õo]es)\b|\s+\w+\s*[:=]|\s+(?:e\s+)?com\s+permiss[ãa]o\b|$)/i);
  if (phrase) return phrase[1]!.trim().replace(/[.,;!?]+$/, "") || null;
  const en = text.match(/\bmodel\s+(.+?)(?=\s+scope\b|\s+permiss(?:ions|[õo]es)\b|\s+(?:e\s+)?com\s+permiss[ãa]o\b|$)/i);
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

/**
 * Strip leading `@<display name>` mentions of known bots ("@Onboarding Specialist  aprovo").
 * Names may contain spaces; the longest name wins; matching is case-insensitive and the
 * name must end at a space, `,`/`:` or the end of the text. Returns the rest of the text
 * and the canonical names that were stripped, in order.
 */
export function stripLeadingMentions(input: string, names: readonly string[]): { text: string; mentioned: string[] } {
  const known = [...new Set(names.filter((name) => name.trim()))].sort((a, b) => b.length - a.length);
  let text = input.trim();
  const mentioned: string[] = [];
  for (;;) {
    if (!text.startsWith("@")) break;
    const name = known.find((candidate) => new RegExp(`^@${escapeRegExp(candidate)}(?=$|[\\s,:])`, "i").test(text));
    if (!name) break;
    mentioned.push(name);
    text = text.slice(1 + name.length).replace(/^[\s,:]+/, "");
  }
  return { text, mentioned };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
