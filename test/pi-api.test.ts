import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { piAuthStorage, piReadOnlyAuthStorage } from "../src/pi-internal.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ISOLATED = "src/pi-internal.ts";
const SELF = "test/pi-api.test.ts";
const PI = "@earendil-works/";
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\.meta\.resolve\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`](@earendil-works\/[^"'`]+)["'`]/g;
const DEEP_URL = /new\s+URL\s*\([^)]*import\.meta\.resolve\s*\(\s*["'`]@earendil-works\//g;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:[cm]?[jt]s)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

/** Pi imports in `text` that bypass the packages' `exports`. */
export function internalPiImports(text: string, file: string): string[] {
  const found: string[] = [];
  for (const [, specifier] of text.matchAll(SPECIFIER)) {
    if (/\/(?:dist|src)\/|\.js$/.test(specifier!)) {
      found.push(`${file}: ${specifier} is a file path inside a Pi package`);
      continue;
    }
    try {
      import.meta.resolve(specifier!);
    } catch (error) {
      found.push(`${file}: ${specifier} is not in the package's exports (${(error as NodeJS.ErrnoException).code})`);
    }
  }
  if (file !== ISOLATED) {
    for (const [match] of text.matchAll(DEEP_URL)) found.push(`${file}: ${match} resolves a file inside a Pi package`);
    if (text.includes("node_modules/" + PI)) found.push(`${file}: reads a Pi package from node_modules`);
  }
  return found;
}

test("pi api: every Pi import goes through the package exports; only src/pi-internal.ts reaches inside", () => {
  const files = ["src", "provider", "test", "scripts", "buzz-plugin"].flatMap((dir) => existsSync(join(root, dir)) ? sources(join(root, dir)) : []);
  assert.ok(files.some((file) => relative(root, file) === ISOLATED));
  const found = files
    .map((file) => relative(root, file).split("\\").join("/"))
    .filter((file) => file !== SELF)
    .flatMap((file) => internalPiImports(readFileSync(join(root, file), "utf8"), file));
  assert.deepEqual(found, []);
});

test("pi api: the check catches deep imports and dist URLs", () => {
  const pkg = PI + "pi-coding-agent";
  const bad = [
    `import { AuthStorage } from "${pkg}/dist/core/auth-storage.js";`,
    `await import("${pkg}/core/auth-storage");`,
    `await import(new URL("./extensions/mcp/config.js", import.meta.resolve("${pkg}")).href);`,
  ].join("\n");
  assert.equal(internalPiImports(bad, "src/example.ts").length, 3);
  assert.deepEqual(internalPiImports(`import { main } from "${pkg}";\nimport { createModels } from "${PI}pi-ai/models";`, "src/example.ts"), []);
});

test("pi api: Pi's auth.json store still loads and keeps the shape Yewholt wraps", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "yewholt-pi-internal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, "missing", "auth.json");
  assert.deepEqual(await (await piReadOnlyAuthStorage(missing)).list(), []);
  assert.equal(existsSync(missing), false);

  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify({ deepseek: { type: "api_key", key: "test-key" } }), { mode: 0o600 });
  const readOnly = await piReadOnlyAuthStorage(path);
  assert.deepEqual((await readOnly.list()).map((entry) => entry.providerId), ["deepseek"]);
  const store = await piAuthStorage(path);
  assert.deepEqual(await store.read("deepseek"), { type: "api_key", key: "test-key" });
  await store.modify("openai", async () => ({ type: "api_key", key: "openai-key" }));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).openai, { type: "api_key", key: "openai-key" });
  await store.delete("openai");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).openai, undefined);
});
