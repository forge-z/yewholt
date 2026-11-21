import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateJson } from "../src/control-files.js";
import { generateKeyPair, pubkeyOf } from "../src/nostr.js";
import { privateJson, providerHome, validId } from "./target.js";

const service = "yewholt-provider";
const warnFallback = () => process.stderr.write("Yewholt provider: Keychain unavailable; using private file storage.\n");

function keychainRead(account: string): string | undefined {
  const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
    encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 ? result.stdout.trimEnd() : undefined;
}

function keychainCreate(account: string, generated: string): string | undefined {
  // Interactive stdin keeps the generated secret out of process arguments.
  spawnSync("/usr/bin/security", ["-i"], {
    input: `add-generic-password -s ${service} -a ${account} -w ${generated}\n`,
    timeout: 5_000, stdio: ["pipe", "pipe", "pipe"],
  });
  return keychainRead(account);
}

function fileRead(path: string): string | undefined {
  try {
    const value = privateJson(path);
    if (typeof value !== "string" || !value || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid stored secret");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Invalid private secret storage");
  }
}

function fileCreate(path: string, value: string): string {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const staged = join(dir, `.${randomUUID()}.json`);
  writePrivateJson(staged, value);
  try {
    try {
      linkSync(staged, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return fileRead(path)!;
  } finally {
    unlinkSync(staged);
  }
}

export class ProviderSecrets {
  constructor(private readonly home = providerHome(),
    private readonly useKeychain = process.platform === "darwin" && process.env.YEWHOLT_PROVIDER_FILE_STORAGE !== "1") {}

  private get(account: string, generate?: () => string): string | undefined {
    const path = join(this.home, "secrets", account + ".json");
    const existing = this.useKeychain ? keychainRead(account) : undefined;
    if (existing !== undefined) return existing;
    const fallback = fileRead(path);
    if (fallback !== undefined) {
      warnFallback();
      return fallback;
    }
    const value = generate?.();
    if (value !== undefined && this.useKeychain) {
      const stored = keychainCreate(account, value);
      if (stored !== undefined) return stored;
    }
    warnFallback();
    return value === undefined ? undefined : fileCreate(path, value);
  }

  identity(create = true): string {
    const value = this.get("identity", create ? () => generateKeyPair().secret : undefined);
    if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid provider identity");
    pubkeyOf(value);
    return value;
  }

  instabox(accountId: string): string {
    if (!validId(accountId)) throw new Error("Invalid InstaBox account");
    const value = this.get("instabox-" + accountId);
    if (!value || /[^!-~]/.test(value)) throw new Error("InstaBox token unavailable");
    return value;
  }
}
