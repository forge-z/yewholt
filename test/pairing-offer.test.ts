import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { joinDaemon, joinExitCode, joinMachines, matchingOffers } from "../provider/join.js";
import { loadTarget } from "../provider/target.js";
import { loadConfig } from "../src/config.js";
import { controlEvent, decryptControl, verifiedEnvelope } from "../src/control-protocol.js";
import { DeployControl } from "../src/deploy-control.js";
import { readKey } from "../src/keys.js";
import { generateKeyPair, pubkeyOf } from "../src/nostr.js";
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
    configure: async () => false, running: () => null, log: (line) => log.push(line),
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
