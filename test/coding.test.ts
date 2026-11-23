import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ensureOwnerKey, failureReason, instructionsFor, parseAdmins, type Yewholt } from "../src/session.js";
import { workspaceDir } from "../src/workspace.js";
import { WorkspaceIsolation, type IsolationProbe } from "../src/isolation.js";
import type { BotRecord } from "../src/registry.js";
import { CHANNEL, chatFrom, createBot, emptyPiDir, human, openSession, testWorkspaces, waitUntil } from "./helpers/coding.js";

const ELSEWHERE = "44444444-4444-4444-8444-444444444444";

async function withCoding(
  fn: (session: Yewholt, home: string) => Promise<void>,
  isolationFor?: (home: string) => WorkspaceIsolation,
  opts: { admins?: readonly string[]; models?: Parameters<typeof openSession>[3]; setup?: (piDir: string) => void } = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "yewholt-code-"));
  const home = join(root, "state");
  const piDir = emptyPiDir();
  opts.setup?.(piDir);
  const session = await openSession(new MemoryStorage(), home, piDir, opts.models, isolationFor?.(home), opts.admins);
  try {
    await fn(session, home);
  } finally {
    await session.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(piDir, { recursive: true, force: true });
  }
}

async function toolNames(session: Yewholt, bot: BotRecord): Promise<string[]> {
  return (await session.botSession(bot.pubkey)).getActiveToolNames().sort();
}

async function lastReply(session: Yewholt, bot: BotRecord): Promise<string> {
  return chatFrom(await session.snapshot(), bot.pubkey).at(-1) ?? "";
}

async function approvals(session: Yewholt) {
  return (await session.snapshot()).approvals ?? [];
}

test("permissions: only a bot whose stored permissions include code gets tools", async () => {
  await withCoding(async (session, home) => {
    const plain = await createBot(session, "Plain", "post,read");
    const coder = await createBot(session, "Coder", "post,read,code");
    assert.deepEqual(coder.permissions, ["post", "read", "code"]);

    await session.handleHuman(human("p1", "@Plain run: echo hi > plain.txt"));
    assert.deepEqual(await toolNames(session, plain), ["read", "tool_search"]);
    assert.match(await lastReply(session, plain), /done\[error\]/);
    assert.equal(existsSync(workspaceDir(testWorkspaces(home), plain.pubkey)), false);

    await session.handleHuman(human("c1", "@Coder run: echo hi > hello.txt"));
    assert.deepEqual(await toolNames(session, coder), ["bash", "edit", "read", "tool_search", "write"]);
    assert.match(await lastReply(session, coder), /done\[ok\]/);
    assert.equal(readFileSync(join(workspaceDir(testWorkspaces(home), coder.pubkey), "hello.txt"), "utf8"), "hi\n");
  });
});

test("permissions: granting and revoking code in the agent file applies on the next turn", async () => {
  await withCoding(async (session, home) => {
    const plain = await createBot(session, "Plain", "post,read");
    await createBot(session, "Plain", "post,read,code");
    assertWorkspace(testWorkspaces(home), plain.pubkey);
    await session.handleHuman(human("g3", "@Plain run: echo granted > granted.txt"));
    assert.match(await lastReply(session, plain), /done\[ok\]/);
    assert.equal(readFileSync(join(workspaceDir(testWorkspaces(home), plain.pubkey), "granted.txt"), "utf8"), "granted\n");
    assert.ok((await toolNames(session, plain)).includes("bash"));
    const codeSession = await session.botSession(plain.pubkey);
    const path = codeSession.sessionManager.getSessionFile();

    await createBot(session, "Plain", "post,read");
    assert.deepEqual(await toolNames(session, plain), ["read", "tool_search"]);
    const chatSession = await session.botSession(plain.pubkey);
    assert.notEqual(chatSession, codeSession);
    assert.equal(chatSession.sessionManager.getSessionFile(), path);
    await session.handleHuman(human("r3", "@Plain run: echo revoked > revoked.txt"));
    assert.match(await lastReply(session, plain), /done\[error\]/);
    assert.equal(existsSync(join(workspaceDir(testWorkspaces(home), plain.pubkey), "revoked.txt")), false);
  });
});

test("instructions: a code bot is told about its workspace, tools and approvals; others can use installed skills and extensions", () => {
  const base: BotRecord = {
    conversationId: 1,
    name: "Coder",
    pubkey: "d0".repeat(32),
    modelLabel: "faux/faux-1",
    provider: "faux",
    modelId: "faux-1",
    scope: [CHANNEL],
    permissions: ["post", "read"],
    status: "active",
    role: "member",
    limitTokens: 1,
    spentTokens: 0,
    announced: true,
  };
  const plain = instructionsFor(base);
  assert.match(plain, /installed skills, MCP servers and extension tools/);
  const coder = instructionsFor({ ...base, permissions: ["post", "read", "code"] });
  assert.match(coder, /workspace/);
  assert.match(coder, /read, write, edit and bash/);
  assert.match(coder, /approv/);
  assert.match(coder, /git push/);
  assert.doesNotMatch(coder, /repo access are out of scope/);
});

test("secrets: a bash call cannot see a variable set in the daemon's process.env", async () => {
  process.env.YEWHOLT_FAKE_PROVIDER_KEY = "sk-test-must-not-leak";
  try {
    await withCoding(async (session) => {
      const coder = await createBot(session, "Coder", "post,read,code");
      await session.handleHuman(human("s1", "@Coder run: echo key=[$YEWHOLT_FAKE_PROVIDER_KEY] home=$HOME session=[$PI_SESSION_FILE] id=[$PI_SESSION_ID]"));
      const reply = await lastReply(session, coder);
      assert.match(reply, /done\[ok\]: key=\[\] home=/);
      assert.doesNotMatch(reply, /sk-test-must-not-leak/);
      assert.match(reply, /session=\[\] id=\[\]/);
    });
  } finally {
    delete process.env.YEWHOLT_FAKE_PROVIDER_KEY;
  }
});

test("secrets: reading $YEWHOLT_HOME outside the workspace is refused outright, also through a symlink", async () => {
  await withCoding(async (session, home) => {
    const coder = await createBot(session, "Coder", "post,read,code");
    await session.handleHuman(human("k1", "@Coder read: ../../state/secrets/owner.key"));
    const reply = await lastReply(session, coder);
    assert.match(reply, /done\[error\]/);
    assert.match(reply, /refused/i);
    assert.doesNotMatch(reply, new RegExp(readFileSync(join(home, "secrets", "owner.key"), "utf8").trim()));
    assert.equal((await approvals(session)).length, 0);
    // The symlink itself is made by an approved-free command inside the workspace.
    await session.handleHuman(human("k2", "@Coder run: ln -s ../../state up"));
    await session.handleHuman(human("k3", "@Coder read: up/secrets/owner.key"));
    assert.match(await lastReply(session, coder), /done\[error\].*refused/is);
  });
});

test("approval: a dangerous call parks, the bot asks in the channel, aprovo runs it exactly once", async () => {
  await withCoding(async (session, home) => {
    const coder = await createBot(session, "Coder", "post,read,code");
    const command = "mkdir -p junk && rm -rf junk && echo ran >> ran.txt";
    const turn = session.handleHuman(human("a1", `@Coder run: ${command}`));
    const [request] = await waitUntil(async () => {
      const list = await approvals(session);
      return list.length > 0 && list;
    }, "the approval request");
    assert.equal(request!.channelId, CHANNEL);
    assert.equal(request!.pubkey, coder.pubkey);
    assert.equal(request!.subject, command);
    const asked = await waitUntil(async () => chatFrom(await session.snapshot(), coder.pubkey).find((text) => text.includes(command)), "the request message");
    assert.match(asked, /aprovo/);
    assert.match(asked, /rejeito/);
    assert.match(asked, /recursive delete/);
    const ran = join(workspaceDir(testWorkspaces(home), coder.pubkey), "ran.txt");
    assert.equal(existsSync(ran), false);

    // Someone else's "aprovo" in another channel does not resolve it.
    await session.handleHuman(human("a2", "aprovo", { channelId: ELSEWHERE }));
    assert.equal((await approvals(session)).length, 1);

    await session.handleHuman(human("a3", "aprovo"));
    await turn;
    assert.equal(readFileSync(ran, "utf8"), "ran\n");
    assert.equal((await approvals(session)).length, 0);
    assert.match(await lastReply(session, coder), /done\[ok\]/);

    // A second "aprovo" finds nothing to run again.
    await session.handleHuman(human("a4", "sim"));
    assert.equal(readFileSync(ran, "utf8"), "ran\n");
  });
});

test("approval: rejeito resolves the call with a refusal the model sees", async () => {
  await withCoding(async (session, home) => {
    const coder = await createBot(session, "Coder", "post,read,code");
    const turn = session.handleHuman(human("j1", "@Coder run: rm -rf stuff; echo ran >> rejected.txt"));
    await waitUntil(async () => (await approvals(session)).length === 1, "the approval request");
    await session.handleHuman(human("j2", "@Coder rejeito"));
    await turn;
    assert.equal(existsSync(join(workspaceDir(testWorkspaces(home), coder.pubkey), "rejected.txt")), false);
    assert.match(await lastReply(session, coder), /done\[error\]:[\s\S]*A person rejected this in the chat; it was not run: rm -rf stuff/);
    assert.equal((await approvals(session)).length, 0);
  });
});

test("approval: writing outside the workspace asks first; the request names the path", async () => {
  await withCoding(async (session) => {
    const coder = await createBot(session, "Coder", "post,read,code");
    const outside = mkdtempSync(join(tmpdir(), "yewholt-outside-"));
    try {
      const target = join(outside, "out.txt");
      const turn = session.handleHuman(human("w1", `@Coder write: ${target}`));
      const [request] = await waitUntil(async () => {
        const list = await approvals(session);
        return list.length > 0 && list;
      }, "the approval request");
      assert.equal(request!.subject, target);
      assert.equal(existsSync(target), false);
      await session.handleHuman(human("w2", "approve"));
      await turn;
      assert.equal(readFileSync(target, "utf8"), "written\n");
      assert.match(await lastReply(session, coder), /done\[ok\]/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("approval: codemode's nested bash and writes park for chat approval and preserve outright refusals", async () => {
  await withCoding(async (session, home) => {
    const coder = await createBot(session, "Coder", "post,read,code");
    const sdk = await session.botSession(coder.pubkey);
    sdk.setActiveToolsByName([...sdk.getActiveToolNames(), "codemode"]);
    const ran = join(workspaceDir(testWorkspaces(home), coder.pubkey), "nested.txt");
    const target = join(home, "..", "nested-outside.txt");
    const command = "mkdir -p junk && rm -rf junk && echo nested >> nested.txt";
    const script = `text(await tools.bash(${JSON.stringify({ command })}));
text(await tools.write(${JSON.stringify({ path: target, content: "must not run" })}));`;
    const turn = session.handleHuman(human("cm1", `@Coder script: ${script}`));
    const [bash] = await waitUntil(async () => {
      const list = await approvals(session);
      return list.length > 0 && list;
    }, "codemode bash approval");
    assert.equal(bash!.subject, command);
    assert.equal(existsSync(ran), false);
    assert.equal(existsSync(target), false);
    assert.match(await lastReply(session, coder), /aprovo[\s\S]*rejeito/);

    await session.handleHuman(human("cm2", "aprovo"));
    const [write] = await waitUntil(async () => {
      const list = await approvals(session);
      return list.some((request) => request.subject === target) && list;
    }, "codemode outside write approval");
    assert.equal(write!.subject, target);
    assert.equal(readFileSync(ran, "utf8"), "nested\n");
    assert.equal(existsSync(target), false);
    await session.handleHuman(human("cm3", "rejeito"));
    await turn;
    assert.equal(existsSync(target), false);
    assert.deepEqual(await approvals(session), []);
    assert.match(await lastReply(session, coder), /Script failed[\s\S]*A person rejected this in the chat/);

    const privatePath = join(home, "private.txt");
    await session.handleHuman(human("cm4", `@Coder script: text(await tools.write(${JSON.stringify({ path: privatePath, content: "must not run" })}));`));
    assert.equal(existsSync(privatePath), false);
    assert.deepEqual(await approvals(session), []);
    assert.match(await lastReply(session, coder), /Refused \(not approvable\)/);
  });
});

test("permissions: non-code codemode can run empty scripts but cannot call bash or write", async () => {
  await withCoding(async (session, home) => {
    const plain = await createBot(session, "Plain", "post,read");
    const sdk = await session.botSession(plain.pubkey);
    sdk.setActiveToolsByName([...sdk.getActiveToolNames(), "codemode"]);
    await session.handleHuman(human("nc0", "@Plain script: text('no tools');"));
    assert.match(await lastReply(session, plain), /Script completed[\s\S]*no tools/);
    const target = join(home, "..", "non-code.txt");
    for (const [name, input] of [
      ["bash", { command: `echo escaped > ${target}` }],
      ["write", { path: target, content: "escaped" }],
    ] as const) {
      await session.handleHuman(human(`nc-${name}`, `@Plain script: text(await tools.${name}(${JSON.stringify(input)}));`));
      assert.match(await lastReply(session, plain), new RegExp(`Script failed[\\s\\S]*tools\\.${name} does not exist`));
      assert.equal(existsSync(target), false);
      assert.deepEqual(await approvals(session), []);
    }
  });
});

test("approval: tool_search-loaded forwarding tools cannot bypass bash/write gates or non-code exclusions", async () => {
  await withCoding(async (session, home) => {
    const coder = await createBot(session, "Coder", "post,read,code");
    const sdk = await session.botSession(coder.pubkey);
    const ran = join(workspaceDir(testWorkspaces(home), coder.pubkey), "searched.txt");
    const target = join(home, "..", "searched-outside.txt");
    const inputs = {
      bash: { command: "mkdir -p junk && rm -rf junk && echo searched > searched.txt" },
      write: { path: target, content: "approved write" },
    };
    for (const name of ["bash", "write"] as const) {
      const tool = `deferred_${name}`;
      assert.equal(sdk.getActiveToolNames().includes(tool), false);
      await session.handleHuman(human(`search-${name}`, `@Coder tool: tool_search ${JSON.stringify({ query: tool, limit: 1 })}`));
      assert.match(await lastReply(session, coder), /done\[ok\]: Loaded 1 tool/);
      assert.ok(sdk.getActiveToolNames().includes(tool));
      const turn = session.handleHuman(human(`call-${name}`, `@Coder tool: ${tool} ${JSON.stringify(inputs[name])}`));
      const [request] = await waitUntil(async () => {
        const list = await approvals(session);
        return list.length > 0 && list;
      }, `searched ${name} approval`);
      assert.equal(request!.subject, name === "bash" ? inputs.bash.command : target);
      assert.equal(existsSync(ran), false);
      assert.equal(existsSync(target), false);
      await session.handleHuman(human(`answer-${name}`, name === "bash" ? "rejeito" : "aprovo"));
      await turn;
      assert.match(await lastReply(session, coder), name === "bash" ? /done\[error\].*A person rejected/s : /done\[ok\]/);
      assert.deepEqual(await approvals(session), []);
    }
    assert.equal(existsSync(ran), false);
    assert.equal(readFileSync(target, "utf8"), "approved write");

    const plain = await createBot(session, "Plain", "post,read");
    const blocked = join(home, "..", "searched-blocked.txt");
    for (const name of ["bash", "write"] as const) {
      const tool = `deferred_${name}`;
      await session.handleHuman(human(`plain-search-${name}`, `@Plain tool: tool_search ${JSON.stringify({ query: tool, limit: 1 })}`));
      assert.ok((await session.botSession(plain.pubkey)).getActiveToolNames().includes(tool));
      const input = name === "bash" ? { command: `echo escaped > ${blocked}` } : { path: blocked, content: "escaped" };
      await session.handleHuman(human(`plain-call-${name}`, `@Plain tool: ${tool} ${JSON.stringify(input)}`));
      assert.match(await lastReply(session, plain), /done\[error\]/);
      assert.equal(existsSync(blocked), false);
      assert.deepEqual(await approvals(session), []);
    }
  }, undefined, {
    setup: (piDir) => {
      mkdirSync(join(piDir, "extensions"));
      writeFileSync(join(piDir, "extensions", "deferred.js"), `
export default (pi) => {
  for (const name of ["bash", "write"]) {
    pi.registerTool({ name: "deferred_" + name, label: name, description: "Forward to " + name,
      exposure: "deferred", reachesTools: () => [name],
      parameters: name === "bash"
        ? { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
        : { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      execute: async (_id, input, _signal, _update, ctx) => {
        const outcome = await ctx.executeTool(name, input);
        if (outcome.isError) throw new Error(outcome.result.content.map((part) => part.text ?? "").join(""));
        return outcome.result;
      }
    });
  }
};
`);
    },
  });
});

test("approval: a reply to the request message resolves that request", async () => {
  await withCoding(async (session, home) => {
    const coder = await createBot(session, "Coder", "post,read,code");
    const turn = session.handleHuman(human("x1", "@Coder run: git push origin main; echo ran >> pushed.txt"));
    const [request] = await waitUntil(async () => {
      const list = await approvals(session);
      return list.length > 0 && list;
    }, "the approval request");
    await session.handleHuman(human("x2", "sim", { replyTo: [request!.eventId] }));
    await turn;
    // git push fails offline (no repo); what matters is that the call ran once.
    assert.equal(readFileSync(join(workspaceDir(testWorkspaces(home), coder.pubkey), "pushed.txt"), "utf8"), "ran\n");
  });
});

function assertWorkspace(root: string, pubkey: string): void {
  const workspace = workspaceDir(root, pubkey);
  const info = statSync(workspace);
  assert.equal(info.mode & 0o7777, 0o2770);
  assert.equal(info.gid, statSync(root).gid);
  assert.equal(statSync(join(workspace, ".tmp")).mode & 0o7777, 0o2770);
}

function secureFixture(home: string): WorkspaceIsolation {
  const root = testWorkspaces(home);
  mkdirSync(root);
  chmodSync(root, 0o2770);
  const { gid } = statSync(root);
  const probe: IsolationProbe = {
    account: () => ({ uid: 2000, gid, groups: ["yewholt-ws"] }),
    groupId: () => gid,
    daemon: () => ({ uid: 1000, gid: gid + 1, groups: [gid, gid + 1] }),
    sudoWorks: () => true,
    workspaceInfo: (path) => {
      if (!existsSync(path)) return undefined;
      const entry = lstatSync(path);
      return { uid: 2000, gid: entry.gid, mode: entry.mode, isDirectory: () => entry.isDirectory() };
    },
    homeMode: () => 0o750,
    botCanAccessHome: () => false,
    mkdirAsBot: (_user, path) => {
      const previous = process.umask(0o007);
      try {
        mkdirSync(path, { recursive: true });
        return true;
      } finally {
        process.umask(previous);
      }
    },
  };
  return new WorkspaceIsolation(home, { YEWHOLT_WORKSPACES: root }, probe);
}

test("isolation: provisioning a code agent creates the setgid workspace immediately", async () => {
  await withCoding(async (session, home) => {
    const root = testWorkspaces(home);
    const coder = await createBot(session, "New Coder", "post,read,code");
    assert.equal(session.isolationStatus(), "ok");
    assertWorkspace(root, coder.pubkey);
    const plain = await createBot(session, "New Plain", "post,read");
    assert.equal(existsSync(workspaceDir(root, plain.pubkey)), false);
    await createBot(session, "New Plain", "post,read,code");
    assertWorkspace(root, plain.pubkey);
  }, secureFixture);
});

function readyIsolationProbe(): IsolationProbe {
  return {
    account: () => ({ uid: 2000, gid: 3000, groups: ["yewholt-ws"] }),
    groupId: () => 3000,
    daemon: () => ({ uid: 1000, gid: 1000, groups: [1000, 3000] }),
    sudoWorks: () => true,
    workspaceInfo: () => ({ uid: 2000, gid: 3000, mode: 0o2770, isDirectory: () => true }),
    homeMode: () => 0o750,
    botCanAccessHome: () => false,
    mkdirAsBot: () => assert.fail("a failed check must prevent provisioning"),
  };
}

test("isolation: missing bot user permits chat and shares setup only after a refused code tool", async () => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage("Plain chat works."),
    fauxAssistantMessage("Coder chat works."),
    fauxAssistantMessage(fauxToolCall("bash", { command: "touch side-effect" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("I could not run that."),
    fauxAssistantMessage("Coder chat still works."),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const logs: string[] = [];
  await withCoding(async (session, home) => {
    const plain = await createBot(session, "Plain", "post,read");
    const coder = await createBot(session, "Coder", "post,read,code");
    await session.handleHuman(human("plain-chat", "@Plain hello"));
    assert.equal(await lastReply(session, plain), "Plain chat works.");
    await session.handleHuman(human("coder-chat", "@Coder hello"));
    assert.equal(await lastReply(session, coder), "Coder chat works.");

    const status = session.isolationStatus();
    const setup = process.platform === "darwin" ? 'sudo env PATH="$PATH" scripts/setup-bot-user-macos.sh' : "sudo scripts/setup-bot-user.sh";
    assert.equal(status, `Bot user yewholt-bot does not exist. Run ${setup}`);
    await session.handleHuman(human("coder-tool", "@Coder create a file"));
    assert.equal(await lastReply(session, coder), `I could not run that.\n\nCode tools unavailable. ${status}`);
    await session.handleHuman(human("coder-chat-again", "@Coder thanks"));
    assert.equal(await lastReply(session, coder), "Coder chat still works.");

    assert.equal(existsSync(testWorkspaces(home)), false);
    assert.deepEqual(await approvals(session), []);
    assert.deepEqual(logs, ["Code tools unavailable; chat is unaffected. Bot user yewholt-bot does not exist."]);
  }, (home) => {
    const probe = { ...readyIsolationProbe(), account: () => undefined, sudoWorks: () => assert.fail("missing user must not trigger sudo") };
    const isolation = new WorkspaceIsolation(home, { YEWHOLT_WORKSPACES: testWorkspaces(home) }, probe, undefined, (message) => logs.push(message));
    const previous = process.umask();
    try { isolation.start(); } finally { process.umask(previous); }
    return isolation;
  }, { models });
});

test("isolation: each failed check blocks bash, read, write and edit with the status reason", async () => {
  const ready = readyIsolationProbe();
  const cases = [
    [{ account: () => undefined }, /bot user.*does not exist/i],
    [{ account: () => ({ uid: 1000, gid: 3000, groups: ["yewholt-ws"] }) }, /unprivileged/i],
    [{ account: () => ({ uid: 2000, gid: 3000, groups: ["docker"] }) }, /unprivileged/i],
    [{ sudoWorks: () => false }, /sudo -n/i],
    [{ groupId: () => undefined }, /group.*does not exist/i],
    [{ daemon: () => ({ uid: 1000, gid: 1000, groups: [1000] }) }, /daemon process.*group/i],
    [{ workspaceInfo: () => undefined }, /workspaces folder/i],
    [{ workspaceInfo: () => ({ ...ready.workspaceInfo("")!, uid: 42 }) }, /workspaces folder/i],
    [{ workspaceInfo: () => ({ ...ready.workspaceInfo("")!, gid: 42 }) }, /workspaces folder/i],
    [{ workspaceInfo: () => ({ ...ready.workspaceInfo("")!, mode: 0o770 }) }, /workspaces folder/i],
    [{ homeMode: () => 0o751 }, /daemon HOME/i],
    [{ botCanAccessHome: () => true }, /daemon HOME/i],
  ] satisfies Array<[Partial<IsolationProbe>, RegExp]>;
  const probe = { ...ready };
  const logs: string[] = [];
  await withCoding(async (session, home) => {
    Object.assign(probe, cases[0]![0]);
    const coder = await createBot(session, "Blocked Coder", "post,read,code");
    for (const [index, [overrides, reason]] of cases.entries()) {
      Object.assign(probe, ready, overrides);
      const status = session.isolationStatus();
      assert.match(status, reason);
      assert.match(status, /run sudo scripts\/setup-bot-user\.sh/i);
      for (const [tool, request] of Object.entries({ bash: "run: touch side-effect", read: "read: fixture", write: "write: fixture", edit: "edit: fixture" })) {
        await session.handleHuman(human(`denied-${index}-${tool}`, `@Blocked Coder ${request}`));
        const reply = await lastReply(session, coder);
        assert.match(reply, /done\[error\].*Refused/s);
        assert.ok(reply.includes(status), reply);
      }
    }
    assert.equal(existsSync(testWorkspaces(home)), false);
    assert.equal(logs.length, 1);
    assert.deepEqual(await approvals(session), []);
  }, (home) => new WorkspaceIsolation(home, { YEWHOLT_WORKSPACES: testWorkspaces(home) }, probe, undefined, (message) => logs.push(message)));
});

test("approval: only the owner or an admin answers; anyone else's aprovo runs nothing", async () => {
  const ADMIN = "cd".repeat(32);
  await withCoding(async (session, home) => {
    const coder = await createBot(session, "Coder", "post,read,code");
    const ran = join(workspaceDir(testWorkspaces(home), coder.pubkey), "gated.txt");
    const turn = session.handleHuman(human("o1", "@Coder run: rm -rf junk; echo ran >> gated.txt"));
    await waitUntil(async () => (await approvals(session)).length === 1, "the approval request");

    // HUMAN is a channel member but neither the owner nor an admin here.
    await session.handleHuman(human("o2", "aprovo"));
    await session.handleHuman(human("o3", "@Coder sim"));
    assert.equal((await approvals(session)).length, 1);
    assert.equal(existsSync(ran), false);
    assert.match(await lastReply(session, coder), /Only the owner or an admin can answer approval .*still waiting/);

    await session.handleHuman(human("o4", "aprovo", { authorPubkey: ADMIN.toUpperCase() }));
    await turn;
    assert.equal(readFileSync(ran, "utf8"), "ran\n");

    // The install owner's key answers too.
    const second = session.handleHuman(human("o5", "@Coder run: rm -rf junk; echo again >> gated.txt"));
    await waitUntil(async () => (await approvals(session)).length === 1, "the second approval request");
    await session.handleHuman(human("o6", "aprovo", { authorPubkey: ensureOwnerKey(home) }));
    await second;
    assert.equal(readFileSync(ran, "utf8"), "ran\nagain\n");
  }, undefined, { admins: [ADMIN] });
});

test("approval: YEWHOLT_ADMINS takes hex pubkeys separated by commas or spaces and skips the rest", () => {
  const a = "ab".repeat(32);
  const b = "CD".repeat(32);
  assert.deepEqual(parseAdmins(`${a}, ${b}  npub1xyz,short`), [a, b.toLowerCase()]);
  assert.deepEqual(parseAdmins(undefined), []);
});

test("model streams request identity encoding for successful, empty and failed responses", async () => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const headers: unknown[] = [];
  const responses = [
    fauxAssistantMessage("hello"),
    fauxAssistantMessage(""),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid request" }),
  ];
  faux.setResponses(responses.map((response) => (_context, options) => {
    headers.push(options?.headers);
    return response;
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  await withCoding(async (session) => {
    const bot = await createBot(session, "Plain", "post,read");
    await session.handleHuman(human("identity-success", "@Plain hello"));
    assert.equal(await lastReply(session, bot), "hello");
    await session.handleHuman(human("identity-empty", "@Plain hello again"));
    assert.match(await lastReply(session, bot), /empty_answer/);
    await session.handleHuman(human("identity-error", "@Plain try again"));
    assert.match(await lastReply(session, bot), /model_error: 400 invalid request/);
  }, undefined, { models });
  assert.deepEqual(headers, responses.map(() => ({ "Accept-Encoding": "identity" })));
});

test("model failure: the reply says why (reason and provider error), not only that it failed", async () => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const key = "sk-" + "x".repeat(40);
  faux.setResponses(Array.from({ length: 50 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: `429 FreeUsageLimitError: free quota used (key ${key})` })));
  const models = createModels();
  models.setProvider(faux.provider);
  await withCoding(async (session) => {
    const plain = await createBot(session, "Plain", "post,read");
    const coder = await createBot(session, "Coder", "post,read,code");
    await session.handleHuman(human("f1", "@Plain hello"));
    await session.handleHuman(human("f2", "@Coder hello"));
    for (const bot of [plain, coder]) {
      const reply = await lastReply(session, bot);
      assert.match(reply, /^I could not answer that \(model_error: 429 FreeUsageLimitError: free quota used/);
      assert.ok(!reply.includes(key), reply);
    }
  }, undefined, { models });
});

test("model failure: reasons without detail, JSON detail and long detail stay one short line", () => {
  assert.equal(failureReason("no_model"), "no_model");
  assert.equal(failureReason("faulted", { code: 1 }), 'faulted: {"code":1}');
  assert.ok(failureReason("model_error", "a b\n".repeat(400)).length < 320);
});
