import { validateAgent, type AgentProvisioning } from "../src/agents.js";
import { record } from "../src/control-files.js";
import { isPubkey } from "../src/control-protocol.js";
import { pubkeyOf } from "../src/nostr.js";
import { relayUrl } from "./target.js";

const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

export function decodeNsec(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid agent identity");
  if (/^[a-fA-F0-9]{64}$/.test(value)) return value.toLowerCase();
  if (value.length !== 63 || (value !== value.toLowerCase() && value !== value.toUpperCase()) ||
      !value.toLowerCase().startsWith("nsec1")) throw new Error("Invalid agent identity");
  const words = [...value.toLowerCase().slice(5)].map((symbol) => alphabet.indexOf(symbol));
  if (words.includes(-1)) throw new Error("Invalid agent identity");
  let checksum = 1;
  for (const word of [3, 3, 3, 3, 0, 14, 19, 5, 3, ...words]) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ word;
    for (const [index, generator] of generators.entries()) if ((top >>> index) & 1) checksum ^= generator;
  }
  if (checksum !== 1 || (words[51] & 15) !== 0) throw new Error("Invalid agent identity");
  const bytes: number[] = [];
  let accumulator = 0, bits = 0;
  for (const word of words.slice(0, 52)) {
    accumulator = (accumulator << 5) | word;
    bits += 5;
    if (bits >= 8) bytes.push((accumulator >>> (bits -= 8)) & 255);
  }
  return Buffer.from(bytes).toString("hex");
}

type Provisioning = Omit<AgentProvisioning, "ownerPubkey" | "pubkey" | "model"> & {
  model?: AgentProvisioning["model"];
};

export function provisioning(value: unknown): { pubkey: string; file: Provisioning } {
  if (!record(value)) throw new Error("Invalid agent package");
  const nsec = decodeNsec(value.private_key_nsec);
  const pubkey = pubkeyOf(nsec);
  const authTag: unknown = typeof value.auth_tag === "string" ? JSON.parse(value.auth_tag) : value.auth_tag;
  if (!relayUrl(value.relay_url)) throw new Error("Invalid agent relay");
  const rawModel = value.model, rawProvider = value.provider;
  const optionalNonempty = (field: unknown) => field == null || typeof field === "string" && !!field.trim();
  if (!optionalNonempty(rawModel) || !optionalNonempty(rawProvider)) throw new Error("Invalid agent model");
  const model = typeof rawModel === "string" && typeof rawProvider === "string"
    ? { provider: rawProvider, modelId: rawModel, label: rawModel } : undefined;
  if ((rawModel == null) !== (rawProvider == null)) throw new Error("Incomplete agent model");
  const respondTo = value.respond_to;
  const allowlist = value.respond_to_allowlist ?? [];
  if ((respondTo !== "anyone" && respondTo !== "owner-only" && respondTo !== "allowlist") ||
      !Array.isArray(allowlist) || !allowlist.every(isPubkey) || (respondTo === "allowlist" && !allowlist.length)) {
    throw new Error("Invalid agent access policy");
  }
  if (value.env_vars !== undefined &&
      (!record(value.env_vars) || !Object.values(value.env_vars).every((v) => typeof v === "string"))) {
    throw new Error("Invalid agent environment");
  }
  const launch = value.launch;
  if (launch !== undefined && !record(launch)) throw new Error("Invalid launch metadata");
  const owner = launch?.owner_pubkey;
  const defaults = { relayUrl: value.relay_url, model: { provider: "", modelId: "", label: "" } };
  const agent = validateAgent({
    name: value.name, nsec, authTag, relayUrl: value.relay_url, model,
    permissions: ["post", "read", "code"], respondTo, respondToAllowlist: allowlist,
  }, pubkey, defaults);
  if (!("nsec" in agent) || (owner != null && owner !== agent.ownerPubkey)) throw new Error("Invalid agent provisioning");
  if (typeof value.private_key_nsec === "string" && value.private_key_nsec.toLowerCase().startsWith("nsec1") &&
      [agent.name, agent.relayUrl, ...Object.values(agent.model), ...agent.authTag]
        .some((field) => field.toLowerCase().includes((value.private_key_nsec as string).toLowerCase()))) {
    throw new Error("Invalid agent provisioning");
  }
  return {
    pubkey,
    file: {
      name: agent.name, nsec, authTag: agent.authTag, relayUrl: agent.relayUrl, model, permissions: agent.permissions,
      respondTo: respondTo === "owner-only" ? "allowlist" : respondTo,
      respondToAllowlist: respondTo === "owner-only" ? [agent.ownerPubkey] : allowlist,
    },
  };
}
