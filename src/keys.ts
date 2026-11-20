import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPair, pubkeyOf, type KeyPair } from "./nostr.js";

/** Write a Nostr secret as hex, mode 0600. Buzz has no key rotation; this file is the identity. */
export function writeKey(path: string, secretHex?: string): KeyPair {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const pair = secretHex ? { secret: secretHex, pubkey: pubkeyOf(secretHex) } : generateKeyPair();
  writeFileSync(path, `${pair.secret}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return pair;
}

export function readKey(path: string): string {
  const secret = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error(`not a nostr secret: ${path}`);
  return secret.toLowerCase();
}
