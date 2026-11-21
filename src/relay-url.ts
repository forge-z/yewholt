export function normalizeRelay(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\s\x00-\x1f\x7f\\?#]/.test(value)) return;
  const scheme = /^(wss?|https?):\/\/(?:\[[^\]]+\]|[^/:@%]+)(?::\d+)?(?:\/|$)/i.exec(value)?.[1];
  if (!scheme) return;
  const relay = scheme.toLowerCase().replace(/^http/, "ws") + value.slice(scheme.length);
  try {
    const { hostname } = new URL(relay);
    if (hostname.startsWith("[") || hostname.replace(/\.$/, "").split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return relay;
  } catch {
    return;
  }
}
