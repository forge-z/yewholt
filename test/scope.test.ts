import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { humanMessageFrom } from "../src/bridge.js";
import { memberChannels } from "../src/membership.js";
import { ensureOwnerKey, Yewholt, type HumanMessage } from "../src/session.js";
import { botEvents, byKind, CODER, INSTALL, PRIVATE, privateListWithoutCoder, RELAY } from "./helpers/fixture.js";

const ELSEWHERE = "33333333-3333-4333-8333-333333333333";

async function withCoder(fn: (session: Yewholt, coderPubkey: string, onboardingPubkey: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "yewholt-scope-"));
  ensureOwnerKey(home);
  const session = await Yewholt.open(new MemoryStorage(), { home, turnTokens: 1000, defaultLimit: 100_000, models: createModels() });
  try {
    await session.ensureOnboarding(INSTALL);
    const human = (eventId: string, text: string): HumanMessage => ({ channelId: INSTALL, authorPubkey: "ab".repeat(32), eventId, text, createdAt: 1_795_231_700 });
    await session.handleHuman(human("c1", "@Onboarding Specialist crie um novo bot chamado Coder com o modelo opencode/deepseek-v4.1-flash"));
    await session.handleHuman(human("c2", "@Onboarding Specialist aprovo"));
    const state = await session.snapshot();
    const coder = state.bots.find((bot) => bot.name === "Coder");
    const onboarding = state.bots.find((bot) => bot.role === "onboarding");
    assert.ok(coder && onboarding);
    assert.deepEqual(coder.scope, [INSTALL]);
    await fn(session, coder.pubkey, onboarding.pubkey);
  } finally {
    await session.close();
    rmSync(home, { recursive: true, force: true });
  }
}

function repliesIn(state: Awaited<ReturnType<Yewholt["snapshot"]>>, pubkey: string, channelId: string) {
  return state.outbox.filter((event) => event.kind === 9 && event.pubkey === pubkey && event.tags.some((tag) => tag[0] === "h" && tag[1] === channelId));
}

test("effective scope: Coder answers the fixture mention in the private channel it was added to", async () => {
  await withCoder(async (session, coder) => {
    const fixtureMessage = byKind(9);
    const message = humanMessageFrom(fixtureMessage);
    assert.ok(message);
    assert.equal(message.channelId, PRIVATE);
    assert.equal(message.text, "@Coder apenas responda ok");

    // Without the relay's member list, the stored scope applies and the private channel is refused.
    await session.handleHuman(message);
    assert.equal(repliesIn(await session.snapshot(), coder, PRIVATE).length, 0);
    assert.ok(!(await session.snapshot()).processed.includes(fixtureMessage.id));

    // The relay's 39002s list the fixture's Coder pubkey; here they are applied to this test's Coder.
    session.setMemberChannels(coder, memberChannels(botEvents(), CODER, RELAY));
    assert.deepEqual(await session.effectiveScope(coder), [INSTALL, PRIVATE]);
    // Stored records are untouched.
    assert.deepEqual((await session.snapshot()).bots.find((bot) => bot.pubkey === coder)?.scope, [INSTALL]);

    await session.handleHuman(message);
    const replies = repliesIn(await session.snapshot(), coder, PRIVATE);
    assert.equal(replies.length, 1);
    const reply = replies[0]!;
    assert.deepEqual(reply.tags[0], ["h", PRIVATE]);
    assert.ok(reply.tags.some((tag) => tag[0] === "auth" && tag[2] === "kind=9"));

    // A channel it is not a member of is still refused.
    await session.handleHuman({ ...message, eventId: "elsewhere-1", channelId: ELSEWHERE });
    assert.equal(repliesIn(await session.snapshot(), coder, ELSEWHERE).length, 0);
  });
});

test("effective scope: removal in the app (newer 39002 without Coder) stops it in that channel", async () => {
  await withCoder(async (session, coder) => {
    session.setMemberChannels(coder, memberChannels([...botEvents(), privateListWithoutCoder()], CODER, RELAY));
    assert.deepEqual(await session.effectiveScope(coder), [INSTALL]);
    const message = humanMessageFrom(byKind(9))!;
    await session.handleHuman(message);
    assert.equal(repliesIn(await session.snapshot(), coder, PRIVATE).length, 0);
    // Still answers in the install channel (stored scope).
    await session.handleHuman({ ...message, eventId: "install-1", channelId: INSTALL });
    assert.equal(repliesIn(await session.snapshot(), coder, INSTALL).length, 1);
  });
});

test("effective scope: a stopped bot does not answer even where it is a member", async () => {
  await withCoder(async (session, coder) => {
    session.setMemberChannels(coder, memberChannels(botEvents(), CODER, RELAY));
    await session.handleHuman({ channelId: INSTALL, authorPubkey: "ab".repeat(32), eventId: "s1", text: "stop bot Coder", createdAt: 1 });
    await session.handleHuman({ channelId: INSTALL, authorPubkey: "ab".repeat(32), eventId: "s2", text: "approve", createdAt: 2 });
    await session.handleHuman(humanMessageFrom(byKind(9))!);
    assert.equal(repliesIn(await session.snapshot(), coder, PRIVATE).length, 0);
  });
});

test("effective scope: the Onboarding Specialist needs a mention in a channel it only joined through the app", async () => {
  await withCoder(async (session, _coder, onboarding) => {
    session.setMemberChannels(onboarding, new Set([PRIVATE]));
    const say = (eventId: string, text: string, channelId: string) => session.handleHuman({ channelId, authorPubkey: "ab".repeat(32), eventId, text, createdAt: 3 });
    await say("p1", "crie um novo bot chamado Teste com o modelo opencode/deepseek-v4.1-flash", INSTALL);
    assert.equal((await session.snapshot()).pending?.name, "Teste");
    // Plain chatter in the private channel that happens to start with "sim" does not approve.
    await say("p2", "sim, vamos almoçar", PRIVATE);
    assert.equal((await session.snapshot()).pending?.name, "Teste");
    // An explicit mention there does.
    await say("p3", "@Onboarding Specialist aprovo", PRIVATE);
    assert.equal((await session.snapshot()).pending, null);
    assert.equal(repliesIn(await session.snapshot(), onboarding, PRIVATE).length, 1);
    // Not a member, not in scope: silent.
    await say("p4", "@Onboarding Specialist help", ELSEWHERE);
    assert.equal(repliesIn(await session.snapshot(), onboarding, ELSEWHERE).length, 0);
  });
});
