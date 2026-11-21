import { lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomic } from "../src/control-files.js";
import { loadTarget, providerHome, validId, type Target } from "./target.js";

const marker = "#!/bin/sh\n# Managed by yewholt\n";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const entryName = "yewholt-provider-engine";

export function providerBin(): string {
  return resolve(process.env.YEWHOLT_PROVIDER_BIN_DIR ?? join(homedir(), ".local", "bin"));
}

export function discoverableId(id: string): boolean {
  return validId(id) && id === id.toLowerCase();
}

export function targetIds(home = providerHome()): string[] {
  try {
    return readdirSync(join(home, "targets")).filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -5)).filter(discoverableId).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function entryPath(): string {
  return join(providerBin(), entryName);
}

export function shimPath(id: string): string {
  if (!discoverableId(id)) throw new Error("Invalid target id");
  return join(providerBin(), "buzz-backend-yewholt-" + id);
}

function managed(path: string): boolean {
  const meta = lstatSync(path, { throwIfNoEntry: false });
  if (!meta) return false;
  if (!meta.isFile() || meta.size > 16_384 || !readFileSync(path, "utf8").startsWith(marker)) {
    throw new Error("Not a managed provider entry");
  }
  return true;
}

function install(path: string, lines: string[]): void {
  const payload = marker + lines.join("\n") + "\n";
  if (managed(path) && readFileSync(path, "utf8") === payload && (lstatSync(path).mode & 0o777) === 0o700) return;
  writeAtomic(path, payload, 0o700);
}

export function installEngine(): void {
  const engine = fileURLToPath(new URL("./engine.js", import.meta.url));
  install(entryPath(), [
    "export YEWHOLT_PROVIDER_HOME=" + quote(resolve(providerHome())),
    "exec " + [process.execPath, engine].map(quote).join(" ") + ' "$@"',
  ]);
}

export function installShim(id: string, target: Target): void {
  install(shimPath(id), [
    "export YEWHOLT_PROVIDER_DISPLAY_NAME=" + quote(target.label),
    "exec " + [entryPath(), id].map(quote).join(" "),
  ]);
}

export function verifyShim(id: string): void {
  managed(shimPath(id));
}

export function removeShim(id: string): void {
  if (managed(shimPath(id))) unlinkSync(shimPath(id));
}

export function installProvider(): void {
  const targets = targetIds().map((id) => ({ id, target: loadTarget(id) }));
  targets.forEach(({ id }) => verifyShim(id));
  installEngine();
  targets.forEach(({ id, target }) => installShim(id, target));
}
