import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

export type ControlContext = { agentPubkey: string; requestId: string };

function keyFor(secret: string, peer: string, salt: Buffer, purpose: string): Buffer {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(secret, "hex");
  // Nostr carries only x. Either parity gives the same ECDH x-coordinate.
  const shared = ecdh.computeSecret(`02${peer}`, "hex");
  return Buffer.from(hkdfSync("sha256", shared, salt, purpose, 32));
}

function aad({ agentPubkey, requestId }: ControlContext): Buffer {
  return Buffer.concat([Buffer.from(agentPubkey, "hex"), Buffer.from(requestId, "utf8")]);
}

export function seal(plaintext: string, secret: string, peer: string, context: ControlContext, purpose: string): string {
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret, peer, salt, purpose), nonce);
  cipher.setAAD(aad(context));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([salt, nonce, cipher.getAuthTag(), body]).toString("base64");
}

export function open(content: string, secret: string, peer: string, context: ControlContext, purpose: string): string {
  const data = Buffer.from(content, "base64");
  if (data.length < 60 || data.toString("base64") !== content) throw new Error("Invalid control ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", keyFor(secret, peer, data.subarray(0, 32), purpose), data.subarray(32, 44));
  decipher.setAAD(aad(context));
  decipher.setAuthTag(data.subarray(44, 60));
  return Buffer.concat([decipher.update(data.subarray(60)), decipher.final()]).toString("utf8");
}
