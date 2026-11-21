// Adapted from block/buzz-app src/bundled/pi/host.mjs (loadPackages, isProvider,
// loadPackage, hookPackages, piDir), commit 9657bb35451c99d3cf1687f1af9ca76fa7f001f0,
// Apache-2.0. See NOTICE. Changes: TypeScript; pi-durable 1.6.0; the host's own
// extension names are Yewholt's (`yewholt-code` joins `coding-tools`, `tool-search`
// and the reserved `buzz`); messages say Yewholt instead of Buzz.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Provider } from "@earendil-works/pi-ai/models";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createRegistry, type Extension } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools } from "@earendil-works/pi-durable/tools";

/** The name of Yewholt's own gate extension (src/coding.ts). Reserved for packages. */
export const GATE_EXTENSION = "yewholt-code";
/** Names a package's extension may not take, besides those already installed. Buzz reserves `buzz`. */
const RESERVED = new Set(["buzz", GATE_EXTENSION]);

export type PackageError = { source: string; error: string };
export type LoadedPackages = { extensions: Extension[]; providers: Provider[]; errors: PackageError[] };

/** Pi's folder, shared with the `pi` command: its keys and settings. */
export function piDir(): string {
  return getAgentDir();
}

/** How long a package has to load before it's left out, so one that hangs doesn't keep every agent from starting. */
const PACKAGE_MS = 30_000;

/**
 * The Pi packages in Pi's settings that have parts for Pi durable: a package lists them as
 * `"pi": { "durable": ["./durable.ts"] }` in its package.json, which the `pi` command ignores.
 * Each one's default export returns the `extensions` code bots run with and the `providers`
 * added to the model catalog. A package that fails is left out, and said why. Only packages
 * in a local folder load. Extensions written for the pi coding agent (`pi.extensions`,
 * `(pi) => {}`) are not read.
 */
export async function loadPackages(dir: string, limit = PACKAGE_MS): Promise<LoadedPackages> {
  const loaded: LoadedPackages = { extensions: [], providers: [], errors: [] };
  let settings: { packages?: unknown } | undefined;
  try {
    // As Pi does, with the BOM an editor may save.
    settings = JSON.parse((await readFile(join(dir, "settings.json"), "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return loaded;
  }
  const sources: unknown[] = Array.isArray(settings?.packages) ? settings.packages : [];
  if (sources.length) hookPackages();
  // The extensions are checked against what every code bot installs, so one that can't
  // install is left out instead of stopping every code bot.
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(createToolSearchExtension());
  for (const item of sources) {
    const source = typeof item === "string" ? item : (item as { source?: unknown } | null)?.source;
    const installed: Extension[] = [];
    try {
      if (typeof source !== "string" || /^(?:npm|git|https?|ssh):/.test(source)) {
        throw new Error("Yewholt loads only Pi packages in a local folder");
      }
      const root = resolvePath(dir, source.replace(/^~(?=$|[\\/])/, homedir()));
      // A timer the host waits for: a setup that never settles may hold nothing else that keeps Node running.
      let timer: NodeJS.Timeout | undefined;
      const { extensions, providers } = await Promise.race([
        loadPackage(root),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`It took over ${limit / 1000} seconds`)), limit);
        }),
      ]).finally(() => clearTimeout(timer));
      for (const extension of extensions) {
        if (typeof extension?.name !== "string") throw new Error("An extension it returns has no name");
        if (RESERVED.has(extension.name) || registry.snapshot().extension(extension.name)) {
          throw new Error(`Another extension is named ${extension.name}`);
        }
        registry.install(extension);
        installed.push(extension);
      }
      if (!providers.every(isProvider)) throw new Error("A provider it returns needs an id, name, auth and getModels");
      // The daemon never refreshes models, so a provider whose models come only from
      // `fetchModels` would be missing from the list unexplained.
      const empty = providers.find((provider) => !provider.getModels().length);
      if (empty) throw new Error(`Provider ${empty.id} lists no models, and Yewholt doesn't fetch a provider's models`);
      loaded.extensions.push(...extensions);
      loaded.providers.push(...providers);
    } catch (error) {
      for (const extension of installed) registry.uninstall(extension);
      loaded.errors.push({ source: String(source), error: error instanceof Error ? error.message : String(error) });
    }
  }
  return loaded;
}

/**
 * Whether a provider has what listing providers reads, which one made without pi-ai's
 * `createProvider` may lack: without it, the list fails for every bot.
 */
function isProvider(provider: unknown): provider is Provider {
  const candidate = provider as Partial<Provider> | null;
  return (
    typeof candidate?.id === "string" &&
    typeof candidate.name === "string" &&
    Boolean(candidate.auth?.apiKey || candidate.auth?.oauth) &&
    typeof candidate.getModels === "function"
  );
}

/** What the package in a folder adds, from each of its durable entries. */
async function loadPackage(root: string): Promise<{ extensions: Extension[]; providers: Provider[] }> {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { pi?: { durable?: unknown } };
  const entries = manifest.pi?.durable ?? [];
  if (!Array.isArray(entries)) throw new Error('"pi.durable" in its package.json must list files');
  const made: { extensions: Extension[]; providers: Provider[] } = { extensions: [], providers: [] };
  for (const entry of entries) {
    const { default: setup } = (await import(pathToFileURL(resolvePath(root, String(entry))).href)) as {
      default: () => Promise<{ extensions?: Extension[]; providers?: Provider[] } | undefined> | { extensions?: Extension[]; providers?: Provider[] } | undefined;
    };
    const { extensions = [], providers = [] } = (await setup()) ?? {};
    made.extensions.push(...extensions);
    made.providers.push(...providers);
  }
  return made;
}

/**
 * Packages get Yewholt's own `@earendil-works` packages, so what they define is what the
 * daemon runs, and may be TypeScript, also under `node_modules`, where Node doesn't strip
 * types itself.
 */
let hooked = false;
function hookPackages(): void {
  if (hooked) return;
  hooked = true;
  const here = import.meta.url;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith("@earendil-works/")) {
        try {
          return next(specifier, { ...context, parentURL: here });
        } catch {
          // fall through to the package's own resolution
        }
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (!/^file:.*\/node_modules\/.*\.m?ts$/.test(url)) return next(url, context);
      return {
        format: "module",
        source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8")),
        shortCircuit: true,
      };
    },
  });
}
