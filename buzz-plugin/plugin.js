export const inject = ["agents", "host", "react"];

export function apply(ctx) {
  const { createElement: h, useEffect, useState } = ctx.react;
  const processes = new Set();
  const stop = (child) => void child.kill().catch(() => {});
  let generation = 0;
  ctx.effect(() => {
    return () => {
      generation++;
      for (const child of processes) stop(child);
      processes.clear();
    };
  });

  async function request(input, signal) {
    signal.throwIfAborted();
    const active = generation;
    let output = "";
    let overflow = false;
    let child;
    const abort = () => { if (child) stop(child); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      try {
        child = await ctx.host.spawn("provider", {
          onStdout(data) {
            if (output.length + data.length <= 65536) output += data;
            else overflow = true;
          },
        });
      } catch {
        throw new Error("Cannot start Yewholt. Run yewholt provider install on this Mac.");
      }
      processes.add(child);
      signal.throwIfAborted();
      if (active !== generation) throw new Error("Yewholt plugin stopped");
      await child.end(JSON.stringify(input));
      const code = await child.exited;
      signal.throwIfAborted();
      let result;
      try { if (!overflow) result = JSON.parse(output); } catch { /* Invalid bridge response. */ }
      if (code !== 0 || !result?.ok) {
        throw new Error(result?.error ?? "The Yewholt bridge did not complete the operation.");
      }
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
      if (child && processes.delete(child)) stop(child);
    }
  }

  function CreateConfiguration({ config, disabled, harnessControl, onChange, onReadyChange }) {
    const [targets, setTargets] = useState(null);
    const [error, setError] = useState("");
    useEffect(() => {
      const controller = new AbortController();
      request({ op: "targets" }, controller.signal).then(({ targets }) => {
        if (!controller.signal.aborted) setTargets(targets);
      }, (error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
      return () => controller.abort();
    }, []);
    const target = targets?.includes(config?.target) ? config.target : "";
    const code = config?.code === true;
    useEffect(() => {
      onReadyChange?.(Boolean(target));
    }, [target, onReadyChange]);
    return h("div", null, harnessControl,
      h("label", null, "Yewholt target ", h("select", {
        value: target, disabled: disabled || !targets?.length,
        onChange: (event) => onChange({ target: event.target.value, code }),
      }, h("option", { value: "" }, "Select a target"),
      ...(targets ?? []).map((id) => h("option", { key: id, value: id }, id)))),
      h("label", null, h("input", {
        type: "checkbox", checked: code, disabled: disabled || !target,
        onChange: (event) => onChange({ target, code: event.target.checked }),
      }), " Allow code execution on the target"),
      error ? h("p", { role: "alert" }, error)
        : targets?.length === 0 ? h("p", null, "Add a relay target with yewholt targets add.") : null,
    );
  }

  ctx.agents.register({
    id: "yewholt",
    title: "Yewholt",
    description: "Run agents on a paired Yewholt target.",
    defaults: () => ({ config: { target: "", code: false } }),
    CreateConfiguration,
    remote: {
      async provision({ name, picture, community, config, signal }) {
        const result = await request({ op: "provision", name, picture, community,
          target: config?.target, code: config?.code === true }, signal);
        return { pubkey: result.pubkey, picture: result.picture };
      },
      async activate({ pubkey, community, auth, signal }) {
        await request({ op: "activate", pubkey, community, auth }, signal);
      },
      async profile({ pubkey, name, picture, community, signal }) {
        await request({ op: "profile", pubkey, name, picture, community }, signal);
      },
      async remove({ pubkey, community, signal }) {
        await request({ op: "remove", pubkey, community }, signal);
      },
    },
  });
}
