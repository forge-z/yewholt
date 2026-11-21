import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isPubkey } from "./control-protocol.js";
import { readJson, record, syncDirectory, writePrivateJson } from "./control-files.js";

export type Pairing = { pubkey: string; label: string; pairedAt: number };
const pairingDir = (home: string) => join(home, "state", "pairings");
const pairingPath = (home: string, pubkey: string) => join(pairingDir(home), `${pubkey}.json`);

function validLabel(label: unknown): label is string {
  return typeof label === "string" && label.trim().length > 0 && label.length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(label);
}

export function readPairing(home: string, pubkey: string): Pairing | undefined {
  if (!isPubkey(pubkey)) return undefined;
  const dir = lstatSync(pairingDir(home), { throwIfNoEntry: false });
  if (!dir?.isDirectory()) return undefined;
  const path = pairingPath(home, pubkey);
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info?.isFile() || (info.mode & 0o777) !== 0o600) return undefined;
  const value = readJson(path);
  if (!record(value) || !validLabel(value.label) || typeof value.pairedAt !== "number" ||
      !Number.isSafeInteger(value.pairedAt) || value.pairedAt <= 0) return undefined;
  return { pubkey, label: value.label, pairedAt: value.pairedAt };
}

export function addPairing(home: string, pubkey: string, label: string, now = Date.now()): void {
  if (!isPubkey(pubkey) || !validLabel(label)) throw new Error("Expected a provider public key and a nonempty label");
  const old = readPairing(home, pubkey);
  writePrivateJson(pairingPath(home, pubkey), { label: label.trim(), pairedAt: old?.pairedAt ?? now });
}

export function removePairing(home: string, pubkey: string): boolean {
  if (!isPubkey(pubkey)) throw new Error("Expected a provider public key");
  try {
    if (!lstatSync(pairingDir(home), { throwIfNoEntry: false })?.isDirectory()) return false;
    unlinkSync(pairingPath(home, pubkey));
    syncDirectory(pairingDir(home));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function listPairings(home: string): Pairing[] {
  const dir = pairingDir(home);
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir).sort().flatMap((file) => {
    const pairing = file.endsWith(".json") && readPairing(home, file.slice(0, -5));
    return pairing ? [pairing] : [];
  });
}
