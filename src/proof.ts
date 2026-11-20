import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context: Context = BACKGROUND_CONTEXT;

type ProofInput = { dir: string; steps: number; holdStep: number };
type ProofState = { phase: "run"; n: number };

/**
 * Multi-step task. Each phase commits its checkpoint only after the external
 * effect. A phase that dies before that commit reruns from the top (pi-durable
 * README, Persist and Resume, and example 12). The effect file is created with
 * O_EXCL so the rerun does not apply it twice. `runtime.memo` records the same
 * intent inside the store.
 */
export const ProofTask = defineTask<ProofInput, ProofState, { steps: number }>({
  name: "yewholt.proof",
  version: 1,
  initial: () => ({ phase: "run", n: 1 }),
  phases: {
    run: async (task, runtime, taskContext) => {
      const n = task.state.checkpoint.n;
      const dir = task.input.dir;
      appendFileSync(join(dir, "phase-entries.log"), `${n}\n`);
      const seen = await runtime.memo<boolean>(`effect-${n}`, taskContext);
      if (seen === undefined) {
        writeEffect(dir, n);
        await runtime.memo(`effect-${n}`, true, taskContext);
      }
      if (n === task.input.holdStep) {
        writeFileSync(join(dir, "holding"), `${n}\n`);
        while (!existsSync(join(dir, "release"))) {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
      if (n >= task.input.steps) {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: { steps: n } } }),
          taskContext,
        );
        return;
      }
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "run", n: n + 1 } }), taskContext);
    },
  },
  abort: async (_task, runtime, taskContext) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
  },
});

function writeEffect(dir: string, n: number): void {
  const effects = join(dir, "effects");
  mkdirSync(effects, { recursive: true });
  const path = join(effects, String(n));
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, `${n}\n`);
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function runProofWorker(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "yewholt.proof", tasks: [ProofTask] }));
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, "session.sqlite")),
    { models: createModels(), registry },
    context,
  );
  const root = await harness.root(context);
  const idPath = join(dir, "task-id");
  let taskId = existsSync(idPath) ? readFileSync(idPath, "utf8").trim() : "";
  if (!taskId) {
    const created = await root.commit(
      (tx) => tx.createTask(ProofTask, { dir, steps: 3, holdStep: 2 }, { ownership: { kind: "conversation" } }),
      context,
    );
    taskId = String(created);
    writeFileSync(idPath, taskId);
  }
  harness.resume();
  const done = await harness.waitForTask(Number(taskId) as unknown as TaskId<{ steps: number }>, context);
  if (done.state.outcome.status !== "completed") {
    throw new Error(`proof task ended ${done.state.outcome.status}`);
  }
  await harness.close(context);
}
