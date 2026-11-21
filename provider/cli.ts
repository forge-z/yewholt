import { unlinkSync } from "node:fs";
import { parseArgs } from "node:util";
import { writePrivateJson } from "../src/control-files.js";
import { pubkeyOf } from "../src/nostr.js";
import { discoverableId, installEngine, installProvider, installShim, removeShim, verifyShim } from "./install.js";
import { ProviderSecrets } from "./secrets.js";
import { targetFile, validateTarget } from "./target.js";
import { doctorTargets, listTargets } from "./status.js";

class CliError extends Error {}

function printPairing(): void {
  const pubkey = pubkeyOf(new ProviderSecrets().identity());
  console.log("Provider pubkey: " + pubkey);
  console.log("Admit this pubkey to the relay, then run on the target daemon:");
  console.log('  yewholt pair add ' + pubkey + ' --label "My Mac"');
}

function parseTarget(id: string, args: string[]) {
  const usage = "Usage: targets add <id> (--relay <url> --daemon <pubkey> | --local) [--label <label>] " +
    "[--wake command --cmd <command> | --wake instabox --account <id> --machine <id>]";
  if (!discoverableId(id)) throw new CliError("Invalid target id (use lowercase letters, numbers, hyphens or underscores)");
  let values;
  try {
    const parsed = parseArgs({
      args, options: {
        relay: { type: "string", multiple: true }, daemon: { type: "string", multiple: true },
        label: { type: "string", multiple: true }, local: { type: "boolean", multiple: true },
        wake: { type: "string", multiple: true }, cmd: { type: "string", multiple: true },
        account: { type: "string", multiple: true }, machine: { type: "string", multiple: true },
      },
    });
    values = parsed.values;
    if (Object.values(values).some((entry) => entry.length > 1)) throw new Error();
  } catch {
    throw new CliError(usage);
  }
  const label = values.label?.[0] ?? "Yewholt " + id;
  if (/[\x00-\x1f\x7f]/.test(label) || label.length > 120) throw new CliError("Invalid target label");
  const kind = values.wake?.[0], cmd = values.cmd?.[0], accountId = values.account?.[0], machineId = values.machine?.[0];
  let wake;
  if (kind === "command" && cmd && !accountId && !machineId) wake = { kind, cmd };
  else if (kind === "instabox" && accountId && machineId && !cmd) wake = { kind, accountId, machineId };
  else if (kind !== undefined || cmd !== undefined || accountId !== undefined || machineId !== undefined) throw new CliError(usage);
  if (values.local && (values.relay || values.daemon || wake)) throw new CliError(usage);
  const raw = values.local ? { id, label, transport: "local" } : {
    id, label, transport: "relay", relay: values.relay?.[0], daemonPubkey: values.daemon?.[0], wake,
  };
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) >= 32 * 1024) throw new Error();
    return { raw, target: validateTarget(id, raw) };
  } catch {
    throw new CliError("Invalid target configuration (check relay URL, daemon pubkey and wake options)");
  }
}

export async function providerCommand(command: "provider" | "targets" | "pair", args: string[]): Promise<void> {
  try {
    if (command === "pair") return printPairing();
    if (command === "provider") {
      if (args.length !== 1 || args[0] !== "install") throw new CliError("Usage: yewholt provider install");
      installProvider();
      return printPairing();
    }
    const [sub, id, ...rest] = args;
    if (sub === "add") {
      const { raw, target } = parseTarget(id, rest);
      verifyShim(id);
      installEngine();
      writePrivateJson(targetFile(id), raw);
      installShim(id, target);
      console.log("Configured target " + id);
    } else if (sub === "list" && args.length === 1) {
      listTargets();
    } else if (sub === "remove" && args.length === 2 && discoverableId(id)) {
      removeShim(id);
      try {
        unlinkSync(targetFile(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      console.log("Removed target " + id + "; running agents were not changed.");
    } else if (sub === "doctor" && (args.length === 1 || args.length === 2 && discoverableId(id))) {
      await doctorTargets(id);
    } else {
      throw new CliError("Usage: yewholt targets add <id> [options] | list | remove <id> | doctor [id]");
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new Error("Provider operation failed; check target files, credentials and managed entry permissions.");
  }
}
