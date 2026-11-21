/** Commands that drive the Buzz daemon. Their behaviour is unchanged by the harness. */
export const DAEMON_COMMANDS = ["install", "start", "stop", "status", "admin", "daemon", "pair", "agents"] as const;
export type DaemonCommand = (typeof DAEMON_COMMANDS)[number];

export type Route =
  | { kind: "harness"; args: string[] }
  | { kind: "command"; command: DaemonCommand; args: string[] }
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
  yewholt                        Open the pi coding harness in the current directory
  yewholt code [args...]         Forward every argument to the harness unchanged
                                 (yewholt code --help shows the harness flags)

  yewholt install [--home dir] [--port 3000]
  yewholt start [--home dir]
  yewholt stop [--home dir]
  yewholt status [--home dir]
  yewholt admin keys|bots|channel [--home dir]
  yewholt admin budget <name> <tokens> [--home dir]
  yewholt pair add <providerPubkey> --label <label> [--home dir]
  yewholt pair list [--home dir]
  yewholt pair remove <providerPubkey> [--home dir]
  yewholt agents list [--home dir]
  yewholt help                   Show this message
`;
}
