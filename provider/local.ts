import { createHash, randomUUID } from "node:crypto";
import { linkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { record, syncDirectory, writePrivateJson } from "../src/control-files.js";
import { agentsDir, yewholtHome } from "../src/paths.js";
import { privateJson } from "./target.js";

function read(path: string): unknown {
  try {
    return privateJson(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function deployLocal(requestId: string, pubkey: string, file: unknown): void {
  const home = yewholtHome();
  const dir = join(home, "state", "local-deploys");
  const receipt = join(dir, requestId + ".json");
  const serialized = JSON.stringify(file);
  if (Buffer.byteLength(serialized) >= 32 * 1024) throw new Error("Local provisioning is too large");
  const digest = createHash("sha256").update(serialized).digest("hex");
  let job = read(receipt);
  if (job === undefined) {
    const staged = join(dir, "." + randomUUID() + ".json");
    writePrivateJson(staged, { pubkey, digest, complete: false });
    try {
      try {
        linkSync(staged, receipt);
        syncDirectory(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      job = read(receipt);
    } finally {
      unlinkSync(staged);
    }
  }
  if (!record(job) || job.pubkey !== pubkey || (job.complete !== true && job.digest !== digest)) {
    throw new Error("Local request id already used");
  }
  if (job.complete === true) return;
  const path = join(agentsDir(home), pubkey + ".json");
  if (JSON.stringify(read(path)) !== serialized) writePrivateJson(path, file);
  writePrivateJson(receipt, { pubkey, digest, complete: true });
}
