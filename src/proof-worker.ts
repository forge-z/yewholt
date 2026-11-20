import { runProofWorker } from "./proof.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: proof-worker <directory>");
  process.exit(2);
}
runProofWorker(dir).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
