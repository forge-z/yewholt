#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { linkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { record, writePrivateJson } from "../src/control-files.js";
import { controlEvent, isModelReference, isPubkey } from "../src/control-protocol.js";
import { parseModelLabel } from "../src/models.js";
import { generateKeyPair, verifyAuthSignature } from "../src/nostr.js";
import { sameRelay } from "../src/relay-url.js";
import { targetIds } from "./install.js";
import { sendControl, waitForConfirmation, type RelayWait } from "./relay.js";
import { ProviderSecrets } from "./secrets.js";
import { recordOutcome } from "./status.js";
import { InvalidTargetRelay, loadTarget, privateJson, providerHome, relayUrl, targetRelays, validId, type Target } from "./target.js";
import { runWake } from "./wake.js";

type Binding = {
  target: string; relay: string; daemon: string; community: string;
  reservation: string; name: string; picture?: string; code: boolean; model?: string;
  secret?: string; authTag?: string[]; removed?: true;
};
const fail = (error: string) => ({ ok: false as const, error });
const ok = { ok: true as const };
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const base = () => join(providerHome(), "hosted");
const agentPath = (pubkey: string) => join(base(), "agents", pubkey + ".json");
const reservationPath = (id: string) => join(base(), "pending", id + ".json");

function read<T>(path: string): T | undefined {
  try { return privateJson(path) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function removeFile(path: string): void {
  try { unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function release(binding: Binding, pubkey: string): void {
  const path = reservationPath(binding.reservation);
  if (read<string>(path) === pubkey) removeFile(path);
}

function provision(input: Record<string, unknown>, community: string) {
  const { target: id, name, picture, code, model } = input;
  if (!validId(id) || typeof name !== "string" || !name.trim() || name.length > 120 ||
      /[\x00-\x1f\x7f]/.test(name) || (model !== undefined && !isModelReference(model)) || (picture !== undefined &&
        (typeof picture !== "string" || picture.length > 2048 || !picture.startsWith("https://")))) {
    return fail("Invalid Yewholt target or agent profile");
  }
  const target = loadTarget(id);
  if (target.transport !== "relay") return fail("Select a Yewholt relay target");
  const relay = targetRelays(target).find((url) => sameRelay(url, community));
  if (!relay) {
    return fail(`Buzz is open to ${community}, but target ${id} uses ${targetRelays(target).join(", ")}. Open the target relay as a Buzz community, then create the agent there.`);
  }
  const reservation = sha([id, relay, target.daemonPubkey, community, name]);
  const path = reservationPath(reservation);
  const existing = () => {
    const pubkey = read<string>(path);
    if (!pubkey) return;
    if (!isPubkey(pubkey)) throw new Error("Invalid hosted reservation");
    const binding = read<Binding>(agentPath(pubkey));
    if (!binding || binding.removed) throw new Error("Invalid hosted reservation");
    return { ...ok, pubkey, picture: binding.picture };
  };
  const previous = existing();
  if (previous) return previous;
  const { pubkey, secret } = generateKeyPair();
  const pending = reservationPath(randomUUID());
  writePrivateJson(agentPath(pubkey), { target: id, relay, daemon: target.daemonPubkey,
    community, reservation, name, picture, code: code === true, model, secret } satisfies Binding);
  try {
    writePrivateJson(pending, pubkey);
    linkSync(pending, path);
  } catch (error) {
    removeFile(agentPath(pubkey));
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return existing() ?? fail("Retry Yewholt provisioning");
    throw error;
  } finally {
    removeFile(pending);
  }
  return { ...ok, pubkey, picture };
}

async function modelCatalog(target: Extract<Target, { transport: "relay" }>, secret: string, wait: RelayWait) {
  const models: string[] = [];
  const deadline = Date.now() + 15_000;
  for (let pages = 0, offset = 0; pages < 12 && Date.now() < deadline; pages++) {
    const requestId = randomUUID();
    const event = controlEvent(secret, target.daemonPubkey, "hosted-models",
      { requestId, agentPubkey: target.daemonPubkey }, { offset, relay: target.relay });
    let catalog: unknown;
    const result = await wait(target, secret, event, requestId, target.daemonPubkey,
      Math.max(1, deadline - Date.now()), (body) => { catalog = body.catalog; });
    if (result !== "confirmed" || !record(catalog) || !Array.isArray(catalog.models) ||
        !catalog.models.every(isModelReference)) break;
    models.push(...catalog.models);
    if (catalog.next === undefined) return { ...ok, models };
    if (!catalog.models.length || catalog.next !== offset + catalog.models.length) break;
    offset = catalog.next;
  }
  return fail("Could not load models from the daemon. Check that it is updated, online and paired, then retry.");
}

export async function bridge(input: unknown, wait: RelayWait = waitForConfirmation) {
  try {
    if (!record(input)) return fail("Invalid Yewholt request");
    if (input.op === "targets") {
      const relays = Object.fromEntries(targetIds().flatMap((id) => {
        const target = loadTarget(id);
        return target.transport === "relay" ? [[id, target.relays ? targetRelays(target) : target.relay] as const] : [];
      }));
      return { ...ok, targets: Object.keys(relays), ...(input.details === true && { relays }) };
    }
    if (input.op === "models") {
      if (!validId(input.target)) return fail("Select a Yewholt relay target");
      const target = loadTarget(input.target);
      if (target.transport !== "relay") return fail("Select a Yewholt relay target");
      const community = input.community;
      const relay = community === undefined ? target.relay : relayUrl(community) &&
        targetRelays(target).find((url) => sameRelay(url, community));
      if (!relay) return fail("The selected Yewholt target does not serve this Buzz community");
      return await modelCatalog({ ...target, relay }, new ProviderSecrets().identity(), wait);
    }
    const { op, community, pubkey } = input;
    if (!relayUrl(community)) return fail("Invalid Buzz community");
    if (op === "provision") return provision(input, community);
    if ((op !== "activate" && op !== "profile" && op !== "remove" && op !== "model") || !isPubkey(pubkey)) {
      return fail("Invalid Yewholt request");
    }
    const path = agentPath(pubkey);
    const binding = read<Binding>(path);
    if (!binding || !sameRelay(binding.community, community)) return fail("This Mac has no Yewholt binding for this agent");
    const remove = () => {
      release(binding, pubkey);
      writePrivateJson(path, { ...binding, secret: undefined, removed: true });
      return ok;
    };
    if (binding.removed) return op === "remove" ? ok : fail("Yewholt agent was removed");
    if (op === "remove" && !binding.authTag) return remove();

    const configured = loadTarget(binding.target);
    const relay = targetRelays(configured).find((url) => sameRelay(url, binding.relay));
    if (!relay || configured.daemonPubkey !== binding.daemon) {
      return fail("Restore the original Yewholt target before managing this agent");
    }
    const target = { ...configured, relay };
    let authTag = binding.authTag;
    if (op === "activate") {
      if (!Array.isArray(input.auth) || !input.auth.every((item) => typeof item === "string") ||
          input.auth[2] !== "" || !verifyAuthSignature(input.auth, pubkey) ||
          (authTag && authTag[1] !== input.auth[1])) return fail("Invalid Buzz owner authorization");
      authTag ??= input.auth;
      if (!binding.secret) {
        release(binding, pubkey);
        return ok;
      }
      // Persist the proof before sending so an interrupted activation can still be removed.
      writePrivateJson(path, { ...binding, authTag });
    }
    if (!authTag) return fail("Activate the Yewholt agent before editing it");
    const owner = authTag[1]!;
    const context = { community: binding.community, owner, authTag };
    const secrets = new ProviderSecrets();
    const secret = secrets.identity();
    const wake = (config: Parameters<typeof runWake>[0], requestId: string, timeout: number) =>
      runWake(config, requestId, timeout, (account) => secrets.instabox(account));
    if (op === "model") {
      const model = input.model;
      if (model !== undefined && !isModelReference(model)) return fail("Invalid Yewholt model");
      const requestId = randomUUID();
      let current: unknown;
      let refusal: unknown;
      const confirm = (body: Record<string, unknown>) => {
        current = body.model;
        refusal = body.error;
      };
      if (model === undefined) {
        const event = controlEvent(secret, target.daemonPubkey, "hosted-model", { requestId, agentPubkey: pubkey }, context);
        const result = await wait(target, secret, event, requestId, pubkey, 15_000, confirm);
        if (result !== "confirmed" || (current !== null && !isModelReference(current))) {
          return fail("Could not read the agent's model. Check that the daemon is updated, online and paired, then retry.");
        }
        const catalog = await modelCatalog(target, secret, wait);
        return catalog.ok ? { ...catalog, model: current } : catalog;
      }
      const result = await sendControl(target, secret, "hosted-model", requestId, pubkey, { ...context, model }, {
        wait: (target, secret, event, requestId, agent, ms) => wait(target, secret, event, requestId, agent, ms, confirm),
        wake,
      });
      if (result.result === "confirmed" && isModelReference(current)) return { ...ok, model: current };
      if (refusal === "selected model is not available on the daemon") return fail("The selected model is no longer available on the daemon.");
      return fail(result.result === "refused" ? "The daemon refused the model change. Reopen this tab and try again."
        : "The daemon did not confirm the model change. Reopen this tab to check the current model.");
    }
    const body = op === "activate" ? { ...context, name: binding.name, picture: binding.picture, agent: {
      name: binding.name, nsec: binding.secret, authTag, permissions: ["post", "read", ...(binding.code ? ["code"] : [])],
      respondTo: "allowlist", respondToAllowlist: [owner],
      model: binding.model ? parseModelLabel(binding.model) : undefined,
    } } : op === "profile" ? { ...context, name: input.name, picture: input.picture } : context;
    const result = await sendControl(target, secret, `hosted-${op}`, randomUUID(), pubkey, body, { wait, wake });
    if (result.result !== "confirmed") {
      recordOutcome(binding.target, target, { failure: result.result === "refused" ? "refused" : result.wakeFailed ? "wake" : "timeout" });
      return fail(result.result === "refused" ? "Yewholt operation refused by the relay or daemon"
        : result.wakeFailed ? "Wake failed and no daemon confirmation was received" : "No daemon confirmation received");
    }
    if (op === "remove") return remove();
    if (read<Binding>(path)?.removed) return fail("Yewholt agent was removed");
    if (op === "activate") {
      writePrivateJson(path, { ...binding, authTag, secret: undefined });
      release(binding, pubkey);
      recordOutcome(binding.target, target, { pubkey });
    }
    return ok;
  } catch (error) {
    return fail(error instanceof InvalidTargetRelay ? error.message
      : "Yewholt operation failed; check the provider installation and target");
  }
}

async function main() {
  const finish = (result: Awaited<ReturnType<typeof bridge>>) => {
    process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(result.ok ? 0 : 1));
  };
  let size = 0;
  const chunks: Buffer[] = [];
  const stdinDeadline = setTimeout(() => finish(fail("Input timed out")), 8_000);
  let input: unknown;
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 16 * 1024) throw new Error("Input too large");
      chunks.push(chunk);
    }
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return finish(fail("Expected one JSON request"));
  } finally {
    clearTimeout(stdinDeadline);
  }
  const deadline = setTimeout(() => finish(fail("Yewholt operation timed out")), 530_000);
  const result = await bridge(input);
  clearTimeout(deadline);
  finish(result);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
