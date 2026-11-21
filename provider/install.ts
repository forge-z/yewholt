import { lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomic } from "../src/control-files.js";
import { providerHome, validId } from "./target.js";

const marker = "#!/bin/sh\n# Managed by yewholt\n";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

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

/** Deletes the executables older releases installed for Buzz executable discovery. */
export function removeLegacyEntries(): void {
  let entries: string[];
  try {
    entries = readdirSync(providerBin());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry !== "yewholt-provider-engine" && !entry.startsWith("buzz-backend-yewholt-")) continue;
    const path = join(providerBin(), entry);
    try {
      if (managed(path)) unlinkSync(path);
    } catch {
      // Not ours; leave it.
    }
  }
}

export function installProvider(): string {
  removeLegacyEntries();
  const bridge = fileURLToPath(new URL("./bridge.js", import.meta.url));
  install(join(providerBin(), "yewholt-buzz-bridge"), [
    "export YEWHOLT_PROVIDER_HOME=" + quote(resolve(providerHome())),
    "exec " + [process.execPath, bridge].map(quote).join(" ") + ' "$@"',
  ]);
  const plugin = join(resolve(providerHome()), "buzz-plugin");
  for (const name of ["manifest.json", "plugin.js"]) {
    const source = new URL("../../buzz-plugin/" + name, import.meta.url);
    writeAtomic(join(plugin, name), readFileSync(source, "utf8"), 0o600);
  }
  return plugin;
}
