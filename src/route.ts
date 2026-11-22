/** Commands that drive the Buzz daemon. Their behaviour is unchanged by the harness. */
export const DAEMON_COMMANDS = ["install", "update", "start", "stop", "status", "admin", "daemon", "pair", "agents", "relay"] as const;
export type DaemonCommand = (typeof DAEMON_COMMANDS)[number];
const PROVIDER_COMMANDS = ["provider", "targets"] as const;
type ProviderCommand = (typeof PROVIDER_COMMANDS)[number];

export type Route =
  | { kind: "harness"; args: string[] }
  | { kind: "command"; command: DaemonCommand | ProviderCommand; args: string[] }
  | { kind: "usage"; exitCode: 0 | 1 };

/** Positional subcommands of the pi CLI. They take no `--model`. */
const PI_SUBCOMMANDS = new Set(["install", "uninstall", "remove", "update", "list", "config", "auth", "mcp"]);

/**
 * Decide what `yewholt <argv>` does. Pure: no env, no I/O.
 * No arguments opens the harness; `code` forwards the rest to it unchanged.
 */
export function route(argv: string[]): Route {
  const [command, ...rest] = argv;
  if (command === undefined) return { kind: "harness", args: [] };
  if (command === "code") return { kind: "harness", args: rest };
  if (command === "help" || command === "--help" || command === "-h") return { kind: "usage", exitCode: 0 };
  if (command === "provider" || command === "targets") return { kind: "command", command, args: rest };
  if ((DAEMON_COMMANDS as readonly string[]).includes(command)) {
    return { kind: "command", command: command as DaemonCommand, args: rest };
  }
  return { kind: "usage", exitCode: 1 };
}

/**
 * Add `--model $YEWHOLT_MODEL` when the user gave no `--model` or `--model=`.
 * Flags typed in the shell always win. Pi subcommands are left alone.
 */
export function withDefaultModel(args: string[], env: Record<string, string | undefined>): string[] {
  const model = env.YEWHOLT_MODEL?.trim();
  if (!model) return args;
  if (args[0] !== undefined && PI_SUBCOMMANDS.has(args[0])) return args;
  const end = args.indexOf("--");
  const flags = end === -1 ? args : args.slice(0, end);
  if (flags.some((arg) => arg === "--model" || arg.startsWith("--model="))) return args;
  return ["--model", model, ...args];
}

export function usageText(): string {
  return `Yewholt: a pi coding harness, and durable agents on Buzz

Usage:
  yewholt                        Open the pi coding harness in the current directory (alias: yh)
  yewholt code [args...]         Forward every argument to the harness unchanged
                                 (yewholt code --help shows the harness flags)

  yewholt install --relay <url> [--relay-pubkey <pubkey>] [--home dir]
                                 Set up the daemon for an existing Buzz relay
  yewholt relay add <url> --relay-pubkey <pubkey> [--home dir]
  yewholt relay join [<invite-url>] [--relay-pubkey <pubkey>] [--accept-policy] [--confirm-age] [--home dir]
  yewholt relay list [--home dir]
  yewholt start [--home dir]
  yewholt update [--home dir] [--archive <tar file>]
                                 Update this checkout, bridge, and running daemon (not the relay)
  yewholt stop [--home dir]
  yewholt status [--home dir]
  yewholt admin keys|bots [--home dir]
  yewholt admin budget <name> <tokens> [--home dir]
  yewholt provider install
  yewholt provider join [<invite-url>] [--accept-policy] [--confirm-age]
  yewholt targets add <id> --relay <url> [--relay <url> ...] --daemon <pubkey> [--label <label>]
  yewholt targets add <id> --local [--home dir] [--label <label>]
    [--wake command --cmd <command> | --wake instabox --account <id> --machine <id>]
  yewholt targets list
  yewholt targets remove <id>
  yewholt targets doctor [id]
  yewholt pair                    Show the provider pubkey and pairing instructions
  yewholt pair add <providerPubkey> --label <label> [--relay <url>] [--home dir]
  yewholt pair list [--relay <url>] [--home dir]
  yewholt pair remove <providerPubkey> [--relay <url>] [--home dir]
  yewholt agents list [--home dir]
  yewholt help                   Show this message
`;
}
