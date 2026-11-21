/**
 * Run the pi coding agent through its public `main()` export, the function the
 * `pi` bin calls. Settings, pi packages, extensions, skills, themes and sessions
 * load from `~/.pi/agent` exactly as they do for `pi`.
 *
 * The import is dynamic so the daemon commands never load the harness.
 */
export async function runHarness(args: string[]): Promise<void> {
  // Same process setup as the pi bin (`dist/cli/setup.js`). `main()` configures
  // the HTTP dispatcher itself once settings are loaded.
  process.env.PI_CODING_AGENT = "true";
  process.env.AI_AGENT = "pi";
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  const { main } = await import("@earendil-works/pi-coding-agent");
  await main(args);
}
