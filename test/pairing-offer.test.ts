import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { bridge } from "../provider/bridge.js";
import { addOwnerOfferTargets, joinDaemon, joinExitCode, joinMachines, matchingOffers, updateJoinTarget } from "../provider/join.js";
import { loadTarget, removeTarget } from "../provider/target.js";
import { loadConfig } from "../src/config.js";
import { controlEvent, decryptControl, verifiedEnvelope } from "../src/control-protocol.js";
import { DeployControl } from "../src/deploy-control.js";
import { readKey } from "../src/keys.js";
import { generateKeyPair, ownerAuthTag, pubkeyOf } from "../src/nostr.js";
import { listPairings, readPairing } from "../src/pairing.js";
import {
  OFFER_TAG, daemonProfileEvent, offerKey, pairingProof, readPairingOffer, writePairingOffer,
} from "../src/pairing-offer.js";
import { ownerKeyPath } from "../src/paths.js";
import { parseInvite, type Consent } from "../src/relay-join.js";

const invite = parseInvite("https://buzz.example/invite/test-token");
const consent: Consent = { receipt: "receipt", acceptPolicy: true, confirmAge: true };
const relay = generateKeyPair(), provider = generateKeyPair();

function homes(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "yewholt-offer-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { daemonHome: join(home, "daemon"), targetsHome: join(home, "provider") };
}

function pairRequest(daemon: string, key: string, signer = provider, issuedAt = Date.now()) {
  const requestId = randomUUID();
  return controlEvent(signer.secret, daemon, "pair", { requestId, agentPubkey: daemon },
    { proof: pairingProof(key, signer.pubkey, daemon, requestId), label: "Laptop" }, issuedAt);
}

async function reply(control: DeployControl, event: ReturnType<typeof pairRequest>, signer = provider, paired?: () => Promise<void>) {
  const answer = await control.handle(event, async () => false, { publishProfile: async () => {}, updateName: async () => {},
    reconcileRemoval: async () => {}, paired });
  assert.ok(answer);
  const envelope = verifiedEnvelope(answer, signer.pubkey, "confirmation");
  assert.ok(envelope);
  return decryptControl(envelope, signer.secret, control.pubkey) as { ok: boolean; error?: string };
}

test("VM join initializes a fresh daemon from the invite alone and leaves a pairing offer without the code", async (t) => {
  const { daemonHome, targetsHome } = homes(t), runs: string[][] = [], log: string[] = [];
  let claimedBy: string | undefined;
  const summary = await joinDaemon(invite, {}, async () => "yes", {
    daemonHome, targetsHome, identity: () => { throw Error("must not need a provider key"); },
    relayKey: async () => relay.pubkey, consent: async () => consent,
    claim: async (_invite, _consent, secret) => { claimedBy = pubkeyOf(secret); return "joined"; },
    configure: async () => false, running: () => null, log: (line) => log.push(line), operator: async () => undefined,
    runner: async (_command, args) => { runs.push(args.slice(1)); return ""; },
  });
  assert.equal(joinExitCode(summary), 0);
  const daemon = pubkeyOf(readKey(ownerKeyPath(daemonHome)));
  assert.equal(claimedBy, daemon);
  assert.equal(loadConfig(daemonHome).externalRelayPubkey, relay.pubkey);
  assert.deepEqual(runs, [["start", "--home", daemonHome]]);
  const offer = readPairingOffer(daemonHome);
  assert.equal(offer?.key, offerKey(invite.code, invite.relayUrl));
  assert.ok(!JSON.stringify(offer).includes(invite.code));
  assert.ok(log.some((line) => line.includes("run yh join")));
  assert.equal(readPairingOffer(daemonHome, Date.now() + 25 * 60 * 60 * 1000), undefined);
});

test("only a provider proving the invite pairs, once, and the offer closes", async (t) => {
  const { daemonHome } = homes(t);
  const daemon = generateKeyPair(), stranger = generateKeyPair();
  const control = new DeployControl(daemonHome, daemon.secret, { relayUrl: invite.relayUrl, model: { provider: "test", modelId: "offline", label: "test/offline" } });
  const key = offerKey(invite.code, invite.relayUrl);
  assert.equal((await reply(control, pairRequest(daemon.pubkey, key))).error, "no pairing offer");
  writePairingOffer(daemonHome, invite.code, invite.relayUrl, "vm");
  const wrong = await reply(control, pairRequest(daemon.pubkey, offerKey("other-code", invite.relayUrl), stranger), stranger);
  assert.equal(wrong.error, "invalid pairing proof");
  assert.equal(readPairing(daemonHome, stranger.pubkey), undefined);
  const stale = await reply(control, pairRequest(daemon.pubkey, key, provider, Date.now() - 60_000));
  assert.equal(stale.error, "pairing request outside offer window");
  let notified = 0;
  const ok = await reply(control, pairRequest(daemon.pubkey, key), provider, async () => { notified++; });
  assert.equal(ok.ok, true);
  assert.equal(notified, 1);
  assert.equal(readPairing(daemonHome, provider.pubkey)?.label, "Laptop");
  assert.equal(readPairingOffer(daemonHome), undefined);
  assert.equal((await reply(control, pairRequest(daemon.pubkey, key))).ok, true);
  const late = await reply(control, pairRequest(daemon.pubkey, key, stranger), stranger);
  assert.equal(late.error, "no pairing offer");
  assert.equal(listPairings(daemonHome).length, 1);
});

test("offers match only the newest signed member profile carrying the invite-bound tag", () => {
  const daemon = generateKeyPair(), outsider = generateKeyPair(), other = generateKeyPair();
  const key = offerKey(invite.code, invite.relayUrl);
  const offer = { key, relayUrl: invite.relayUrl, label: "vm", createdAt: 0, expiresAt: Date.now() + 1000 };
  const otherOffer = { ...offer, key: offerKey("other", invite.relayUrl) };
  const tagged = daemonProfileEvent(daemon.secret, daemon.pubkey, "build-vm", offer, 100);
  assert.deepEqual(tagged.tags[0][0], OFFER_TAG);
  assert.ok(!JSON.stringify(tagged).includes(invite.code));
  const members = new Set([daemon.pubkey, other.pubkey]);
  assert.deepEqual(matchingOffers([tagged, daemonProfileEvent(outsider.secret, outsider.pubkey, "x", offer, 100),
    daemonProfileEvent(other.secret, other.pubkey, "y", otherOffer, 100)], members, key), [{ daemon: daemon.pubkey, label: "build-vm" }]);
  assert.deepEqual(matchingOffers([tagged, daemonProfileEvent(daemon.secret, daemon.pubkey, "build-vm", undefined, 101)], members, key), []);
  const forged = { ...tagged, content: JSON.stringify({ name: "forged" }) };
  assert.deepEqual(matchingOffers([forged], members, key), []);
});

test("Mac join pairs every VM that offered the invite and adds its target without SSH", async (t) => {
  const paths = homes(t), daemon = generateKeyPair(), offline = generateKeyPair();
  const key = offerKey(invite.code, invite.relayUrl);
  const requests: string[] = [];
  const summary = await joinMachines(invite, [], {}, async () => "yes", {
    ...paths, identity: () => provider.secret, consent: async () => consent, claim: async () => "joined", log: () => {},
    runner: async () => { throw Error("must not need SSH"); },
    members: async () => new Set([daemon.pubkey, offline.pubkey]),
    offers: async (_relay, _secret, offered) => {
      assert.equal(offered, key);
      return [{ daemon: daemon.pubkey, label: "build-vm" }, { daemon: offline.pubkey, label: "sleepy" }];
    },
    pair: async (relayUrl, target, secret, event, requestId) => {
      assert.equal(relayUrl, invite.relayUrl);
      assert.equal(secret, provider.secret);
      requests.push(target);
      const envelope = verifiedEnvelope(event, target, "pair");
      assert.equal(envelope?.requestId, requestId);
      return { result: target === daemon.pubkey ? "confirmed" : "timeout" };
    },
    checkModels: async () => ({ ok: true, message: "Models available." }),
  });
  assert.deepEqual(requests, [daemon.pubkey, offline.pubkey]);
  assert.equal(summary[1].reason, undefined);
  assert.deepEqual(summary.map(({ machine, status }) => [machine, status]),
    [["Mac provider", "joined"], ["build-vm", "joined"], ["sleepy", "failed"]]);
  const target = loadTarget("build-vm", paths.targetsHome);
  assert.deepEqual([target.label, target.relay, target.daemonPubkey, target.ssh], ["build-vm", invite.relayUrl, daemon.pubkey, undefined]);
  assert.ok(!existsSync(join(paths.targetsHome, "targets", "sleepy.json")));
});

const operator = generateKeyPair();

function activation(daemon: string, agent: ReturnType<typeof generateKeyPair>, signer = provider,
  { owner = operator, nsec = agent.secret, issuedAt = Date.now() } = {}) {
  const authTag = ownerAuthTag(owner.secret, agent.pubkey);
  return controlEvent(signer.secret, daemon, "hosted-activate", { requestId: randomUUID(), agentPubkey: agent.pubkey },
    { community: invite.relayUrl, owner: owner.pubkey, authTag, agent: { name: "agent", nsec, authTag } }, issuedAt);
}

test("VM join run by the relay operator needs no Mac step, and a rerun spends no invite use", async (t) => {
  const { daemonHome, targetsHome } = homes(t), log: string[] = [];
  let claims = 0, consents = 0, member = false;
  const run = () => joinDaemon(invite, {}, async () => "yes", {
    daemonHome, targetsHome, relayKey: async () => relay.pubkey, operator: async (origin, secret) => {
      assert.equal(origin, invite.origin);
      assert.equal(secret, readKey(ownerKeyPath(daemonHome)));
      assert.ok(claims > 0);
      return operator.pubkey;
    },
    consent: async () => { consents++; return consent; }, claim: async () => { claims++; return "joined"; },
    members: async (_relay, secret) => new Set(member ? [pubkeyOf(secret)] : []),
    configure: async () => false, running: () => null, log: (line) => log.push(line), runner: async () => "",
  });
  assert.equal(joinExitCode(await run()), 0);
  assert.equal(readPairingOffer(daemonHome)?.owner, operator.pubkey);
  assert.ok(log.some((line) => line.includes("create a Yewholt agent")));
  assert.ok(!log.some((line) => line.includes("yh join")));
  member = true;
  assert.deepEqual(await run(), [{ machine: "This daemon", status: "already_member" }]);
  assert.deepEqual([claims, consents], [1, 1]);
});

test("the first agent the relay operator activates pairs its provider; replayed or foreign signatures do not", async (t) => {
  const { daemonHome } = homes(t);
  const daemon = generateKeyPair(), stranger = generateKeyPair(), agent = generateKeyPair();
  const control = new DeployControl(daemonHome, daemon.secret, { relayUrl: invite.relayUrl, model: { provider: "test", modelId: "offline", label: "test/offline" } });
  const send = (event: ReturnType<typeof activation>, signer = provider, paired?: () => Promise<void>) =>
    reply(control, event as ReturnType<typeof pairRequest>, signer, paired);
  assert.equal((await send(activation(daemon.pubkey, agent))).error, "provider not paired");
  writePairingOffer(daemonHome, invite.code, invite.relayUrl, "vm", Date.now() - 1000, operator.pubkey);
  assert.equal((await send(activation(daemon.pubkey, agent, stranger, { owner: stranger }), stranger)).error, "provider not paired");
  assert.equal((await send(activation(daemon.pubkey, agent, stranger, { nsec: stranger.secret }), stranger)).error, "provider not paired");
  assert.equal((await send(activation(daemon.pubkey, agent, provider, { issuedAt: Date.now() - 60_000 }))).error, "provider not paired");
  assert.equal(listPairings(daemonHome).length, 0);
  let notified = 0;
  await send(activation(daemon.pubkey, agent), provider, async () => { notified++; });
  assert.equal(notified, 1);
  assert.ok(readPairing(daemonHome, provider.pubkey));
  assert.equal(readPairingOffer(daemonHome), undefined);
  assert.equal((await send(activation(daemon.pubkey, generateKeyPair(), stranger), stranger)).error, "provider not paired");
  assert.equal(listPairings(daemonHome).length, 1);
});

test("the Mac lists VMs offering to the relay operator as targets", async (t) => {
  const { targetsHome } = homes(t);
  const vm = generateKeyPair(), other = generateKeyPair(), closed = generateKeyPair();
  const offer = { key: offerKey("x", invite.relayUrl), relayUrl: invite.relayUrl, label: "vm", createdAt: 0, expiresAt: Date.now() + 1000 };
  const events = [daemonProfileEvent(vm.secret, vm.pubkey, "build-vm", { ...offer, owner: operator.pubkey }),
    daemonProfileEvent(other.secret, other.pubkey, "other-vm", { ...offer, owner: other.pubkey }),
    daemonProfileEvent(closed.secret, closed.pubkey, "closed-vm")];
  const deps = { operator: async (origin: string, secret: string) => {
    assert.equal(origin, invite.origin);
    assert.equal(secret, provider.secret);
    return operator.pubkey;
  }, members: async () => new Set([vm.pubkey, other.pubkey, closed.pubkey]),
    profiles: async () => events };
  assert.deepEqual(await addOwnerOfferTargets(invite.relayUrl, provider.secret, targetsHome, deps), ["build-vm"]);
  assert.deepEqual([loadTarget("build-vm", targetsHome).daemonPubkey, loadTarget("build-vm", targetsHome).relay], [vm.pubkey, invite.relayUrl]);
  assert.deepEqual(await addOwnerOfferTargets(invite.relayUrl, provider.secret, targetsHome, deps), []);
  assert.deepEqual(await addOwnerOfferTargets(invite.relayUrl, provider.secret, targetsHome, { ...deps, operator: async () => undefined }), []);
});

test("the selector hides former members without confusing daemons with the same hostname", async (t) => {
  const { targetsHome } = homes(t);
  const previousHome = process.env.YEWHOLT_PROVIDER_HOME, previousStorage = process.env.YEWHOLT_PROVIDER_FILE_STORAGE;
  process.env.YEWHOLT_PROVIDER_HOME = targetsHome;
  process.env.YEWHOLT_PROVIDER_FILE_STORAGE = "1";
  t.after(() => {
    if (previousHome === undefined) delete process.env.YEWHOLT_PROVIDER_HOME;
    else process.env.YEWHOLT_PROVIDER_HOME = previousHome;
    if (previousStorage === undefined) delete process.env.YEWHOLT_PROVIDER_FILE_STORAGE;
    else process.env.YEWHOLT_PROVIDER_FILE_STORAGE = previousStorage;
  });
  const old = generateKeyPair(), vm = generateKeyPair(), departed = generateKeyPair();
  const community = invite.relayUrl;
  const otherRelay = "wss://other.example";
  const targets: Parameters<typeof updateJoinTarget>[1] = [];
  updateJoinTarget(targetsHome, targets, old.pubkey, [community], "build-vm", "build-vm");
  updateJoinTarget(targetsHome, targets, departed.pubkey, [otherRelay, community], "departed", "Departed");
  const offer = { key: offerKey("x", community), relayUrl: community, label: "build-vm",
    createdAt: Date.now(), expiresAt: Date.now() + 60_000, owner: operator.pubkey };
  const members = async () => new Set([vm.pubkey]);
  const deps = { operator: async () => operator.pubkey, members, profiles: async () => [
    daemonProfileEvent(old.secret, old.pubkey, "build-vm"), daemonProfileEvent(vm.secret, vm.pubkey, undefined, offer),
  ] };
  const list = (overrides = deps) => bridge({ op: "targets", community: community + "/" }, undefined,
    (relay, secret, report) => addOwnerOfferTargets(relay, secret, targetsHome, overrides, report), async () => {});
  assert.deepEqual(await list(), { ok: true, targets: ["build-vm-2"] });
  assert.equal(loadTarget("build-vm", targetsHome).daemonPubkey, old.pubkey);
  assert.equal(loadTarget("build-vm-2", targetsHome).daemonPubkey, vm.pubkey);
  assert.deepEqual(await list({ ...deps, members: async () => { throw Error("no roster"); } }),
    { ok: true, targets: ["build-vm", "build-vm-2", "departed"] });
  assert.deepEqual(removeTarget("build-vm", old.pubkey, targetsHome), { state: "removed" });
  assert.deepEqual(await list(), { ok: true, targets: ["build-vm-2"] });
});

test("a Mac provider already in the community pairs with the VM without spending the invite", async (t) => {
  const paths = homes(t), daemon = generateKeyPair();
  let claims = 0, consents = 0;
  const summary = await joinMachines(invite, [], {}, async () => "yes", {
    ...paths, identity: () => provider.secret, log: () => {},
    consent: async () => { consents++; return consent; }, claim: async () => { claims++; return "joined"; },
    members: async () => new Set([provider.pubkey, daemon.pubkey]),
    offers: async () => [{ daemon: daemon.pubkey, label: "build-vm" }],
    pair: async () => ({ result: "confirmed" }),
    checkModels: async () => ({ ok: true, message: "Models available." }),
  });
  assert.deepEqual(summary.map(({ machine, status }) => [machine, status]), [["Mac provider", "already_member"], ["build-vm", "joined"]]);
  assert.deepEqual([claims, consents], [0, 0]);
});

test("while the operator's offer is open, the provider can read the model catalog before the activation that pairs it", async (t) => {
  const { daemonHome } = homes(t);
  const daemon = generateKeyPair();
  const control = new DeployControl(daemonHome, daemon.secret, { relayUrl: invite.relayUrl, model: { provider: "test", modelId: "offline", label: "test/offline" } });
  const catalog = async () => {
    const event = controlEvent(provider.secret, daemon.pubkey, "hosted-models", { requestId: randomUUID(), agentPubkey: daemon.pubkey }, { offset: 0 });
    const answer = await control.handle(event, async () => false, { publishProfile: async () => {}, updateName: async () => {},
      reconcileRemoval: async () => {}, models: () => ["test/offline"] });
    assert.ok(answer);
    const envelope = verifiedEnvelope(answer, provider.pubkey, "confirmation");
    assert.ok(envelope);
    return decryptControl(envelope, provider.secret, control.pubkey) as { ok: boolean; error?: string; catalog?: { models: string[] } };
  };
  assert.equal((await catalog()).error, "provider not paired");
  writePairingOffer(daemonHome, invite.code, "wss://other.example", "vm", Date.now() - 1000, operator.pubkey);
  assert.equal((await catalog()).error, "provider not paired");
  writePairingOffer(daemonHome, invite.code, invite.relayUrl, "vm", Date.now() - 1000);
  assert.equal((await catalog()).error, "provider not paired");
  writePairingOffer(daemonHome, invite.code, invite.relayUrl, "vm", Date.now() - 1000, operator.pubkey);
  assert.deepEqual((await catalog()).catalog?.models, ["test/offline"]);
  assert.equal(listPairings(daemonHome).length, 0);
  await reply(control, activation(daemon.pubkey, generateKeyPair()) as ReturnType<typeof pairRequest>);
  assert.ok(readPairing(daemonHome, provider.pubkey));
  assert.deepEqual((await catalog()).catalog?.models, ["test/offline"]);
});
