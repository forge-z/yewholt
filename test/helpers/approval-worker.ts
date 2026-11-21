/**
 * Child process for test/approval-kill9.test.ts. Modes:
 * - `park <dir>`: create a code bot, ask it to run a dangerous command, wait until the
 *   call is parked and the request is stored, write `parked`, then hang until killed.
 * - `approve <dir>`: reopen the same SQLite file, re-attach to the unfinished turn,
 *   answer `aprovo`, wait for the turn's reply, write `result.json`, exit 0.
 * - `idle <dir>`: reopen and re-attach again; nothing must run.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { workspaceDir } from "../../src/workspace.js";
import { chatFrom, createBot, human, openSession, reconcileHome, testWorkspaces, waitUntil } from "./coding.js";

export const DANGEROUS = "mkdir -p junk && rm -rf junk && echo ran >> ran.txt";

async function main(mode: string, dir: string): Promise<void> {
  const home = join(dir, "home");
  const piDir = join(dir, "pi");
  mkdirSync(home, { recursive: true });
  mkdirSync(piDir, { recursive: true });
  if (!existsSync(join(piDir, "settings.json"))) writeFileSync(join(piDir, "settings.json"), "{}\n");
  const session = await openSession(await openNodeSqliteStorage(join(dir, "sessions.sqlite")), home, piDir);
  if (mode === "park") {
    const coder = await createBot(session, "Coder", "post,read,code");
    void session.handleHuman(human("k1", `@Coder run: ${DANGEROUS}`)).catch(() => undefined);
    const approvals = await waitUntil(async () => {
      const list = (await session.snapshot()).approvals ?? [];
      return list.length > 0 && list;
    }, "the approval request");
    // Let the park commit land too; a kill before it is also fine (the gate reruns on reopen).
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(join(dir, "parked"), JSON.stringify({ workspace: workspaceDir(testWorkspaces(home), coder.pubkey), approvals }));
    setInterval(() => undefined, 1000);
    return;
  }
  await reconcileHome(session);
  const resumed = session.resumeTurns();
  if (mode === "approve") {
    await waitUntil(async () => ((await session.snapshot()).approvals ?? []).length > 0, "the stored approval after reopen");
    await session.handleHuman(human("k2", "aprovo"));
  }
  await resumed;
  const state = await session.snapshot();
  const coder = state.bots.find((bot) => bot.name === "Coder")!;
  writeFileSync(
    join(dir, `${mode}.json`),
    JSON.stringify({ replies: chatFrom(state, coder.pubkey), approvals: state.approvals ?? [], turns: state.turns ?? [] }),
  );
  await session.close();
}

const [mode, dir] = process.argv.slice(2);
if (!mode || !dir) {
  console.error("usage: approval-worker park|approve|idle <directory>");
  process.exit(2);
}
main(mode, dir).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
