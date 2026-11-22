import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { pubkeyOf, signEvent } from "./nostr.js";
import { normalizeRelay } from "./relay-url.js";

type Invite = { relayUrl: string; origin: string; code: string };
type JoinOptions = {
  acceptPolicy?: boolean;
  confirmAge?: boolean;
  relayPubkey?: string;
};

function parseInvite(input: string): Invite {
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

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Buzz response");
  }
  return value as Record<string, unknown>;
}

async function claim(invite: Invite, options: JoinOptions, ask: (question: string) => Promise<string>,
  identity: () => string): Promise<void> {
  const { origin, code } = invite;
  const policyResponse = await request(origin, "/api/join-policy");
  if (!policyResponse.ok && policyResponse.status !== 404) {
    throw new Error(`Could not read Buzz join policy (HTTP ${policyResponse.status})`);
  }
  let receipt: string | undefined;
  if (policyResponse.ok) {
    const policyResult = await responseObject(policyResponse);
    if (Object.keys(policyResult).length !== 0) {
      const policy = policyResult.policy as Record<string, unknown> | undefined;
      if (!policy || typeof policy.version !== "string" || !policy.version ||
          typeof policy.terms_markdown !== "string" || typeof policy.age_attestation_required !== "boolean") {
        throw new Error("Invalid Buzz join policy");
      }
      const display = (value: string) => value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
      console.log(`Terms for ${invite.relayUrl}:\n${display(policy.terms_markdown)}`);
      if (typeof policy.privacy_markdown === "string") console.log(`Privacy policy:\n${display(policy.privacy_markdown)}`);
      if (!options.acceptPolicy && await ask("Accept the policy? Type yes to continue: ") !== "yes") {
        throw new Error("Buzz join policy not accepted");
      }
      const ageConfirmed = options.confirmAge || (policy.age_attestation_required &&
        await ask("Do you meet the policy's minimum age? Type yes to confirm: ") === "yes");
      if (policy.age_attestation_required && !ageConfirmed) throw new Error("Minimum age not confirmed");
      const response = await request(origin, "/api/invites/accept-policy", JSON.stringify({
        code, policy_version: policy.version, age_confirmed: ageConfirmed,
      }));
      if (!response.ok) throw new Error(`Buzz did not accept the join policy (HTTP ${response.status})`);
      const result = await responseObject(response);
      if (typeof result.receipt !== "string" || !result.receipt) throw new Error("Invalid Buzz policy receipt");
      receipt = result.receipt;
    }
  }
  const secret = identity();
  const path = "/api/invites/claim";
  const body = JSON.stringify({ code, policy_receipt: receipt });
  const event = signEvent(secret, 27235, "", [
    ["u", origin + path], ["method", "POST"], ["payload", createHash("sha256").update(body).digest("hex")],
    ["nonce", randomUUID()],
  ]);
  const auth = `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
  const response = await request(origin, path, body, auth);
  const result = await responseObject(response);
  if (!response.ok) {
    const reason = ["invite_expired", "invite_exhausted", "invite_invalid", "invite_restricted",
      "join_policy_required", "join_policy_not_accepted"].find((reason) => reason === result.error);
    throw new Error(`Buzz invite claim failed (${reason ?? `HTTP ${response.status}`})`);
  }
  if (result.status !== "joined" && result.status !== "already_member") {
    throw new Error("Buzz did not confirm membership");
  }
  console.log(`${result.status === "joined" ? "Joined" : "Already a member of"} ${invite.relayUrl} as ${pubkeyOf(secret)}`);
}

export async function joinRelay(args: string[], prepare: (relayUrl: string, options: JoinOptions) => {
  identity: () => string; finish?: () => void;
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
    let value: string | undefined = positionals[0];
    if (value === undefined) {
      if (terminal) value = await ask("Paste Buzz invite URL: ");
      else {
        const line = await input()[Symbol.asyncIterator]().next();
        value = line.value;
        reader?.close();
      }
    }
    const invite = parseInvite(value ?? "");
    const options = {
      acceptPolicy: values["accept-policy"], confirmAge: values["confirm-age"], relayPubkey: values["relay-pubkey"],
    };
    const { identity, finish } = prepare(invite.relayUrl, options);
    await claim(invite, options, async (question) => (await ask(question)).toLowerCase(), identity);
    finish?.();
  } finally {
    reader?.close();
  }
}
