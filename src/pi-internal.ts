/**
 * The only place Yewholt reaches past the `exports` of `@earendil-works/pi-coding-agent`.
 *
 * Pi exports no CredentialStore backed by `auth.json`: `ModelRuntime` builds one internally, but
 * the daemon must wrap the store (Anthropic API-key policy) and hand the same store to pi-ai
 * `Models`. Until Pi exports `AuthStorage`, it is loaded from Pi's `dist/core/auth-storage.js` and
 * checked here, so a Pi bump that moves or reshapes it fails loudly at load and in
 * `test/pi-api.test.ts` instead of breaking login at runtime. Nothing else may import Pi internals.
 */
import type { CredentialStore } from "@earendil-works/pi-ai";
import { VERSION } from "@earendil-works/pi-coding-agent";

const AUTH_STORAGE = "./core/auth-storage.js";

type AuthStorageModule = {
  AuthStorage: { create(path: string): CredentialStore };
  ReadOnlyAuthStorage: new (path: string) => CredentialStore;
};

export class PiInternalError extends Error {
  constructor(detail: string) {
    super(`Pi ${VERSION} changed an internal module Yewholt relies on (${detail}). ` +
      "Update src/pi-internal.ts to Pi's public API or its new location.");
    this.name = "PiInternalError";
  }
}

let loaded: Promise<AuthStorageModule> | undefined;

function authStorageModule(): Promise<AuthStorageModule> {
  loaded ??= (async () => {
    const url = new URL(AUTH_STORAGE, import.meta.resolve("@earendil-works/pi-coding-agent")).href;
    let module: Record<string, unknown>;
    try {
      module = await import(url) as Record<string, unknown>;
    } catch (error) {
      throw new PiInternalError(`${AUTH_STORAGE} did not load: ${(error as Error).message}`);
    }
    const auth = module.AuthStorage as { create?: unknown } | undefined;
    if (typeof auth?.create !== "function") throw new PiInternalError(`${AUTH_STORAGE} has no AuthStorage.create`);
    if (typeof module.ReadOnlyAuthStorage !== "function") throw new PiInternalError(`${AUTH_STORAGE} has no ReadOnlyAuthStorage`);
    return module as AuthStorageModule;
  })();
  loaded.catch(() => { loaded = undefined; });
  return loaded;
}

function checked(store: CredentialStore, name: string): CredentialStore {
  for (const method of ["read", "list", "modify", "delete"] as const) {
    if (typeof store[method] !== "function") throw new PiInternalError(`${name} has no ${method}()`);
  }
  return store;
}

/** Pi's locking `auth.json` credential store, the one `pi` login and `ModelRuntime` use. */
export async function piAuthStorage(authPath: string): Promise<CredentialStore> {
  return checked((await authStorageModule()).AuthStorage.create(authPath), "AuthStorage");
}

/** Read-only view of `auth.json` that neither creates nor locks the file. */
export async function piReadOnlyAuthStorage(authPath: string): Promise<CredentialStore> {
  const { ReadOnlyAuthStorage } = await authStorageModule();
  return checked(new ReadOnlyAuthStorage(authPath), "ReadOnlyAuthStorage");
}
