# Yewholt

**Yewholt: a pi coding harness, and durable agents on Buzz.**

Yewholt has two roles:

1. **Coding harness.** Type `yh` in any directory and it opens an interactive [pi](https://pi.dev) coding-agent session there. It is the same harness as the `pi` CLI and loads the same pi packages (extensions, skills, prompt templates, themes). `yewholt` is an alias. See [Harness](#harness).
2. **Durable agents on Buzz.** The headless daemon runs on a Linux VM or natively on the Mac and connects to an existing [Buzz](https://github.com/block/buzz) relay. The Mac runs the Buzz app with the Yewholt plugin and bridge; a Mac-local daemon needs no Docker or local relay.

Calendar, email, MCP, cron, memory, kanban, and browser tools are out of core. They belong in later Buzz plugins.

## Agent-first setup

Give your coding agent [the installation skill](skills/install/SKILL.md) and
the SSH aliases and Buzz relay for the VMs you want to use. The agent sets up
`yh`, the Mac bridge, and a daemon on each VM. The relay administrator must
admit the daemon and provider identities; approve the plugin in Buzz when
prompted. Then use **Harness → Remote → Yewholt** to create an agent and choose
a model.

For the Mac coding CLI alone, build a checkout with Node.js 22.19+:

```sh
npm ci
npm run build
npm link
yh
```

The first run opens pi in the current directory. Use pi's `/login` and
`/model` for the local harness; VM credentials are configured separately.

## Updating

```sh
yh update [--home dir] [--archive <tar file>]
```

Run `yh update` on the Mac and each daemon VM. It updates the checkout of the
running CLI (not the current directory) with `git pull --ff-only`, removes old
`dist` output, runs `npm ci` and `npm run build`, and refreshes the Buzz bridge
if installed. A running daemon for `--home` (default `$YEWHOLT_HOME` or
`~/.yewholt`) is restarted with the new build; a stopped daemon stays stopped.
The relay is never touched. The update stops at the first failed command with
that command's exit code.

On a VM without git/GitHub, such as Instabox, transfer a `git archive` tarball
and run `yh update --archive /path/to/yewholt.tar [--home dir]`. The tarball is
extracted over the existing checkout before the same build and refresh steps.

## Harness

```bash
cd ~/src/some-project
yewholt                       # interactive pi session on this directory
yewholt code -p "summarise this repo"
yewholt code --model anthropic/claude-sonnet-5
yewholt code --help           # every harness flag
```

`yewholt` with no arguments opens the harness in the current directory. `yewholt code [args...]` forwards every following argument to it unchanged, so any `pi` flag or subcommand works after `code` (`yewholt code install <source>`, `yewholt code --version`).

Yewholt calls the public `main()` export of `@earendil-works/pi-coding-agent`, the function the `pi` bin runs. It does not ship its own TUI or spawn a `pi` binary. Settings, sessions, and pi packages come from the same `~/.pi/agent` directory as `pi`, so anything installed with `pi install` is available in `yewholt`, and the other way round.

Yewholt adds two defaults and nothing else:

- `$YEWHOLT_HOME/.env` (default `~/.yewholt/.env`) is loaded before Pi starts. A variable already set in the shell wins over the file. API keys saved by Pi login also work in the daemon (see [Provider keys on the host](#provider-keys-on-the-host)).
- If `YEWHOLT_MODEL` is set and you pass no `--model`, Yewholt passes `--model $YEWHOLT_MODEL`. A `--model` on the command line wins. Pi subcommands such as `install` or `config` get no default model.

`--home` is not read in harness mode; set `YEWHOLT_HOME` to point at another state directory.

## Architecture

```text
Buzz app (Mac/iOS) ──WebSocket──► stock buzz-relay (unmodified)
                                       ▲
yewholt daemon ──NIP-42 client─────────┘
      │
      └─ one @earendil-works/pi-durable harness
            SQLite store, one conversation per bot
```

- **Relay.** An existing, unmodified Buzz relay run by its administrator. Yewholt does not install, start, or stop it; `yh install` records its URL and public key.
- **Daemon.** A Node process. It opens one pi-durable `Harness` on a SQLite file and calls `resume()` after every start, so a crashed run continues from the last committed step.
- **Bot.** One ownerless pi-durable conversation (its own instructions, model, and transcript) plus its own Nostr key.
- **Bridge.** The daemon authenticates to the relay with NIP-42, like any other client. It reads kind 9 channel messages and publishes kind 9 replies, kind 0 profiles, and the membership events below. It does not embed the relay.
- **Buzz agent provisioning.** `src/agents.ts` reads and validates provider-written files for agents created in the Buzz desktop app. The daemon reconciles those files with the durable bot registry and publishes the agents' runtime profile and presence.

### What the wire uses

| Event | Role |
|---|---|
| kind 22242 | NIP-42 AUTH. Agents also send a NIP-OA `auth` tag so NIP-AA can admit them while membership is required. |
| kind 9007 | Create the `yewholt` stream channel (`h`, `name`, `visibility=open`, `channel_type=stream`), matching `buzz-sdk` `build_create_channel`. |
| kind 9030 | Relay owner adds the bot's pubkey to the NIP-43 member list. |
| kind 9000 | Add the bot to the channel with `role=bot`, matching `build_add_members`. |
| kind 0 | Profile (`display_name`) with one NIP-OA `auth` tag `kind=0`, which is how Buzz treats the pubkey as an agent. |
| kind 9 | Channel chat. Replies carry an `h` tag and a NIP-OA `auth` tag `kind=9`. |
| kind 30175 | Owner-signed persona (`d` slug, `display_name`, `runtime=yewholt`, model, provider). |
| kind 30177 | Owner-signed managed agent (`d` = agent pubkey, `persona_id`, `name`, `respond_to`). |
| kind 39002 | Read only. Relay-signed channel member list (`d` = channel id, `["p", pubkey, "", role]`). Each bot follows the lists that name it; see [Channels and scope](#channels-and-scope). |

Kind 10100 is named `KIND_AGENT_PROFILE` in `buzz-core` but no NIP in the repo documents its content, so Yewholt does not emit it.

The information-flow broker in `docs/practical-information-flow-for-buzz-agents.md` is a draft. The relay does not implement it. Yewholt holds each bot key on disk and signs as that bot, which is what a normal client does today.

## Requirements

- Node.js 22.19 or newer (pi-durable's engine).
- An existing Buzz relay that admits the daemon's pubkey. Tests do not need one.
- No API key is required. Keys are optional and are read from the environment only when a session calls a model.

## Daemon install

On the Linux VM, with the relay URL and the relay's public key (the key it signs kind 39002 member lists with):

```bash
npm ci
npm run build
npm link
yh install --relay wss://relay.example --relay-pubkey <relay pubkey>
yh start
yh status
```

`install` writes `~/.yewholt` (override with `--home` or `YEWHOLT_HOME`) and prints the daemon pubkey for the relay administrator to admit:

- `config.json` with the relay URL and public key
- `secrets/owner.key`, mode `0600`, the daemon's identity
- `.env`, mode `0600`, for host configuration and provider keys
- `state/sessions.sqlite`, the pi-durable store

`start`, `stop`, and `status` manage only the daemon; the relay is run and upgraded by whoever administers it. Running `install` again on the same home with the same relay is a no-op.

### Serve another Buzz community from the same daemon

Keep the installed primary relay and add the community's relay and its kind
39002 signing key. The same daemon identity is used on both relays, but
admission and provider pairings are separate for each community:

```sh
yh relay join --relay-pubkey <shared-relay-signing-pubkey>
yh relay list
yh pair add <provider-pubkey> --label "My Mac" --relay wss://shared.communities.buzz.xyz
yh stop
yh start
```

Ask the community owner/admin for a Buzz invite (**Settings → Community
admin → Membership → Invite**). Paste the link when prompted. `relay join`
claims it as the daemon and adds the relay only after Buzz confirms admission.
Omit `--relay-pubkey` when the relay is already configured. The human
creating agents must also be a member.
Existing single-relay homes and pairings keep working without migration
commands. Omitting `--relay` from `pair add/list/remove` operates on the
primary relay. Relay configuration changes take effect at daemon restart;
pairing changes are read live. Use `yh status` to see which configured
relays the daemon has authenticated to.

On the Mac, rebuild and rerun `yh provider install` and update the Yewholt
plugin in Buzz from the folder it prints. Run `yh provider join` and paste an
invite for the provider identity, then update the remote target
with all its relay URLs; preserve its target ID, daemon pubkey, label
and any wake options:

```sh
yh targets add my-vm --relay wss://relay.example --relay wss://shared.communities.buzz.xyz --daemon <daemon-pubkey> --label "My VM"
```

To host agents from the Mac in that same community, run the daemon-side
relay commands against the Mac daemon home (or use `yh install --relay`
for a fresh home that only needs that community, then `yh relay join`).
Rerun `yh targets add my-mac --local` to register its configured relays and
pair the local provider on each one. While Buzz stays open on the shared community, choose
either target when creating an agent. Models, agent activation and chat use
the selected community's relay; existing agents remain on their original relay.

Both join commands accept an HTTPS invite page or a `buzz://join` link.
Paste at the prompt or supply the link on the first line of stdin to keep
the invite token out of shell history. When the community has a join policy,
review the displayed terms and explicitly accept them and any required age
attestation. For non-interactive use, pass `--accept-policy` only after
reviewing the current policy and `--confirm-age` only if the required age
attestation is true, for example:

```sh
yh provider join --accept-policy --confirm-age < /path/to/private-invite-file
```

Each newly admitted identity consumes one use. Use a separate link per key if
**Max uses** is 1, or reuse a link with enough uses for all keys. If the
administrator admits the keys directly instead, use `yh relay add` to
configure the extra relay; the provider needs no join command.

### A relay that an earlier `yewholt install` started

Earlier releases started a bundled Buzz relay next to the daemon and kept it in `$YEWHOLT_HOME/relay/` (its `.env`, a copy of its compose file, and the data volumes it names). Yewholt no longer starts or stops that relay, but leaves the directory alone, so an existing relay keeps running and keeps its data. To keep using the daemon in that home, record the relay as an external one:

```bash
yh install --home /data/home/.yewholt --relay wss://<public relay host>
```

Without `--relay-pubkey`, `install` derives the public key from `BUZZ_RELAY_PRIVATE_KEY` in `relay/.env`; the secret is never printed. Maintain that relay from its own directory, as a plain Buzz single-node deployment (for example `docker compose ps`, `docker compose pull && docker compose up -d`, run in `$YEWHOLT_HOME/relay`), following Buzz's `deploy/compose` README. Keep backing up `relay/.env` with `secrets/`: it holds the relay's identity. On an InstaBox VM that uses the Host-rewriting proxy, keep that layout as described in [InstaBox relay proxy](#instabox-relay-proxy).

### Chat

Agents are created in the Buzz desktop app (see [Buzz 1.0.6: Yewholt remote agents](#buzz-106-yewholt-remote-agents)) and provisioned to the daemon. Mention an agent by name or pubkey to talk to it; in a direct message it follows its `respondTo` setting.

Permissions that the daemon honors are `post` (publish kind 9), `read` (the message is shown to that session), and `code` (the agent becomes a coding agent, see [Coding bots](#coding-bots-code)). Other tokens are stored and shown back; they do not grant extra tools.

A model label is mapped to a pi-ai `provider/modelId`. pi-ai will call it only when that provider and id exist in the catalog and the matching API key is set. Until then the session still exists, keeps its history, and says so when mentioned.

When a model turn ends without an answer, the bot says why instead of a bare failure, for example `I could not answer that (model_error: 429 FreeUsageLimitError: ...).` or `I could not answer that (no_model).` The reason is pi-durable's settlement reason, and the detail is the provider's error text, flattened to one line, cut at 300 characters, with token-like runs of 32+ characters shown as `[redacted]`. The daemon logs the same line with the bot name and model.

Agents answer only when mentioned, and only while they are `active`. This holds in every channel an agent is a member of, see below.

### Channels and scope

A bot answers in every channel it is currently a member of, including private channels. Adding the bot to a channel from the Buzz app is the approval; removing it there stops it in that channel. Nothing else changes: the mention rules above still apply, a stopped bot stays silent, and the `post`/`read` permissions still decide what it may do.

How the daemon does it:

- While the daemon runs, each active bot keeps its own connection, signed with its own key plus the owner's NIP-OA `auth` tag. The owner key cannot read private channels it is not in (the relay answers `CLOSED … restricted: not a channel member`), so each bot reads with its own key.
- Each bot subscribes to kind 39002 with `#p` = its pubkey, plus `#d` = the channels it is in so the newer list that drops it is seen too. Only lists signed by that relay's key count; that key is set by `yh install` for the primary relay or `yh relay add` for an additional relay. Per channel, only the newest list counts. Kind 9000/9001 events alone are not trusted.
- A bot's effective scope is its stored scope plus the channels those lists name. Stored records are not changed. `yewholt status` (`status.json`) shows both as `scope` and `channels`.
- Each bot subscribes to kind 9 once per effective channel and re-subscribes when the set changes. A message seen on several connections is handled once. The channel is taken from the message's `h` tag. Replies go out on the replying bot's own connection, into that same channel.
- Provisioning or reactivating an agent opens its connection; `!shutdown` or removing its file closes it. Disconnections are retried independently for each relay.

### Agents created in the Buzz desktop app

The Buzz desktop app creates and owns these agents. Its backend provider runs on the owner's Mac and writes one file over SSH to `$YEWHOLT_HOME/agents/<agent-pubkey>.json` on the daemon host. The provider sets mode `0600` and replaces the file atomically. The provider holds the agent's `nsec` by design because it provisions the runtime that signs as that agent. Yewholt loads that key from the provisioning file into memory and keeps it out of the bot registry, status output, and agent key files.

| Field | Value |
|---|---|
| `name` | Required nonempty agent name. |
| `nsec` | Required agent secret key as 64 lowercase hex digits. Its public key must match the filename. |
| `authTag` | Required `["auth", "<owner pubkey>", "<conditions>", "<Schnorr signature>"]`. The owner's key must differ from the agent's. The signature covers `sha256("nostr:agent-auth:<agent pubkey>:<conditions>")`. |
| `relayUrl` | One of the daemon's configured WebSocket relays. Defaults to the primary relay. Do not change the relay of an existing agent identity. |
| `model` | Object with `provider`, `modelId`, and `label`. Defaults to the daemon model configured by `YEWHOLT_MODEL`. |
| `permissions` | String array. Defaults to `["post", "read"]`. Add `"code"` to give the agent the coding tools and workspace described below. |
| `respondTo` | DM response policy. Defaults to `"anyone"`. |
| `respondToAllowlist` | Array of lowercase hex user public keys for the `"allowlist"` policy. Defaults to `[]`. |
| `channelId` | Optional first channel. Relay membership adds channels to this starting scope. |

Buzz publishes the kind 0 profile with its NIP-OA tag, kind 30175 persona, kind 30177 registration, and kind 9030 and 9000 membership events. Yewholt signs in as the agent with the supplied auth tag and publishes its kind 10100 runtime profile, kind 20001 presence, and kind 9 replies. It sends the profile and online presence after connecting, then refreshes them every 10 minutes and 60 seconds, respectively.

Yewholt recognizes a DM when the newest trusted kind 39002 member list contains exactly two distinct members. An external agent can answer a human DM without a mention. The `anyone` policy accepts any human sender, `allowlist` accepts listed public keys, and other policies refuse the DM. In a group channel, address the agent with an `@mention`. Daemon-created member bots still require an `@mention` in every channel.

The Buzz owner can stop an external agent with a message containing exactly `!shutdown` after trimming whitespace. Yewholt queues offline presence and closes the agent's subscriptions. The provider can restart it by replacing the file with a valid copy whose modification time is newer than the stop. A removed file retires the durable record and triggers offline presence when the daemon has the loaded key. Run `yewholt status` or read `status.json` to see each agent's active, stopped, retired, or invalid state.

#### Multi-VM control channel (Phase 0)

**Use kind 1059 for the next phase.** In the [Phase 0 spike](https://github.com/forge-z/yewholt/issues/9),
the stock local Buzz relay (`ghcr.io/block/buzz:0.3.0`, relay membership required) stored the wrap published
while the daemon key was disconnected. A fresh connection using that key got the event before `EOSE`
with a `kinds` + `#p` filter, verified the signatures, and decrypted the deploy fixture. This spike does
not change the provisioning path above.

| Kind | Publish `OK` on an admitted socket | Fresh recipient subscription | Other admitted key, same filter |
| --- | --- | --- | --- |
| 30079 (`d` = agent pubkey) | `false`, `restricted: unknown event kind` | `EOSE`, 0 events | `EOSE`, 0 events |
| 1059 (gift-wrap carrier) | `true`, empty message | `EOSE`, 1 event, decrypted | `CLOSED: restricted: p-gated events require #p matching your pubkey` |
| 4 (custom payload and `t` tag) | `false`, `restricted: unknown event kind` | `EOSE`, 0 events | `EOSE`, 0 events |

A second, newer 30079 from the same author with the same `d` received the same rejection; the
relay returned neither event, so addressable replacement was not available. Kind 1059 is not
addressable; this result does not provide deploy deduplication or replacement.

An unknown publisher and the intended recipient without delegation both got
`restricted: not a relay member` on NIP-42 AUTH. The intended recipient and the unrelated
reader were both admitted with NIP-OA delegation for the reads above. Without AUTH, all three
publish probes returned `OK false` and all three subscriptions returned `CLOSED`, both with
`auth-required: not authenticated`. The 1059 outer signer could be a fresh key because the
publishing **connection** was authenticated as the relay owner; this does not prove a
non-member provider can publish on its own connection.

The sample 1059 has a fresh outer signing key and an encrypted, provider-signed inner event.
It uses secp256k1 ECDH, HKDF-SHA256, and AES-256-GCM with the agent pubkey and request ID as AAD.
Those two values are visible in the sample envelope so a fresh recipient can decrypt without
prior request state. This is a relay carrier test, not a NIP-44/NIP-59 interoperability claim
or a production wire format. Replay was measured after client reconnect, not across relay
restarts, at any particular retention interval, or against a production Buzz deployment.

To rerun, use a disposable loopback Buzz relay on `ws://127.0.0.1:13000` (Buzz's `deploy/compose`
bundle works) with a throwaway owner key in `$spike_home/owner.key`, and set
`YEWHOLT_RELAY_PUBKEY` to that relay's public key for the scripts below. Never point them at
an existing community. Remove the relay and `$spike_home` afterward.

#### Multi-VM daemon provisioning (Phase 1)

The daemon now accepts encrypted provisioning from a paired provider through the Buzz
relay, without SSH or an inbound daemon port. The macOS provider and target management
are separate phases. The provider is trusted code: it receives the agent's private key
by design and can provision or replace agents on each daemon that pairs with it.

```sh
yewholt admin keys                                 # use this daemon's owner pubkey as daemonPubkey
yewholt pair add <providerPubkey> --label "My Mac"
yewholt pair list
yewholt pair remove <providerPubkey>
yewholt agents list
```

The daemon uses its existing install owner key as its control identity. Use a distinct
install key per daemon on a shared relay. Both daemon and provider connections must
authenticate via NIP-42 and be admitted to the relay: register their public keys as
members using the relay's member administration, or use NIP-OA delegation from an
admitted owner where the relay allows it (as the local test below does for the provider).
Admission to the relay does **not** grant deploy permission. Pair entries are local to
`$YEWHOLT_HOME/state/pairings/<provider-pubkey>.json`, never editable via chat, and
an empty list refuses all deploys. Pair changes take effect without restarting;
removing a key does not stop its existing agents.

`agents list` reads the daemon's last status snapshot and shows only external agents,
their state, the local target pubkey, and the last applied control deploy time (null
for provisioned files not installed by the control channel). The snapshot can be stale
while the daemon is stopped.

**Wire protocol v1.** Both directions use kind `1059`, with
`["p","<recipient pubkey>"]` and `["t","yewholt-control"]`. This is a Yewholt
protocol carried by a Buzz kind, not NIP-44 or NIP-59. Unlike the Phase 0 transport
probe, the designated sender signs the outer event directly, so the daemon can verify
the provider signature and inspect the pairing **before** decrypting the request.
The signed content is a JSON envelope:

```json
{"version":1,"type":"deploy","issuedAt":1795274778000,"agentPubkey":"<64 lowercase hex>","requestId":"<lowercase UUID>","ciphertext":"<base64>"}
```

- `issuedAt` is Unix milliseconds and `created_at` is the same time in whole
  seconds. Use synchronized clocks. Requests before the current pairing or more than
  60 seconds in the future are denied. Newer requests for an agent take precedence
  over older ones on replay; ties use the smaller Nostr event ID.
- Ciphertext encodes `salt (32) || nonce (12) || tag (16) || AES-GCM ciphertext`.
  The AES-256 key comes from secp256k1 ECDH (shared x coordinate), HKDF-SHA256 with that
  salt, and UTF-8 info `yewholt-control-v1/deploy` or
  `yewholt-control-v1/confirmation`. The AAD is the 32 raw agent-pubkey bytes
  followed by the UTF-8 request UUID. The metadata is signed but not confidential.
- The deploy plaintext is the provisioning object described above. For compatibility
  `channelId: null` means no channel. Only recognized provisioning fields are saved;
  `env_vars` and `system_prompt` are not runtime inputs in this phase. The daemon
  validates the payload and atomically installs it with mode `0600`. Existing file
  reconciliation manages the runtime.
- The reply has `type: "confirmation"`, the same agent pubkey and request ID,
  and plaintext `{job, ok, agentPubkey, error?}`, with `job` equal to `requestId`.
  Success confirms durable provisioning, not that the agent is already online.
  Errors are fixed strings, never supplied payload data. Only **signed** requests
  with identifiable addresses and jobs get replies.
- `$YEWHOLT_HOME/state/control.json` stores job outcomes keyed by provider and
  request ID, the latest deploy ordering per agent, and a digest to recover an
  interrupted write. It carries no provisioning plaintext. A known job can be
  re-confirmed without rewriting the agent file; a new job with the same normalized
  payload leaves the file untouched. A changed payload replaces the file and uses
  the existing conversation for that agent.

**Local integration.** Bring up the disposable relay above and leave it
running. From this repository, run:

```sh
npm run build
node dist/test/spike-daemon-control.js ws://127.0.0.1:13000 "$spike_home/owner.key"
```

The fake provider uses ephemeral test identities and a new daemon home, prints the
home path for cleanup, publishes a deploy before the daemon starts, checks its
confirmation and the agent's kind 10100 and online kind 20001, then checks retry,
deduplication, revocation and secret-free output. The script stops its daemon.
Remove its disposable home and stop the disposable relay before reusing the port.

### Buzz 1.0.6: Yewholt remote agents

The
Yewholt plugin registers a remote harness through the app's agent API. Update
the paired daemon to this version first. On the Mac, use Node ≥22.19.0 to
run `yh update` to build and refresh an installed bridge. For the first install,
build the checkout and run `yewholt provider install`. No Docker or daemon is needed on the Mac.
Keep the checkout and Node executable in place; reinstall the provider after
moving either.

1. Keep the existing relay target and pairing, or create one with the
   commands below. Open that same relay as a community in Buzz. A daemon
   that uses loopback for that relay does not have to change its configuration.
2. In Buzz, open **Settings → Plugins → Manage plugins → Add → Browse**.
   Pick the directory printed as `Buzz plugin folder:` (by default
   `~/.config/yewholt/buzz-plugin`). Review and approve the declared
   `yewholt-buzz-bridge` process. The plugin is trusted app code.
3. With that community selected in Buzz, create an agent with **Harness →
   Remote → Yewholt** and select the relay target (e.g. `instabox`). If
   the relay addresses differ, switch or join the target's community first;
   `yewholt targets list` shows its relay address. Choosing a target is not
   a way to move an agent listing to another Buzz community.
4. Select a model from the daemon's catalog or keep **Daemon default**
   (`YEWHOLT_MODEL` on the daemon). Catalog discovery uses the paired
   control channel and does not wake a stopped VM. If the list is empty,
   run `/login` with an API key on the VM as the daemon user, or configure a
   supported credential in the daemon's `.env`; then restart only that daemon.
   Credentials on the Mac are not used for VM agents. For example, a DeepSeek
   API-key login or `DEEPSEEK_API_KEY` enables the built-in `deepseek/*` models.
   Code execution is opt-in and still requires Linux isolation and approvals.
   Direct replies are limited to the attested owner by default.
5. Open the hosted agent in Buzz and select **Model**. Choose a model from
   the agent's paired daemon and select **Save model**. This keeps the agent's
   identity, conversation history, workspace and permissions. The change
   applies to subsequent turns; it does not restart a stopped agent. Load the
   tab from the Mac that manages the agent, with the daemon online.
6. Compare the agent pubkey with `yewholt agents list` on the daemon. Edit
   name and picture in Buzz, or delete the agent there before removing its
   target. Editing name or picture does not restart a stopped agent.
   The daemon continues publishing runtime/presence kinds `10100` and `20001`; Buzz 1.0.6
   classifies hosted agents by type, so its UI is not a daemon heartbeat.

The bridge reserves a private identity on the Mac until activation is
confirmed, then retains only the non-secret binding and owner proof under
`hosted/` in the provider directory. It sends the key to the paired daemon
over encrypted kind `1059`; plugin JavaScript receives only the public
identity. Keep that Mac's provider state to manage the agent later; Buzz does
not supply a target or agent secret for edits and removal. The bridge reuses
the provider identity and wake hooks. The daemon publishes a kind `0` profile
carrying Buzz's NIP-OA owner attestation; Buzz writes its own agent listing.
Model changes use the same paired, owner-attested channel. The daemon stores
the new model separately from the provisioning file, so editing it cannot
serve as new provisioning for a stopped agent. Run `yh update` on the daemon
host and on the Mac to get the matching daemon, bridge, and plugin (use
`--archive <tar file>` on hosts without git).
Removal unlinks provisioning, retires the runtime, clears its in-process
signing key, and writes a durable tombstone under
`$YEWHOLT_HOME/state/hosted-agents/`. Backups made before removal can still
contain the key; do not restore them over a running installation.

| Component | Status for Buzz 1.0.6 | Action |
| --- | --- | --- |
| Phase 0 relay and encrypted kind `1059`; Phase 1 daemon pairing | Reused | Same relay, fail-closed provider allowlist, and confirmation channel; new hosted operation types. |
| PR #8 agent provisioning, isolation, chat and `!shutdown` | Adapted | Same private agent files and runtime; hosted profiles and tombstones are separate so profile edits do not reactivate stopped agents. |
| Phase 2 provider transport, Keychain and wake | Reused | Used by the bridge. |
| Phase 3 target files, `targets list/doctor`, and `pair` | Reused | The plugin selects relay targets; `doctor` supplies historical confirmation evidence, not a live daemon probe. |

For an opt-in check against the disposable loopback relay:

```sh
node dist/test/spike-hosted-provider.js ws://127.0.0.1:13000 "$spike_home/owner.key" yewholt-phase0-relay-1
```

This exercises provisioning, model and profile edits, and removal through the
installed bridge, daemon, and relay, not the Mac UI. It
uses a new daemon home (printed on stdout) and adds, then removes, its
temporary provider member. Do not use it against an existing community.

### Configure Buzz desktop targets

Run `npm run build` first. On the Mac running Buzz, install the provider and
configure a target for each daemon:

```sh
yewholt provider install
yewholt targets add my-vm --relay wss://relay.example --daemon <daemon-owner-pubkey> --label "My VM"
yewholt targets list
yewholt targets doctor my-vm     # omit the ID to check all targets
```

Pass a complete URL for each relay, repeating `--relay` as needed. `targets add` converts `https://` to
`wss://` and `http://` to `ws://`; do not prepend a second scheme. To
fix a malformed stored URL, rerun `targets add` with the same ID, daemon
pubkey, and any existing label and wake options.

Use lowercase target IDs containing letters, digits, hyphens or underscores,
starting with a letter or digit. The CLI writes each target file with mode
`0600`. `provider install` installs the `yewholt-buzz-bridge` entry in
`~/.local/bin` (override with `YEWHOLT_PROVIDER_BIN_DIR`, e.g. for tests),
pointing to the built checkout and installed Node executable, and removes
executables that earlier releases installed there for Buzz program discovery.
Run `provider install` again after moving either. An existing entry not
managed by Yewholt is not overwritten.

`provider install` and `yewholt pair` print the same provider public key.
Admit it to each relay and run `yewholt pair add <providerPubkey> --label "My Mac"`
on each remote daemon, adding `--relay <url>` for each additional relay the
target should serve.

For remote targets, optionally append one of:

```text
--wake command --cmd '/path/to/trusted-wake-script'
--wake instabox --account acc_example --machine m_example
```

Store InstaBox credentials separately in Keychain or the private fallback
file described below; don't pass them as CLI arguments. For disposable tests
on macOS, `YEWHOLT_PROVIDER_FILE_STORAGE=1` opts out of the real Keychain; set
`YEWHOLT_PROVIDER_HOME` to a disposable directory too.

`targets list` reports the last recorded confirmation, deploy and failure,
and counts distinct agent pubkeys successfully deployed **from this provider**.
It is not a live count and does not decrease on shutdown or deletion. For relay targets,
`doctor` tests the WebSocket connection and NIP-42 authentication, reports
connect-plus-auth latency, and marks confirmations from the last ten minutes as
recent pairing evidence. Control v1 has no ping or version query; an
authenticated relay connection or a prior confirmation does not prove the daemon
is online or still paired.
Non-secret evidence is stored under the provider config directory's `status/`.

`yewholt targets remove my-vm` removes only that target file; it
does not stop agents. Keep the original target until their removal is confirmed.

### Mac-local daemon target (no Docker)

A local target is an ordinary relay target whose daemon runs natively on this
Mac. Use Node.js ≥22.19 (including Node 26), the existing external Buzz relay,
and its public signing key:

```sh
yh install --home "$HOME/.yewholt" --relay wss://relay.example --relay-pubkey <relay-public-key>
yh relay join --home "$HOME/.yewholt"
sudo env PATH="$PATH" scripts/setup-bot-user-macos.sh
# Open a new login session so workspace group membership applies.
yh start
yh provider install
yh provider join
yh targets add my-mac --local --home "$HOME/.yewholt" --label "My Mac"
yh targets doctor my-mac
```

Have the owner approve the privileged setup first. It creates a hidden bot user
`yewholt-bot`, group `yewholt-ws`, passwordless sudo only to that bot account,
and mode-2770 workspaces at `/Users/Shared/yewholt/workspaces`. It restricts the
daemon user's HOME permissions and writes `YEWHOLT_WORKSPACES` to its `.env`.
Node must be on the passed PATH. Do not run npm as root.
For code-bot use, put required executables in bot-readable locations (for
example Homebrew), not a version manager inside the protected daemon HOME.
For custom state, pass `YEWHOLT_HOME="/absolute/state"` through `sudo env`
and use that same home for start and registration. The setup script accepts
`--daemon-user USER` and `--workspaces /absolute/path`; workspaces must be
outside daemon HOME and state. Linux retains `scripts/setup-bot-user.sh`.
The Mac setup changes system accounts and permissions; validate it on the
intended macOS version before relying on it for isolation.

`targets add --local` reads the installed relay config and daemon identity
from `--home`, defaulting to `YEWHOLT_HOME` or `~/.yewholt`, then stores a
normal relay target and directly pairs this provider on each configured
relay. Pairings are read live:
no daemon restart is needed. It does not install or start the daemon.
`--local` is mutually exclusive with relay/daemon/wake flags; `--home`
requires `--local`. A missing installation produces an install command hint.

Pairing is not relay admission. If the administrator admits the keys directly
instead of sharing invites, skip the join commands above. On a self-hosted
relay the admin can use:

```sh
buzz-admin add-member --pubkey <daemon-pubkey>
buzz-admin add-member --pubkey <provider-pubkey>
```

Open the same relay community in Buzz, then select **Harness → Remote →
Yewholt → my-mac**. Configure model credentials as the daemon login user and
keep the Mac awake and daemon running. Do not copy `YEWHOLT_LOCAL_PORT` from
an InstaBox host onto the Mac: use the public `wss://` URL directly, including
an existing InstaBox relay, without a local relay or proxy.

Directory Services replaces Linux `getent` for native macOS isolation checks.
On macOS only, the implicit `everyone` and `localaccounts` groups are ignored;
the bot must otherwise belong only to `yewholt-ws`. Other extra groups fail validation.
This remains Unix-account isolation, not an OS sandbox: all code bots share
one user and have network access. Do not enable the unsafe shared-user
development bypass for normal use.

### Relay target files

The CLI writes mode-0600 files at `~/.config/yewholt/targets/<id>.json`
(`$XDG_CONFIG_HOME/yewholt` or `$YEWHOLT_PROVIDER_HOME` override the base).
Every target, including a Mac-local one, has this shape:

```json
{
  "id": "my-mac",
  "label": "My Mac",
  "transport": "relay",
  "relay": "wss://relay.example",
  "daemonPubkey": "<daemon public key>"
}
```

Do not store credentials in targets or relay URLs. The plugin/bridge sends
encrypted relay requests and awaits daemon confirmation; relay health alone
does not prove pairing or a running daemon. The removed backend provider
engine and file-copy local transport are not used.

Optional relay wake hooks:

- `{"kind":"command","cmd":"/path/to/trusted-wake-script"}` invokes the
  machine operator's command via `/bin/sh`. Its stdio is discarded and it
  receives no deploy payload. Only use commands you trust as the provider user.
- `{"kind":"instabox","accountId":"acc_example","machineId":"m_example"}`
  uses the [documented InstaBox API](https://instabox.sh/docs/api-reference/introduction)
  to start a stopped sandbox or resume a paused one and wait for its
  operation. The API key is scoped to the appropriate workspace with
  `machines:read` and `machines:write`; `accountId` selects the locally stored
  credential, not an API parameter. The adapter is tested with mocked HTTP,
  not against a live sandbox. The daemon must already be configured to start
  on boot.

On macOS the provider generates its secp256k1 key on first use and stores it
in Keychain, generic password service `yewholt-provider`, account `identity`.
If using InstaBox, add a Keychain item under the same service with account
`instabox-<accountId>` and the API token as the password. When Keychain is
unavailable (including on Linux), the engine warns on stderr and uses
`secrets/identity.json` or `secrets/instabox-<accountId>.json` under the
provider configuration directory. The latter must contain just a JSON string
and have mode `0600`. Never put these files or deploy input in version control.

If the daemon and Buzz relay share an InstaBox VM but the VM cannot reach
its own public WebSocket endpoint, keep `relayUrl` in the daemon's
`config.json` set to the public `wss://…instabox.tech` address used by Buzz
and the Mac target. In the **daemon's** `$YEWHOLT_HOME/.env` (not the
relay's `relay/.env`), set `YEWHOLT_LOCAL_PORT` to the local WebSocket
listener's port. Restart only the daemon to apply it. It opens the
WebSocket to `ws://127.0.0.1:<port>` with the public `Host` header and
signs NIP-42 AUTH for the original public URL. Use this only when both
routes lead to the same relay. The override applies only to the primary
relay set by `yh install`. Additional relays and the Mac provider are
unchanged. With the variable unset, the daemon connects directly as before.

<a id="instabox-relay-proxy"></a>For an InstaBox VM using the Host-rewriting proxy, publish the relay on
**loopback port 3001** (`BUZZ_HTTP_PORT=127.0.0.1:3001` in the relay's environment;
the container still listens on 3000). Run the proxy on **port 3000**:

```sh
YEWHOLT_PUBLIC_HOST=3000-your-machine.instabox.tech node scripts/host-proxy.mjs
```

Set `YEWHOLT_PUBLIC_HOST` to the public relay hostname, without the
`wss://` prefix. The proxy listens on all interfaces on port 3000 by
default and forwards HTTP and WebSocket upgrades to `127.0.0.1:3001`.
Override those ports with `YEWHOLT_PROXY_LISTEN` and
`YEWHOLT_PROXY_TARGET` if needed. With the default proxy ports, set
`YEWHOLT_LOCAL_PORT=3000` in the daemon's `.env` so the daemon connects
through the same proxy. A Buzz single-node deployment defaults to publishing the relay on host
port 3000; that conflicts with the proxy's listener. Do not start a second proxy or change the ports
on a running InstaBox deployment that already uses this layout.

**Verification.** `npm test` runs the offline provider checks.

### Coding bots (`code`)

A bot whose stored permissions include `code` is a coding agent. It reads, writes, edits, and runs shell commands in its own workspace, and asks in the chat before anything on the approval list below. A bot without `code` has no tools and behaves as before.

`code` is granted or revoked like any permission, in the agent's provisioning (`permissions` in its file). The change applies from that bot's next turn; the daemon does not restart. Under the hood every conversation selects no extensions by default; a code bot's conversation selects pi-durable's `CodingTools` (`read`, `write`, `edit`, `bash`), the tool search extension (`tool_search`, so deferred tools do not bloat every turn), the extensions of your Pi packages, and Yewholt's gate (`yewholt-code`), in that order. This follows Buzz's Pi host ([`host.mjs`](https://github.com/block/buzz-app/blob/main/src/bundled/pi/host.mjs)); see [NOTICE](NOTICE).

The bot's instructions say it has a workspace, which tools it has, and what needs approval. Bots without `code` keep the old out-of-scope text.

#### Workspace

Each code bot gets `$YEWHOLT_WORKSPACES/<id>`. The root defaults to `/srv/yewholt/workspaces` and must be outside `$YEWHOLT_HOME`. The id is the first 16 hex digits of `sha256("yewholt-workspace:" + pubkey)`, so existing bots keep their ids. The root and each bot directory are owned by `yewholt-bot:yewholt-ws` with mode `2770` (setgid). The daemon belongs to `yewholt-ws`. Both the daemon and the bot shell use umask `007` so ordinary new files and directories are group-writable.

1. Install Yewholt, then run `sudo scripts/setup-bot-user.sh` from the daemon account. On a VM with persistent storage at `/data`, pass `--workspaces /data/yewholt/workspaces` to keep bot files there.
2. Start the daemon from a fresh login session so it picks up the group. Check `yewholt status` for `isolation: ok`.
3. Create an agent with the `code` permission in Buzz. The daemon creates its workspace automatically.

The setup script accepts `--user`, `--group`, `--workspaces`, and `--daemon-user`. Set the corresponding `YEWHOLT_BOT_USER` and `YEWHOLT_BOT_GROUP` in the daemon environment when using custom names. For a custom state directory, pass `YEWHOLT_HOME` through sudo with `sudo --preserve-env=YEWHOLT_HOME scripts/setup-bot-user.sh`. Re-run setup after a VM template update that resets the system accounts or sudoers. Existing folders on persistent storage must still match the recreated account's numeric UID and GID. Legacy files in `$YEWHOLT_HOME/workspaces` stay there. Move any workspace data you want to retain to the corresponding new workspace with the daemon stopped and apply the new ownership and permissions.

Buzz also accepts `permissões: post,read,code` and `permissoes: post,read,code`. In Portuguese create requests, `com permissão code` and `com permissão de código` add `code` to the default `post,read` permissions.

#### Approvals

Everything inside the workspace runs without asking. These wait for a person in the chat first (the owner's list; the classifier is `src/danger.ts`):

- a recursive delete: `rm` with `-r`, `-R`, `--recursive`, or a combined flag such as `-rf`, `-fr`, `-vrf`;
- `git push`, in any form (`git -C dir push`, `git -c k=v push`, ...);
- a download piped into a shell (`curl ... | sh`, `wget -qO- ... | sudo bash`) or run by one (`sh -c "$(curl ...)"`, `bash <(curl ...)`);
- `sudo`, `su`, `doas`;
- any bash command that mentions `$YEWHOLT_HOME`, the `.yewholt` folder, `~/.yewholt`, or the state folder's path;
- `write` or `edit` of a path outside the workspace.

The classifier looks into `;`, `&&`, `||`, pipes, subshells, quotes, escapes, `$(...)`, backticks, `<(...)`, wrappers such as `env`, `xargs`, `timeout`, `find -exec`, and `-c` scripts of sh/bash/zsh/dash/ksh/su. When it cannot parse a command, or the command name is a variable or substitution (`$CMD -rf x`), it asks (fail closed). Look-alikes such as `rm -f file`, `git status`, `git stash push`, and `curl -o file url` run freely.

How it works: a pi-durable `beforeTool` gate parks the call before it runs (pi-durable README, "Gates before a tool runs"). The bot posts one message in the channel of the message it is answering, with the exact command or path and why, and asks for `aprovo` or `rejeito`. The call holds no process while it waits; it is a sleeping task in the SQLite store with a 24-hour deadline, after which it is refused. The request is also kept in the registry and shown in `status.json` as `approvals`.

Who may answer, and which request an answer resolves:

- The answer must come from a person in that same channel who is the install owner (the pubkey of `$YEWHOLT_HOME/secrets/owner.key`), the owner of a Buzz-created agent (its NIP-OA `ownerPubkey`), or an admin listed in `YEWHOLT_ADMINS`. Anyone else gets `Only the owner or an admin can answer approval <id>.`: the call stays parked, nothing runs, and the request stays in the queue. Bots never answer.
- `aprovo`, `sim`, or `approve` (with or without a leading `@<bot>` mention) runs the call once. `rejeito`, `não`, or `reject` refuses it; the model gets a tool error saying a person rejected it.
- A reply to the request message (NIP-10 `e` tag) answers that request.
- `@Coder aprovo` answers Coder's oldest request in the channel.
- A plain `aprovo` answers the only request in the channel. If more than one command is waiting, the daemon lists them and asks which one instead of guessing.

The decision is delivered as a pi-durable signal to the parked call's task. A signal key holds one value, so a second `aprovo` finds nothing to run (`duplicate`). A daemon killed while a call is parked keeps it parked: on restart the daemon re-attaches to the bot's unfinished turn by its request id (no second input), `aprovo` still resolves it, the command runs once, and the reply is posted. `bash` is not replay-safe in pi-durable, so a crash while an approved command is running ends it `interrupted`; it is never started a second time.

#### Secret isolation

Code-bot commands run as the dedicated, unprivileged bot account through `sudo -n -u`. The bot has only the workspace group and cannot access the daemon's login HOME. Commands start in the workspace with a clean environment containing `PATH`, `HOME` (the workspace), `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `TERM=dumb`, and `TMPDIR` (the workspace's `.tmp` directory). Bash commands and package commands that use the execution environment receive these same restrictions.

Yewholt checks isolation at startup and before code-bot tool calls, and caches a successful check for at most 60 seconds. If the account, sudo access, group membership, workspace root, or daemon HOME fails validation, the tools return a refusal with the failed check and the setup command. The daemon logs the first failure and exposes the check result in `status.json` and `yewholt status`. For local development only, `YEWHOLT_UNSAFE_SHARED_USER=1` runs shell commands as the daemon user, with workspaces still outside the state directory. Every daemon start in this mode logs a warning.

`read`, `write`, and `edit` run in the daemon with group access. They refuse paths into `$YEWHOLT_HOME`, other bots' workspaces, and Pi's `auth.json`, including through symlinks. Reads elsewhere use the daemon's permissions, including in its login HOME. Writes or edits outside the workspace need approval. The path check and the filesystem operation are separate, so concurrent symlink changes can race the check.

The bot shell can reach the network and access files available to the bot account. All code bots share one Unix user, so shell commands can read or modify each other's workspaces. Package code runs inside the daemon with access to its environment and permissions. Install only packages you trust.

#### Pi packages

Code bots load the Pi durable parts of the Pi packages in Pi's settings, the same way Buzz does. Follow Buzz's guide, [Add your own Pi extensions to Buzz](https://github.com/block/buzz-app/blob/main/src/bundled/pi/EXTENSIONS.md): list a local package folder in `packages` of `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`); the package lists its entries under `"pi": { "durable": ["./durable.ts"] }`; each entry's default export returns `{ extensions?, providers? }` and may be async.

- Packages load once per daemon process, when a code bot first needs them (its first turn, or at start when a code bot exists). Code bots select every package's extensions; other bots never do. A provider a package adds joins the model catalog once loaded.
- Only local folders load; `npm:`, `git:`, and URL sources are skipped. An extension may not be named `buzz`, `coding-tools`, `tool-search`, `yewholt-code`, or another package's extension name. TypeScript entries run without a build, as in Buzz.
- A package that fails (its setup throws or takes over 30 seconds, a reserved name, a malformed provider) is skipped with one log line, `pi package <source> skipped: <why>`, and the others still load.
- Extensions written for the pi coding agent (`pi.extensions`, `(pi) => {}`) are not loaded, as in Buzz.
- Package code runs inside the daemon with your permissions. Install only packages you trust.

MCP servers, skills (`SKILL.md`), git credentials, and push or PR automation are not part of the coding runtime.

### Keys

Back up `secrets/` and keep it offline (and `relay/.env`, if this home still holds a relay from an earlier install). Buzz has no key rotation: the pubkey is the identity, and a lost secret cannot be recovered or swapped in place. NIP-OA credentials are capabilities the owner key can reissue; they do not replace the agent secret. To retire a leaked agent key, delete the agent in Buzz (or send `!shutdown` as its owner) and create a new one. The old pubkey remains a Nostr identity until you remove it from the channel.

### Provider keys on the host

Run `/login` inside `yewholt`, or log in with an API key from the terminal. For example:

```bash
yewholt code auth login deepseek --api-key
```

The daemon reads the API key from the same Pi `auth.json`; there is nothing to copy. Log in on the machine running the daemon, with the same Unix user and HOME it uses. Pi defaults to `~/.pi/agent/auth.json`; if you set `PI_CODING_AGENT_DIR`, use the same absolute directory for login and the daemon. The daemon's `--home` changes Yewholt's state directory, not Pi's. Keep the auth file private to the daemon user. Restart the daemon after logging in, changing a key, or logging out so it rebuilds its model catalog.

You can also supply provider keys in the daemon's environment or `$YEWHOLT_HOME/.env` (default `~/.yewholt/.env`, mode `0600`). For the daemon, a usable environment credential takes precedence over a saved Pi key; shell variables win over the `.env` file. `YEWHOLT_HOME` is read before its `.env`, so set it in the service environment if needed.

`YEWHOLT_MODEL` is `provider/modelId`. OpenCode Zen free models are catalog ids with a zero cost, for example `opencode/big-pickle` or `opencode/deepseek-v4.1-flash-free`. `OPENCODE_API_KEY` registers both `opencode` and `opencode-go`.

### Environment

None of these are required. A built-in provider is registered when its credential resolves from the environment or a saved Pi API key. The set is `builtinProviders()` from `@earendil-works/pi-ai` 1.6.0, the same list [pi-bot](https://github.com/forge-z/pi-bot) registers in `src/native-providers.ts`, minus subscription OAuth.

| Provider | Env | Notes |
|---|---|---|
| `amazon-bedrock` | `AWS_BEARER_TOKEN_BEDROCK`, or `AWS_PROFILE`, or `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, or `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, or `AWS_CONTAINER_CREDENTIALS_FULL_URI`, or `AWS_WEB_IDENTITY_TOKEN_FILE` | Any one source |
| `ant-ling` | `ANT_LING_API_KEY` | |
| `anthropic` | `ANTHROPIC_API_KEY` | API key only. A value containing `sk-ant-oat` is ignored. `ANTHROPIC_OAUTH_TOKEN` is not read |
| `azure` | `AZURE_OPENAI_API_KEY` | |
| `baseten` | `BASETEN_API_KEY` | |
| `cerebras` | `CEREBRAS_API_KEY` | |
| `cloudflare-ai-gateway` | `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID` | All three |
| `cloudflare-workers-ai` | `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` | Both |
| `deepseek` | `DEEPSEEK_API_KEY` | |
| `fireworks` | `FIREWORKS_API_KEY` | |
| `github-copilot` | `COPILOT_GITHUB_TOKEN` | |
| `google` | `GEMINI_API_KEY` | `GOOGLE_API_KEY` is not the Gemini key |
| `google-vertex` | `GOOGLE_CLOUD_API_KEY`, or `GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) + `GOOGLE_CLOUD_LOCATION` | The credentials path must exist |
| `groq` | `GROQ_API_KEY` | |
| `huggingface` | `HF_TOKEN` | |
| `kimi-coding` | `KIMI_API_KEY` | |
| `meta` | `META_API_KEY` | |
| `minimax` | `MINIMAX_API_KEY` | |
| `minimax-cn` | `MINIMAX_CN_API_KEY` | |
| `mistral` | `MISTRAL_API_KEY` | |
| `moonshotai`, `moonshotai-cn` | `MOONSHOT_API_KEY` | Shared |
| `nvidia` | `NVIDIA_API_KEY` | |
| `openai` | `OPENAI_API_KEY` | |
| `opencode` | `OPENCODE_API_KEY` | OpenCode Zen, including free models |
| `opencode-go` | `OPENCODE_API_KEY` | Same key as Zen |
| `openrouter` | `OPENROUTER_API_KEY` | |
| `qwen-token-plan` | `QWEN_TOKEN_PLAN_TEAM_API_KEY` or `QWEN_TOKEN_PLAN_API_KEY` | Either |
| `qwen-token-plan-cn` | `QWEN_TOKEN_PLAN_TEAM_CN_API_KEY` or `QWEN_TOKEN_PLAN_CN_API_KEY` | Either |
| `qwen-token-plan-individual` | `QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY` or `QWEN_TOKEN_PLAN_API_KEY` | Either |
| `qwen-token-plan-individual-cn` | `QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY` or `QWEN_TOKEN_PLAN_CN_API_KEY` | Either |
| `radius` | `RADIUS_API_KEY` | |
| `together` | `TOGETHER_API_KEY` | |
| `typesafe` | `TYPESAFE_API_KEY` | |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` | |
| `xai` | `XAI_API_KEY` | |
| `xiaomi` | `XIAOMI_API_KEY` | |
| `xiaomi-token-plan-ams` | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | |
| `xiaomi-token-plan-cn` | `XIAOMI_TOKEN_PLAN_CN_API_KEY` | |
| `xiaomi-token-plan-sgp` | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | |
| `zai` | `ZAI_API_KEY` | |
| `zai-coding-cn` | `ZAI_CODING_CN_API_KEY` | |
| `openai-codex` | none | Not registered. ChatGPT/Codex subscription OAuth |

| Variable | Use |
|---|---|
| `YEWHOLT_MODEL` | Default `provider/modelId`, for example `opencode/big-pickle`. Used for a provisioned agent that names no model, and as the harness default when no `--model` is given |
| `YEWHOLT_TURN_TOKENS` | Tokens charged for one interpreter turn (default 1000) |
| `YEWHOLT_BUDGET_TOKENS` | Per-session cap (default 100000) |
| `YEWHOLT_HOME` | State directory. Host configuration and optional provider variables are in `$YEWHOLT_HOME/.env` |
| `YEWHOLT_BOT_USER` | Unprivileged Unix account for code-bot commands (default `yewholt-bot`) |
| `YEWHOLT_BOT_GROUP` | Workspace group shared by the bot account and the daemon (default `yewholt-ws`) |
| `YEWHOLT_WORKSPACES` | Workspace root, outside `$YEWHOLT_HOME` (default `/srv/yewholt/workspaces`) |
| `YEWHOLT_UNSAFE_SHARED_USER` | Development-only escape hatch. Set to `1` to run commands as the daemon user |
| `YEWHOLT_ADMINS` | Optional hex pubkeys (64 characters, separated by commas or spaces) that may answer code-bot approvals besides the owner. Other entries are skipped with a log line |

The full commented list is in `.env.example`. No dependency was added for this; the file parser is a few lines in `src/env-file.ts`.

Model turns also add pi-durable `pi.usage` token totals, and the session is charged the larger of that delta and one interpreter turn. Approval and rejection do not spend the budget. A session over its cap refuses new work.

`yewholt admin budget <name> <tokens>` changes a cap while the daemon is stopped. `admin keys` and `admin bots` are safe while it is up. Do not open the SQLite file from a second process; pi-durable allows one writer.

`yewholt stop` sends the daemon SIGTERM. It does not touch the relay.

## kill -9 resume

This is the durability proof. A task has three steps. Each step writes `effects/<n>` with `O_EXCL` and records a pi-durable memo, then commits the next checkpoint. Step 2 writes its effect and then waits. `kill -9` lands after that effect and before the checkpoint. pi-durable reruns an unfinished phase from the top (`@earendil-works/pi-durable` README, Persist and Resume; the same shape as example 12). The exclusive file is already there, so the effect is not applied again. Step 1's checkpoint was stored, so step 1 does not run again.

Automated:

```bash
npm test
```

Manual:

```bash
bash scripts/kill9-resume.sh
```

The script prints the phase trace. Step 2 appears twice. `effects/1`, `effects/2`, and `effects/3` each exist once.

SQLite is opened with pi-durable's Node adapter (WAL, `synchronous=NORMAL`). The package documents that those commits survive a process crash. A power loss can still drop the newest commit.

## Tests

`npm test` builds and runs:

- NIP-OA test vector from `docs/nips/NIP-OA.md`
- key files mode `0600` and signed kind 9 events
- approval words and leading-mention stripping
- relay membership from a verbatim Buzz 0.3.0 capture (`test/fixtures/buzz-membership-20261121.json`): newest relay-signed 39002 per channel, removal, forged lists ignored
- the relay client against a loopback WebSocket stub: per-subscription event and `EOSE` routing, `unsubscribe`, `CLOSED` reasons; bot connections, re-subscription, and one-time handling of a message seen on two connections
- the Phase 0 control-channel fixture's encryption round-trip and rejection of mismatched AAD
- the kill -9 resume above
- code bots: the approval classifier (every dangerous form, combined flags, quoting, `cd x && rm -rf y`, safe look-alikes); the workspace folder and its minimal env; a bash call cannot see a variable set in the daemon's `process.env`; `$YEWHOLT_HOME` reads refused, also through symlinks; tools only with `code`, and grant/revoke on the next turn; the approval flow end to end on pi-ai's faux provider (park, request message, `aprovo` runs once, `rejeito` refuses, ambiguity asks, reply targets one request, a non-owner's `aprovo` runs nothing and leaves the request queued, an admin from `YEWHOLT_ADMINS` and the install owner can answer); a model error on the faux provider reaches the chat with its reason and provider text, with a fake key masked, for plain and code bots; a kill -9 while parked, then `aprovo` after reopen runs the command exactly once; the Pi package loader with a fixture `pi.durable` package and a broken one that is skipped
- pi-ai built-in providers register from environment credentials or saved Pi API keys, including OpenCode Zen (`opencode/big-pickle`); Claude/Codex subscription tokens do not register
- `~/.yewholt/.env` loads at start, does not override the shell, and is mode `0600`
- CLI routing: `yewholt` and `yewholt code ...` reach the harness with arguments unchanged, `YEWHOLT_MODEL` is added only without `--model`, help flags exit 0, daemon commands route to themselves, unknown commands exit 1. The tests do not start the TUI or call a model

Relay bring-up is not part of `npm test`.

## Roadmap

**v0.5.** Git and repo access, with an approval before push or opening a PR. A sandbox per session. Claude Code and Codex as workers. Still no reuse of Claude subscription OAuth tokens inside Yewholt itself.

**v1.** Buzz plugins for the UI-rich modules (calendar, email, MCP, and the rest). Mac personal mode. Key backup. A hosted paid version.

## Known gaps

- Kind 10100 has no content schema in Buzz's NIP docs, so it is not published. Discovery uses kind 0 plus a NIP-OA tag, which `desktop/src-tauri/src/nostr_convert/oa_profile_tests.rs` treats as an agent.
- The trusted information-flow broker is a proposal, not relay behavior. Yewholt signs with the bot key.
- `GPT-6.2 Astra` is stored as `openai/gpt-6.2-astra`. Generation waits until pi-ai's catalog has that id. The create/approve path does not call a model.
- Free text that is not one of the commands above is answered by pi-ai only when `YEWHOLT_MODEL` (or the bot's `provider/modelId`) resolves in the catalog and a provider key is set. Otherwise the bot replies with the command list.
- NIP-AA kind filters are not enforced per event by every relay. Yewholt sends a fresh `auth` tag whose `kind=` matches the event, and an unconstrained tag on the AUTH event so the agent can connect. See NIP-AA's credential-scope warning.
- One writer for the SQLite file. `admin budget` refuses to run while the daemon is up.
