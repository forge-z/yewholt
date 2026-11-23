export const inject = ["agents", "host", "react", "relay"];

async function loadRuntime(source) {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    return await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function apply(ctx, load = loadRuntime) {
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort());

  async function request(input, callerSignal) {
    const signals = callerSignal ? [lifetime.signal, callerSignal] : [lifetime.signal];
    const ensureActive = () => signals.forEach((signal) => signal.throwIfAborted());
    ensureActive();
    let output = "";
    let overflow = false;
    let child;
    const stop = () => { if (child) void child.kill().catch(() => {}); };
    for (const signal of signals) signal.addEventListener("abort", stop, { once: true });
    try {
      try {
        child = await ctx.host.spawn("provider", {
          onStdout(data) {
            if (output.length + data.length <= 262144) output += data;
            else overflow = true;
          },
        });
      } catch {
        throw new Error("Cannot start Yewholt. Run yewholt provider install on this Mac.");
      }
      ensureActive();
      await child.end(JSON.stringify(input));
      const code = await child.exited;
      ensureActive();
      let result;
      try { if (!overflow) result = JSON.parse(output); } catch { /* Invalid bridge response. */ }
      if (code !== 0 || !result?.ok) {
        throw Object.assign(new Error(result?.error ?? "The Yewholt bridge did not complete the operation."), { code: result?.code });
      }
      return result;
    } finally {
      for (const signal of signals) signal.removeEventListener("abort", stop);
      stop();
    }
  }

  const { source } = await request({ op: "plugin-ui-v1" }, AbortSignal.timeout(8_000));
  if (typeof source !== "string" || !source) throw new Error("The Yewholt bridge did not provide a UI.");
  const runtime = await load(source);
  lifetime.signal.throwIfAborted();
  await runtime.apply(ctx, request);

  ctx.effect(() => {
    let timer;
    let closed = false;
    const check = async () => {
      try {
        await request({ op: "plugin-update-v1" });
      } catch (error) {
        if (!closed) console.warn("Yewholt could not check for updates:", error.message);
      } finally {
        if (!closed) timer = setTimeout(check, 60 * 60 * 1000);
      }
    };
    timer = setTimeout(check, 0);
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  });
}
