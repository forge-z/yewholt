import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { pubkeyOf, signEvent } from "./nostr.js";
import { normalizeRelay } from "./relay-url.js";

export type Invite = { relayUrl: string; origin: string; code: string };
export type JoinOptions = {
  acceptPolicy?: boolean;
  confirmAge?: boolean;
  relayPubkey?: string;
};

export function parseInvite(input: string): Invite {
  const invalid = () => new Error("Invalid Buzz invite URL");
  const value = input.trim();
  if (value.length > 4096 || /[\s\x00-\x1f\x7f\\]/.test(value)) throw invalid();
  let origin: string | undefined;
  let code: string | undefined;
  if (/^buzz:\/\/join\/?\?/.test(value)) {
    const url = new URL(value);
    const relays = url.searchParams.getAll("relay");
    const codes = url.searchParams.getAll("code");
    if (url.hash || relays.length !== 1 || codes.length !== 1) throw invalid();
    origin = relays[0];
    code = codes[0];
  } else {
    const match = /^(https:\/\/[^/]+)\/invite\/([a-zA-Z0-9._-]+)\/?$/.exec(value);
    origin = match?.[1];
    code = match?.[2];
  }
  const relay = origin && /^(https|wss):\/\/[^/]+\/?$/.test(origin) ? normalizeRelay(origin) : undefined;
  if (!relay?.startsWith("wss://") || !code || !/^[a-zA-Z0-9._-]{1,256}$/.test(code) ||
      code === "." || code === "..") throw invalid();
  const url = new URL(relay);
  if (url.pathname !== "/") throw invalid();
  const host = url.host;
  return { relayUrl: `wss://${host}`, origin: `https://${host}`, code };
}

async function request(origin: string, path: string, body?: string, auth?: string): Promise<Response> {
  try {
    return await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "identity",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(auth === undefined ? {} : { Authorization: auth }),
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Buzz request failed: ${path}`);
  }
}

async function responseObject(
  response: Response, action: string, secrets: (string | undefined)[],
): Promise<Record<string, unknown>> {
  const body = await (async () => {
    const bytes = Buffer.from(await response.arrayBuffer());
    return (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
  })().catch(() => "");
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    value = undefined;
  }
  const object = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const status = `HTTP ${response.status}`;
  if (!response.ok) {
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    const message = [object?.error, object?.message, value, !type || type === "text/plain" ? body : undefined]
      .find((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
    let detail = message ?? "";
    for (const secret of secrets) if (secret) detail = detail.replaceAll(secret, "[redacted]");
    detail = detail.replace(/[\x00-\x20\x7f-\x9f]+/g, " ").trim().slice(0, 300);
    throw new Error(`${action} (${status})${detail ? `: ${detail}` : ""}`);
  }
  if (!object) throw new Error(`${action} (${status}): expected a JSON object`);
  return object;
}

export type Consent = { receipt?: string; acceptPolicy: boolean; confirmAge: boolean };

export async function consentToPolicy(invite: Invite, options: JoinOptions,
  ask: (question: string) => Promise<string>): Promise<Consent> {
  const { origin, code } = invite;
  const policyResponse = await request(origin, "/api/join-policy");
  let receipt: string | undefined;
  let acceptPolicy = options.acceptPolicy === true;
  let confirmAge = options.confirmAge === true;
  if (policyResponse.status !== 404) {
    const policyResult = await responseObject(policyResponse, "Could not read Buzz join policy", [code]);
    if (Object.keys(policyResult).length !== 0) {
      const policy = policyResult.policy as Record<string, unknown> | undefined;
      if (!policy || typeof policy.version !== "string" || !policy.version ||
          typeof policy.terms_markdown !== "string" || typeof policy.age_attestation_required !== "boolean") {
        throw new Error(`Invalid Buzz join policy (HTTP ${policyResponse.status})`);
      }
      const display = (value: string) => value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
      if (process.env.YH_SHOW_TERMS === "1") {
        console.log(`Terms for ${invite.relayUrl}:\n${display(policy.terms_markdown)}`);
        if (typeof policy.privacy_markdown === "string") console.log(`Privacy policy:\n${display(policy.privacy_markdown)}`);
      } else {
        const bytes = Buffer.byteLength(policy.terms_markdown) +
          (typeof policy.privacy_markdown === "string" ? Buffer.byteLength(policy.privacy_markdown) : 0);
        console.log(`Policy for ${invite.relayUrl}: ${Math.ceil(bytes / 1024)} KB of terms and privacy text; rerun with YH_SHOW_TERMS=1 to review.`);
      }
      if (!options.acceptPolicy && await ask("Accept the policy? Type yes to continue: ") !== "yes") {
        throw new Error("Buzz join policy not accepted");
      }
      acceptPolicy = true;
      const ageConfirmed = options.confirmAge || (policy.age_attestation_required &&
        await ask("Do you meet the policy's minimum age? Type yes to confirm: ") === "yes");
      if (policy.age_attestation_required && !ageConfirmed) throw new Error("Minimum age not confirmed");
      confirmAge = ageConfirmed === true;
      const response = await request(origin, "/api/invites/accept-policy", JSON.stringify({
        code, policy_version: policy.version, age_confirmed: ageConfirmed,
      }));
      const result = await responseObject(response, "Buzz did not accept the join policy", [code]);
      if (typeof result.receipt !== "string" || !result.receipt) {
        throw new Error(`Invalid Buzz policy receipt (HTTP ${response.status})`);
      }
      receipt = result.receipt;
    }
  }
  return { receipt, acceptPolicy, confirmAge };
}

export async function claimInvite(invite: Invite, { receipt }: Consent, secret: string): Promise<"joined" | "already_member"> {
  const { origin, code } = invite;
  const path = "/api/invites/claim";
  const body = JSON.stringify({ code, policy_receipt: receipt });
  const event = signEvent(secret, 27235, "", [
    ["u", origin + path], ["method", "POST"], ["payload", createHash("sha256").update(body).digest("hex")],
    ["nonce", randomUUID()],
  ]);
  const auth = `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
  const response = await request(origin, path, body, auth);
  const result = await responseObject(response, "Buzz invite claim failed", [code, receipt, auth.slice("Nostr ".length)]);
  if (result.status !== "joined" && result.status !== "already_member") {
    throw new Error(`Buzz did not confirm membership (HTTP ${response.status})`);
  }
  console.log(`${result.status === "joined" ? "Joined" : "Already a member of"} ${invite.relayUrl} as ${pubkeyOf(secret)}`);
  return result.status;
}

export async function joinRelay(args: string[], prepare: (relayUrl: string, options: JoinOptions) => {
  identity: () => string; finish?: () => void | Promise<void>;
}, daemon = false): Promise<void> {
  const usage = `Usage: yh ${daemon ? "relay" : "provider"} join [<invite-url>]${daemon ? " [--relay-pubkey <pubkey>]" : ""} [--accept-policy] [--confirm-age]`;
  const { values, positionals } = (() => {
    try {
      return parseArgs({
        args, allowPositionals: true, options: {
          "accept-policy": { type: "boolean" }, "confirm-age": { type: "boolean" },
          "relay-pubkey": { type: "string" },
        },
      });
    } catch {
      throw new Error(usage);
    }
  })();
  if (positionals.length > 1 || (!daemon && values["relay-pubkey"] !== undefined)) throw new Error(usage);
  await withInviteInput(positionals[0], async (invite, ask) => {
    const options = {
      acceptPolicy: values["accept-policy"], confirmAge: values["confirm-age"], relayPubkey: values["relay-pubkey"],
    };
    const { identity, finish } = prepare(invite.relayUrl, options);
    const consent = await consentToPolicy(invite, options, ask);
    await claimInvite(invite, consent, identity());
    await finish?.();
  });
}

export async function withInviteInput<T>(value: string | undefined,
  run: (invite: Invite, ask: (question: string) => Promise<string>) => Promise<T>): Promise<T> {
  let reader: ReturnType<typeof createInterface> | undefined;
  const terminal = process.stdin.isTTY === true;
  const input = () => reader ??= createInterface({ input: process.stdin, output: process.stderr, terminal });
  const ask = async (question: string) => {
    if (!terminal) throw new Error("Explicit consent required: use a terminal or pass --accept-policy and, when required, --confirm-age");
    const rl = input();
    const abort = new AbortController();
    const onClose = () => abort.abort();
    rl.once("close", onClose);
    try {
      return (await rl.question(question, { signal: abort.signal })).trim();
    } catch {
      throw new Error("Buzz join input closed");
    } finally {
      rl.off("close", onClose);
    }
  };
  try {
    if (value === undefined) {
      if (terminal) value = await ask("Paste Buzz invite URL: ");
      else {
        const line = await input()[Symbol.asyncIterator]().next();
        value = line.value;
        reader?.close();
      }
    }
    const invite = parseInvite(value ?? "");
    return await run(invite, async (question) => (await ask(question)).toLowerCase());
  } finally {
    reader?.close();
  }
}
