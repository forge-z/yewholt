#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { record } from "../src/control-files.js";
import { controlEvent, isRequestId } from "../src/control-protocol.js";
import { deployLocal } from "./local.js";
import { provisioning } from "./package.js";
import { waitForConfirmation, type RelayWait } from "./relay.js";
import { ProviderSecrets } from "./secrets.js";
import { recordOutcome } from "./status.js";
import { loadTarget, validId, type Wake } from "./target.js";
import { runWake } from "./wake.js";

const WINDOW_MS = 120_000;
const info = {
  ok: true as const,
  name: "Yewholt",
  version: "0.1.0",
  protocol_version: 1,
  description: "Deploy an agent to a configured Yewholt target.",
  config_schema: { type: "object", properties: {} },
};

type Services = {
  loadTarget: typeof loadTarget;
  identity: () => string;
  wait: RelayWait;
  wake: (config: Wake, requestId: string, timeoutMs: number) => Promise<void>;
  local: typeof deployLocal;
  report: typeof recordOutcome;
};

const fail = (error: string) => ({ ok: false as const, error });

export async function handle(targetId: unknown, input: unknown, overrides?: Partial<Services>) {
  if (!record(input) || !isRequestId(input.request_id)) return fail("Invalid request");
  if (!validId(targetId)) return fail("Invalid target id");
  if (input.op === "info") {
    const label = process.env.YEWHOLT_PROVIDER_DISPLAY_NAME;
    return label && label.length <= 120 && !/[\x00-\x1f\x7f]/.test(label) ? { ...info, name: label } : info;
  }
  if (input.op !== "deploy") return fail("Unsupported operation");
  if (!record(input.provider_config) || Object.keys(input.provider_config).length !== 0) return fail("Invalid provider configuration");
  const { request_id: requestId } = input;
  const secrets = new ProviderSecrets();
  const services: Services = {
    loadTarget, identity: () => secrets.identity(), wait: waitForConfirmation,
    wake: (config, id, timeout) => runWake(config, id, timeout, (account) => secrets.instabox(account)),
    local: deployLocal, report: recordOutcome, ...overrides,
  };
  let target, agent;
  try {
    target = services.loadTarget(targetId);
  } catch {
    return fail("Invalid or missing target configuration");
  }
  try {
    agent = provisioning(input.agent);
  } catch {
    services.report(targetId, target, { failure: "package" });
    return fail("Invalid agent provisioning package");
  }
  const success = { ok: true as const, agent_id: agent.pubkey };
  try {
    if (target.transport === "local") {
      services.local(requestId, agent.pubkey, agent.file);
      services.report(targetId, target, { pubkey: agent.pubkey });
      return success;
    }
    const secret = services.identity();
    const event = controlEvent(secret, target.daemonPubkey, "deploy", { requestId, agentPubkey: agent.pubkey }, agent.file);
    const wait = () => services.wait(target, secret, event, requestId, agent.pubkey, WINDOW_MS);
    let result = await wait();
    let wakeFailed = false;
    if (result === "timeout") {
      if (target.wake) {
        try {
          await services.wake(target.wake, requestId, WINDOW_MS);
        } catch {
          wakeFailed = true;
        }
      }
      result = await wait();
    }
    if (result === "confirmed") {
      services.report(targetId, target, { pubkey: agent.pubkey });
      return success;
    }
    if (result === "refused") {
      services.report(targetId, target, { failure: "refused" });
      return fail("Deploy refused by the relay or daemon");
    }
    services.report(targetId, target, { failure: wakeFailed ? "wake" : "timeout" });
    return fail(wakeFailed ? "Wake failed and no daemon confirmation was received" : "No daemon confirmation received");
  } catch {
    services.report(targetId, target, { failure: "deploy" });
    return fail("Deploy failed");
  }
}

async function main(): Promise<void> {
  let finished = false;
  function finish(result: Awaited<ReturnType<typeof handle>>): void {
    if (finished) return;
    finished = true;
    process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(result.ok ? 0 : 1));
  }
  const inputTimer = setTimeout(() => finish(fail("Input timed out")), 8_000);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let input: unknown;
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new Error("Input too large");
      chunks.push(chunk);
    }
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    finish(fail("Expected one JSON request"));
    return;
  } finally {
    clearTimeout(inputTimer);
  }
  const deadline = setTimeout(() => finish(fail("Deploy timed out")), 530_000);
  const result = process.argv.length === 3 ? await handle(process.argv[2], input) : fail("Expected one target id");
  clearTimeout(deadline);
  finish(result);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
