import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { record } from "../src/control-files.js";
import { requestWake } from "../src/wake.js";
import type { Wake } from "./target.js";

type Api = typeof fetch;
type Delay = (ms: number, signal: AbortSignal) => Promise<void>;
const base = "https://api.instabox.sh";

async function wakeInstabox(
  machineId: string, token: string, requestId: string, signal: AbortSignal, fetchApi: Api, delay: Delay,
): Promise<void> {
  async function request(path: string, method = "GET"): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { "X-API-Key": token };
    if (method === "POST") headers["Idempotency-Key"] = "yewholt-" + requestId;
    const response = await fetchApi(base + path, { method, headers, signal, redirect: "error" });
    if (!response.ok) throw new Error("InstaBox request failed");
    const data: unknown = await response.json();
    if (!record(data)) throw new Error("Invalid InstaBox response");
    return data;
  }

  const path = "/v1/machines/" + encodeURIComponent(machineId);
  const machine = await request(path);
  if (machine.state === "running") return;
  let operationId = machine.operationId;
  if (!operationId && (machine.state === "suspended" || machine.state === "stopped")) {
    const action = machine.state === "suspended" ? "resume" : "start";
    const operation = await request(path + "/" + action, "POST");
    operationId = operation.id;
  }
  if (typeof operationId !== "string" || !/^op_[a-zA-Z0-9_-]+$/.test(operationId)) {
    throw new Error("InstaBox machine not ready");
  }
  for (;;) {
    const operation = await request("/v1/operations/" + encodeURIComponent(operationId) + "?wait=10");
    if (operation.state === "succeeded") return;
    if (operation.state !== "queued" && operation.state !== "running") throw new Error("InstaBox wake failed");
    await delay(500, signal);
  }
}

export async function runWake(
  wake: Wake, requestId: string, timeoutMs: number, token: (accountId: string) => string,
  fetchApi: Api = fetch, delay: Delay = (ms, signal) => sleep(ms, undefined, { signal }),
): Promise<void> {
  if (wake.kind === "url") {
    if (!await requestWake(wake.url, fetchApi, timeoutMs)) throw new Error("Wake URL did not answer");
    return;
  }
  if (wake.kind === "command") {
    return new Promise((resolve, reject) => {
      const command = spawn("/bin/sh", ["-c", wake.cmd], { stdio: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" });
      command.once("error", () => reject(new Error("Wake command failed")));
      command.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Wake command failed")));
    });
  }
  await wakeInstabox(wake.machineId, token(wake.accountId), requestId, AbortSignal.timeout(timeoutMs), fetchApi, delay);
}
