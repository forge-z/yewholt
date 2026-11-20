#!/usr/bin/env bash
# Manual reproduction of the durable resume proof.
# A three-step task writes effects/1, effects/2, then waits. kill -9 hits it
# after step 2's effect and before that step's checkpoint. The restart reruns
# step 2 from the top and must not create a second effects/2.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run build
DIR="$(mktemp -d)"
cleanup() { rm -rf "$DIR"; }
trap cleanup EXIT
echo "work directory: $DIR"
node dist/src/proof-worker.js "$DIR" &
PID=$!
for _ in $(seq 1 150); do
  if [[ -f "$DIR/holding" ]]; then
    break
  fi
  sleep 0.1
done
if [[ ! -f "$DIR/holding" ]]; then
  echo "worker never reached the hold point" >&2
  kill -9 "$PID" || true
  exit 1
fi
test -f "$DIR/effects/1"
test -f "$DIR/effects/2"
if [[ -f "$DIR/effects/3" ]]; then
  echo "step 3 ran before the kill" >&2
  exit 1
fi
echo "killing $PID"
kill -9 "$PID" || true
wait "$PID" || true
echo release > "$DIR/release"
node dist/src/proof-worker.js "$DIR"
python3 - "$DIR" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
effects = sorted(p.name for p in (root / "effects").iterdir())
assert effects == ["1", "2", "3"], effects
phases = (root / "phase-entries.log").read_text().split()
assert phases.count("1") == 1, phases
assert phases.count("2") == 2, phases
assert phases.count("3") == 1, phases
print("kill -9 resume ok")
print("phase entries:", " ".join(phases))
PY
