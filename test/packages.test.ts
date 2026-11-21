import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type ConversationId } from "@earendil-works/pi-durable";
import { loadPackages } from "../src/packages.js";
import { CHANNEL, chatFrom, createBot, human, openSession, testWorkspaces } from "./helpers/coding.js";

const ctx = BACKGROUND_CONTEXT;

/**
 * A Pi settings folder listing:
 * - `good`: a `pi.durable` entry whose default export adds an extension with a `word_count` tool;
 * - `broken`: a `pi.durable` entry whose setup throws;
 * - `taken`: an extension named `coding-tools`, a name the host reserves;
 * - `pi-only`: a pi coding-agent extension (`(pi) => {}`) and no `pi.durable`: nothing loads, no error;
 * - an `npm:` source, which is not a local folder.
 */
function fixturePiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yewholt-pkgs-"));
  const pkg = (name: string, manifest: object, files: Record<string, string>) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "package.json"), JSON.stringify({ name, private: true, type: "module", ...manifest }));
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, name, file), text);
  };
  pkg("good", { pi: { durable: ["./durable.mjs"] } }, {
    "durable.mjs": `
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
const wordCount = defineTool({
  name: "word_count",
  description: "Count the words in a text",
  parameters: obj({ text: str() }),
  execute: async (args) => ({ output: [{ type: "text", text: args.text.trim().split(/\\s+/).filter(Boolean).length + " words" }] }),
});
export default async () => ({
  extensions: [defineExtension({ name: "fixture-words", tools: [wordCount], sections: [section("house-rules", () => "House rule: count words.")] })],
});
`,
  });
  pkg("broken", { pi: { durable: ["./durable.mjs"] } }, { "durable.mjs": `export default () => { throw new Error("fixture setup failed"); };\n` });
  pkg("taken", { pi: { durable: ["./durable.mjs"] } }, {
    "durable.mjs": `import { defineExtension } from "@earendil-works/pi-durable";\nexport default () => ({ extensions: [defineExtension({ name: "coding-tools" })] });\n`,
  });
  pkg("pi-only", { pi: { extensions: ["./ext.mjs"] } }, { "ext.mjs": `export default (pi) => { globalThis.__yewholtPiOnlyLoaded = true; };\n` });
  writeFileSync(join(dir, "settings.json"), `\uFEFF${JSON.stringify({ packages: ["./good", "./broken", { source: "./taken" }, "./pi-only", "npm:some-package"] })}`);
  return dir;
}

test("packages: pi.durable entries load as Buzz's host does; broken ones are skipped with a reason", async () => {
  const dir = fixturePiDir();
  try {
    const loaded = await loadPackages(dir);
    assert.deepEqual(loaded.extensions.map((extension) => extension.name), ["fixture-words"]);
    assert.deepEqual(loaded.providers, []);
    assert.deepEqual(loaded.errors.map((error) => error.source), ["./broken", "./taken", "npm:some-package"]);
    assert.match(loaded.errors[0]!.error, /fixture setup failed/);
    assert.match(loaded.errors[1]!.error, /coding-tools/);
    assert.match(loaded.errors[2]!.error, /local folder/);
    assert.equal((globalThis as { __yewholtPiOnlyLoaded?: boolean }).__yewholtPiOnlyLoaded, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packages: missing settings load nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yewholt-pkgs-none-"));
  try {
    assert.deepEqual(await loadPackages(dir), { extensions: [], providers: [], errors: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packages: a code bot gets the package's tool, a bot without code does not; one log line per skipped package", async () => {
  const dir = fixturePiDir();
  const home = mkdtempSync(join(tmpdir(), "yewholt-pkgs-home-"));
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  const session = await openSession(new MemoryStorage(), home, dir);
  try {
    await session.ensureOnboarding(CHANNEL);
    const plain = await createBot(session, "Plain", "post,read");
    const coder = await createBot(session, "Coder", "post,read,code");
    await session.handleHuman(human("w1", "@Coder hello"));
    await session.handleHuman(human("w2", "@Coder hello again"));
    assert.match(chatFrom(await session.snapshot(), coder.pubkey).at(-1) ?? "", /ok/);
    const tools = async (conversationId: number) =>
      (await (await session.harness.conversation(conversationId as unknown as ConversationId, ctx))!.agent(ctx)).tools.map((tool) => tool.name);
    assert.ok((await tools(coder.conversationId)).includes("word_count"));
    await session.handleHuman(human("w3", "@Plain hello"));
    assert.deepEqual(await tools(plain.conversationId), []);
    const skipped = logged.filter((line) => /pi package/.test(line));
    assert.equal(skipped.length, 3, skipped.join("\n"));
    assert.equal(skipped.filter((line) => line.includes("./broken")).length, 1);
  } finally {
    console.error = original;
    await session.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(testWorkspaces(home), { recursive: true, force: true });
  }
});
