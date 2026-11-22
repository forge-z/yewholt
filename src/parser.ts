/** A person's answer to a pending command approval, or null. */
export function approvalWord(input: string): "approve" | "reject" | null {
  const text = input.trim();
  if (/^(approve|approved|aprovo|aprovado|yes|sim)\b/i.test(text)) return "approve";
  if (/^(reject|rejected|rejeito|no|não|nao|cancel|cancele)\b/i.test(text)) return "reject";
  return null;
}

/**
 * Strip leading `@<display name>` mentions of known bots ("@Coder  aprovo").
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
