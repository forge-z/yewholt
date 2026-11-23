import { createHash } from "node:crypto";
import { lstatSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isPubkey } from "./control-protocol.js";
import { readJson, record, syncDirectory, writePrivateJson } from "./control-files.js";

export type Pairing = { pubkey: string; label: string; pairedAt: number };
const pairingDir = (home: string, relay?: string) => relay === undefined ? join(home, "state", "pairings")
  : join(home, "state", "relay-pairings", createHash("sha256").update(relay).digest("hex"));
const pairingPath = (home: string, pubkey: string, relay?: string) => join(pairingDir(home, relay), `${pubkey}.json`);

function validLabel(label: unknown): label is string {
  return typeof label === "string" && label.trim().length > 0 && label.length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(label);
}

export function readPairing(home: string, pubkey: string, relay?: string): Pairing | undefined {
  if (!isPubkey(pubkey)) return undefined;
  const dir = lstatSync(pairingDir(home, relay), { throwIfNoEntry: false });
  if (!dir?.isDirectory()) return undefined;
  const path = pairingPath(home, pubkey, relay);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info?.isFile() || (info.mode & 0o777) !== 0o600) return undefined;
  const value = readJson(path);
  if (!record(value) || !validLabel(value.label) || typeof value.pairedAt !== "number" ||
      !Number.isSafeInteger(value.pairedAt) || value.pairedAt <= 0) return undefined;
  return { pubkey, label: value.label, pairedAt: value.pairedAt };
}

export function addPairing(home: string, pubkey: string, label: string, now = Date.now(), relay?: string): void {
  if (!isPubkey(pubkey) || !validLabel(label)) throw new Error("Expected a provider public key and a nonempty label");
  const old = readPairing(home, pubkey, relay);
  writePrivateJson(pairingPath(home, pubkey, relay), { label: label.trim(), pairedAt: old?.pairedAt ?? now });
}

export function removePairing(home: string, pubkey: string, relay?: string): boolean {
  if (!isPubkey(pubkey)) throw new Error("Expected a provider public key");
  try {
    if (!lstatSync(pairingDir(home, relay), { throwIfNoEntry: false })?.isDirectory()) return false;
    unlinkSync(pairingPath(home, pubkey, relay));
    syncDirectory(pairingDir(home, relay));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function listPairings(home: string, relay?: string): Pairing[] {
  const dir = pairingDir(home, relay);
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir).sort().flatMap((file) => {
    const pairing = file.endsWith(".json") && readPairing(home, file.slice(0, -5), relay);
    return pairing ? [pairing] : [];
  });
}

/** Forget every pairing of an additional relay, or make them the primary relay's pairings. */
export function dropRelayPairings(home: string, relay: string, promote = false): void {
  const primary = pairingDir(home);
  if (promote) rmSync(primary, { recursive: true, force: true });
  const dir = pairingDir(home, relay);
  if (promote && lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) renameSync(dir, primary);
  else rmSync(dir, { recursive: true, force: true });
}
