export const inject = ["agents", "host", "react", "relay"];

export function apply(ctx) {
  const { createElement: h, useEffect, useState, useSyncExternalStore } = ctx.react;
  const getCommunity = () => ctx.relay.selected?.();
  const subscribeCommunity = (listener) => ctx.relay.subscribe(listener);
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
            if (output.length + data.length <= 262144) output += data;
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
    const community = useSyncExternalStore(subscribeCommunity, getCommunity, getCommunity)?.replace(/^https:/, "wss:");
    const [targets, setTargets] = useState(null);
    const [relays, setRelays] = useState(null);
    const [error, setError] = useState("");
    const [catalog, setCatalog] = useState(null);
    const [retry, setRetry] = useState(0);
    useEffect(() => {
      const controller = new AbortController();
      request({ op: "targets", details: true }, controller.signal).then(({ targets, relays }) => {
        if (!controller.signal.aborted) {
          setTargets(targets);
          setRelays(relays);
        }
      }, (error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
      return () => controller.abort();
    }, []);
    const target = targets?.includes(config?.target) ? config.target : "";
    const code = config?.code === true;
    const model = config?.model ?? "";
    const targetRelay = relays?.[target];
    const endpoint = (value) => {
      const url = new URL(value);
      if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
      return url.href;
    };
    const mismatch = community && targetRelay && endpoint(community) !== endpoint(targetRelay);
    const readyTarget = target && !mismatch ? target : "";
    const loaded = catalog?.target === readyTarget && catalog?.retry === retry ? catalog : null;
    useEffect(() => {
      if (!readyTarget) return;
      const controller = new AbortController();
      request({ op: "models", target: readyTarget }, controller.signal).then(({ models }) => {
        if (!controller.signal.aborted) setCatalog({ target: readyTarget, retry, models });
      }, (error) => {
        if (!controller.signal.aborted) setCatalog({ target: readyTarget, retry, error: error.message });
      });
      return () => controller.abort();
    }, [readyTarget, retry]);
    useEffect(() => {
      onReadyChange?.(Boolean(readyTarget) && (!model || Boolean(loaded?.models?.includes(model))));
    }, [readyTarget, model, loaded, onReadyChange]);
    return h("div", null, harnessControl,
      h("label", null, "Yewholt target ", h("select", {
        value: target, disabled: disabled || !targets?.length,
        onChange: (event) => onChange({ target: event.target.value, code }),
      }, h("option", { value: "" }, "Select a target"),
      ...(targets ?? []).map((id) => h("option", { key: id, value: id }, id)))),
      mismatch ? h("p", { role: "alert" },
        `Buzz is open to ${community}, but ${target} uses ${targetRelay}. Open the target relay as a Buzz community, then create the agent there.`) : null,
      readyTarget ? h("label", null, "Model ", h("select", {
        value: model, disabled, onChange: (event) => onChange({ target, code, model: event.target.value }),
      }, h("option", { value: "" }, "Daemon default"),
      model && !loaded?.models?.includes(model) ? h("option", { value: model, disabled: true }, model) : null,
      ...(loaded?.models ?? []).map((id) => h("option", { key: id, value: id }, id)))) : null,
      readyTarget && !loaded ? h("p", { role: "status" }, "Loading models from Yewholt…")
        : loaded?.error ? h("p", { role: "alert" }, loaded.error, " ",
          h("button", { type: "button", disabled, onClick: () => setRetry((value) => value + 1) }, "Retry"))
        : loaded?.models?.length === 0 ? h("p", null, "No models are configured on this daemon.") : null,
      h("label", null, h("input", {
        type: "checkbox", checked: code, disabled: disabled || !target,
        onChange: (event) => onChange({ target, code: event.target.checked, model }),
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
          target: config?.target, code: config?.code === true, model: config?.model || undefined }, signal);
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
