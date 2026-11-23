import { unlinkSync } from "node:fs";
import { parseArgs } from "node:util";
import { writePrivateJson } from "../src/control-files.js";
import { pubkeyOf } from "../src/nostr.js";
import { configuredRelays, loadConfig } from "../src/config.js";
import { readKey } from "../src/keys.js";
import { ownerKeyPath, yewholtHome } from "../src/paths.js";
import { addPairing } from "../src/pairing.js";
import { joinRelay } from "../src/relay-join.js";
import { discoverableId, installProvider } from "./install.js";
import { namedRelayMembers, publishProviderProfile } from "./relay.js";
import { ProviderSecrets } from "./secrets.js";
import { InvalidTargetRelay, targetFile, validateTarget } from "./target.js";
import { normalizeRelay } from "../src/relay-url.js";
import { doctorTargets, listTargets } from "./status.js";

class CliError extends Error {}

function printPairing(): void {
  const pubkey = pubkeyOf(new ProviderSecrets().identity());
  console.log("Provider pubkey: " + pubkey);
  console.log("Admit this pubkey to the relay, then run on the target daemon:");
  console.log('  yewholt pair add ' + pubkey + ' --label "My Mac"');
  console.log("For an additional daemon relay, append --relay <url>.");
}

function parseTarget(id: string, args: string[]) {
  const usage = "Usage: targets add <id> (--relay <url> [--relay <url> ...] --daemon <pubkey> | --local [--home <path>]) [--label <label>] " +
    "[--wake command --cmd <command> | --wake instabox --account <id> --machine <id> | --wake url --url <url>]";
  if (!discoverableId(id)) throw new CliError("Invalid target id (use lowercase letters, numbers, hyphens or underscores)");
  let values;
  try {
    const parsed = parseArgs({
      args, options: {
        relay: { type: "string", multiple: true }, daemon: { type: "string", multiple: true },
        label: { type: "string", multiple: true },
        local: { type: "boolean", multiple: true }, home: { type: "string", multiple: true },
        wake: { type: "string", multiple: true }, cmd: { type: "string", multiple: true }, url: { type: "string", multiple: true },
        account: { type: "string", multiple: true }, machine: { type: "string", multiple: true },
      },
    });
    values = parsed.values;
    if (Object.entries(values).some(([key, entry]) => key !== "relay" && entry.length > 1)) throw new Error();
  } catch {
    throw new CliError(usage);
  }
  const label = values.label?.[0] ?? "Yewholt " + id;
  if (/[\x00-\x1f\x7f]/.test(label) || label.length > 120) throw new CliError("Invalid target label");
  const kind = values.wake?.[0], cmd = values.cmd?.[0], accountId = values.account?.[0], machineId = values.machine?.[0];
  const url = values.url?.[0];
  let wake;
  if (kind === "command" && cmd && !accountId && !machineId && !url) wake = { kind, cmd };
  else if (kind === "instabox" && accountId && machineId && !cmd && !url) wake = { kind, accountId, machineId };
  else if (kind === "url" && url && !cmd && !accountId && !machineId) wake = { kind, url };
  else if (kind !== undefined || cmd !== undefined || accountId !== undefined || machineId !== undefined || url !== undefined) throw new CliError(usage);
  if ((values.local && (values.relay || values.daemon || wake)) || (values.home && !values.local)) throw new CliError(usage);
  const home = values.local ? yewholtHome(values.home?.[0]) : undefined;
  let relays = values.relay ?? [], daemonPubkey = values.daemon?.[0];
  if (home !== undefined) {
    try {
      relays = configuredRelays(loadConfig(home)).map(({ relayUrl }) => relayUrl);
      daemonPubkey = pubkeyOf(readKey(ownerKeyPath(home)));
    } catch {
      throw new CliError('Local daemon home is not installed or is invalid. Run yh install --home ' + JSON.stringify(home) + ' --relay <url> --relay-pubkey <pubkey> first.');
    }
  }
  const [relay, ...additional] = relays;
  const raw = { id, label, transport: "relay", relay, ...(additional.length && { relays: additional }), daemonPubkey, wake };
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) >= 32 * 1024) throw new Error();
    return { target: validateTarget(id, raw), home };
  } catch (error) {
    if (error instanceof InvalidTargetRelay) throw error;
    throw new CliError("Invalid target configuration (check relay URL, daemon pubkey and wake options)");
  }
}

export async function providerCommand(command: "provider" | "targets" | "pair", args: string[]): Promise<void> {
  if (command === "provider" && args[0] === "join") {
    return joinRelay(args.slice(1), (relay) => {
      const identity = () => new ProviderSecrets().identity();
      return { identity, finish: async () => {
        try {
          await publishProviderProfile(relay, identity());
        } catch {
          console.error("Provider joined, but its profile was not updated. Retry with yh provider profile " + relay);
        }
      } };
    });
  }
  if (command === "provider" && (args[0] === "profile" || args[0] === "members")) {
    const relay = args.length === 2 && normalizeRelay(args[1]);
    if (!relay) throw new CliError("Usage: yh provider " + args[0] + " <relay-url>");
    const secret = new ProviderSecrets().identity(false);
    if (args[0] === "members") console.log(JSON.stringify(await namedRelayMembers(relay, secret), null, 2));
    else {
      await publishProviderProfile(relay, secret);
      console.log("Provider profile is up to date.");
    }
    return;
  }
  try {
    if (command === "pair") return printPairing();
    if (command === "provider") {
      if (args.length !== 1 || args[0] !== "install") throw new CliError("Usage: yewholt provider install | join [<invite-url>] | profile <relay-url> | members <relay-url>");
      const plugin = installProvider();
      console.log("Buzz plugin folder: " + plugin);
      return printPairing();
    }
    const [sub, id, ...rest] = args;
    if (sub === "add") {
      const { target, home } = parseTarget(id, rest);
      if (home !== undefined) {
        const provider = pubkeyOf(new ProviderSecrets().identity());
        addPairing(home, provider, target.label);
        for (const relay of target.relays ?? []) addPairing(home, provider, target.label, undefined, relay);
        console.log("Paired provider " + provider + "; the daemon reads pairings live (no restart needed).");
        console.log("Relay administrator: admit the daemon and provider pubkeys if not already admitted:");
        console.log("  buzz-admin add-member --pubkey " + target.daemonPubkey);
        console.log("  buzz-admin add-member --pubkey " + provider);
        console.log("Daemon pubkey: " + target.daemonPubkey);
        console.log("Provider pubkey: " + provider);
      }
      writePrivateJson(targetFile(id), { id, ...target });
      console.log("Configured target " + id);
    } else if (sub === "list" && args.length === 1) {
      listTargets();
    } else if (sub === "remove" && args.length === 2 && discoverableId(id)) {
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
    if (error instanceof CliError || error instanceof InvalidTargetRelay) throw error;
    throw new Error("Provider operation failed; check target files, credentials and managed entry permissions.");
  }
}
