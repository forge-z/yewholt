import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import type { Context } from "@earendil-works/chord/context";
import { err, ExecutionError, ok, toError, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";

const MAX_TIMEOUT_MS = 2_147_483_647;

/** Use a catchable signal for sudo. The bot-owned bootstrap can kill the command group. */
export async function runWorkspaceCommand(
  argv: readonly string[],
  cwd: string,
  options: ShellExecOptions | undefined,
  context: Context,
  cleanupSignal?: AbortSignal,
): Promise<Result<ShellExecResult, ExecutionError>> {
  const signals = [context.abortSignal, cleanupSignal].filter((signal) => signal !== undefined);
  const signal = AbortSignal.any(signals);
  if (signal.aborted) return err(new ExecutionError("aborted", "aborted"));
  const timeout = options?.timeout;
  const timeoutMs = timeout === undefined ? undefined : timeout * 1000;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)) {
    return err(new ExecutionError("timeout", "Invalid timeout in seconds"));
  }
  const [program, ...args] = argv;
  let child;
  try {
    child = spawn(program === "sudo" ? "/usr/bin/sudo" : program!, args, {
      argv0: program,
      cwd,
      env: {},
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return err(new ExecutionError("spawn_error", toError(error).message));
  }

  let failure: ExecutionError | undefined;
  let spillPath: string | undefined;
  let spill: WriteStream | undefined;
  let spillDone: Promise<void> | undefined;
  const prefix: Buffer[] = [];
  let bytes = 0;
  let lines = 0;
  const interrupt = (error: ExecutionError) => {
    if (failure) return;
    failure = error;
    // EOF is also the cancellation channel if sudo cannot relay the signal.
    child.stdin.destroy();
    child.kill("SIGTERM");
  };
  const abort = () => interrupt(new ExecutionError("aborted", "aborted"));
  signal.addEventListener("abort", abort, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    interrupt(new ExecutionError("timeout", `timeout:${timeout}`));
  }, timeoutMs);
  child.stdin.on("error", () => {});

  const onSpillError = (error: unknown) => interrupt(new ExecutionError("unknown", `Failed to preserve complete shell output: ${toError(error).message}`));
  const feed = (source: "stdout" | "stderr") => {
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const emit = (output: string) => {
      if (!output || failure) return;
      try {
        options?.onOutput?.(output, context, { stream: source });
      } catch (error) {
        interrupt(new ExecutionError("callback_error", toError(error).message));
      }
    };
    const stream = child[source];
    stream.on("data", (chunk: Buffer) => {
      emit(decoder.decode(chunk, { stream: true }));
      if (!options?.spill) return;
      if (!spill) {
        prefix.push(chunk);
        bytes += chunk.length;
        for (const byte of chunk) if (byte === 10) lines++;
        const totalLines = lines + Number(chunk.at(-1) !== 10);
        if (bytes <= options.spill.afterBytes && totalLines <= options.spill.afterLines) return;
        spillPath = join(tmpdir(), `pi-output-${randomUUID()}.log`);
        spill = createWriteStream(spillPath, { flags: "wx", mode: 0o600 });
        spillDone = finished(spill).catch(onSpillError);
        for (const buffered of prefix) spill.write(buffered);
        prefix.length = 0;
      } else {
        spill.write(chunk);
      }
      if (spill.writableNeedDrain) {
        child.stdout.pause();
        child.stderr.pause();
        spill.once("drain", () => {
          child.stdout.resume();
          child.stderr.resume();
        });
      }
    });
    stream.once("end", () => emit(decoder.decode()));
  };
  feed("stdout");
  feed("stderr");

  const exitCode = await new Promise<number>((resolve) => {
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    child.once("error", (error) => {
      failure ??= new ExecutionError("spawn_error", error.message, error);
      resolve(1);
    });
    child.once("exit", () => {
      child.stdin.destroy();
      // A background process can keep the output descriptors open after the command exits.
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, 100);
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(drainTimer);
      resolve(code ?? (exitSignal ? 128 + constants.signals[exitSignal] : 1));
    });
  });
  clearTimeout(timer);
  signal.removeEventListener("abort", abort);
  spill?.end();
  await spillDone;
  if (failure) {
    failure.spillPath = spillPath;
    return err(failure);
  }
  return ok({ exitCode, ...(spillPath === undefined ? {} : { spillPath }) });
}
