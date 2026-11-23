import { lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomic, writePrivateJson } from "../src/control-files.js";
import { sameRelay } from "../src/relay-url.js";
import { loadTarget, providerHome, targetFile, targetRelays, validId } from "./target.js";
import { runtimeBridge, runtimeHome } from "./runtime-paths.js";

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

/** Drop a relay from every target; a target left without relays is removed. Returns one line per change. */
export function removeRelayFromTargets(relay: string, home = providerHome()): string[] {
  const changes: string[] = [];
  for (const id of targetIds(home)) {
    let target;
    try {
      target = loadTarget(id, home);
    } catch {
      continue;
    }
    const relays = targetRelays(target);
    const kept = relays.filter((url) => !sameRelay(url, relay));
    if (kept.length === relays.length) continue;
    if (!kept.length) {
      unlinkSync(targetFile(id, home));
      changes.push(`Removed target ${id}; it had no other relay.`);
      continue;
    }
    const [first, ...additional] = kept;
    const { relays: _old, ...rest } = target;
    writePrivateJson(targetFile(id, home), { id, ...rest, relay: first, ...(additional.length && { relays: additional }) });
    changes.push(`Removed ${relay} from target ${id}.`);
  }
  return changes;
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
  const cached = dirname(join(runtimeHome(), "current", runtimeBridge));
  install(join(providerBin(), "yewholt-buzz-bridge"), [
    "export YEWHOLT_PROVIDER_HOME=" + quote(resolve(providerHome())),
    'if cached=$(CDPATH= cd -P ' + quote(cached) + ' 2>/dev/null && pwd) && [ -f "$cached/bridge.js" ]; then',
    '  exec ' + quote(process.execPath) + ' "$cached/bridge.js" "$@"',
    'fi',
    "exec " + [process.execPath, bridge].map(quote).join(" ") + ' "$@"',
  ]);
  const plugin = join(resolve(providerHome()), "buzz-plugin");
  for (const name of ["manifest.json", "plugin.js"]) {
    const source = new URL("../../buzz-plugin/" + name, import.meta.url);
    writeAtomic(join(plugin, name), readFileSync(source, "utf8"), 0o600);
  }
  return plugin;
}
