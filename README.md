# Yewholt

**Yewholt: a Pi coding harness and durable agents on Buzz.**

- **At your terminal:** `yh` opens [Pi](https://pi.dev) in the current directory. `yewholt` is an alias. See [Harness](#harness).
- **In Buzz:** Create an agent and choose which machine runs it. The daemon runs natively on Linux or macOS and connects to an existing [Buzz](https://github.com/block/buzz) relay. Each bot keeps its own [Pi conversation history](#pi-resources-and-bot-sessions) across restarts.

## Agent-first setup

1. Give your coding agent [the installation skill](skills/install/SKILL.md).
   Tell it which machines should run agents: the Mac itself, Linux VMs it
   can already reach over SSH, or both. No Docker is needed.
2. Use [`yh join`](#join-forge-z-or-another-shared-buzz-community) from the Mac
   and paste the community invite when prompted. Use `--local` to set up
   a fresh Mac daemon or `--ssh <alias>` for each VM. The invite provides the
   relay details; `join` sets up, admits and pairs the daemons without copying keys.
   If the community doesn't use invites, the skill covers direct admission.
3. In Buzz, add and approve the [Yewholt plugin](#buzz-106-yewholt-remote-agents).
   In the matching community, open **Harness → Remote → Yewholt**, select a
   machine, and check that its model list loads before creating an agent.

For the Mac coding CLI alone, build a checkout with Node.js 22.19+:

```sh
npm ci
npm run build
npm link
yh
```

Every `npm run build` preserves the CLI's Node shebang and marks the output
executable, so rebuilding keeps the linked `yh` and `yewholt` commands runnable.

The first run opens Pi in the current directory. Use Pi's `/login` and
`/model` for the local harness. For Buzz, set up at least one
[model login on each daemon host](#provider-keys-on-the-host), as the daemon user.

## Updating

```sh
yh update [--home dir] [--archive <tar file>]
```

Run `yh update` on the Mac and each daemon VM. It updates the checkout of the
running CLI (not the current directory) with `git pull --ff-only`, removes old
`dist` output, runs `npm ci` and `npm run build`, and refreshes the Buzz bridge
if installed. A running daemon for `--home` (default `$YEWHOLT_HOME` or
`~/.yewholt`) is restarted with the new build; a stopped daemon stays stopped.
The relay is never touched. In Buzz, use **Settings → Plugins → Manage
plugins → Yewholt → Update** to reload the plugin; refreshing the bridge
doesn't update the copy already loaded by Buzz. The CLI update stops at the
first failed command with that command's exit code.

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
      ├─ pi-durable registry/outbox in SQLite
      └─ one Pi SDK AgentSession per bot, JSONL history
```

- **Relay.** An existing, unmodified Buzz relay run by its administrator. Yewholt does not install, start, or stop it; `yh install` records its URL and public key.
- **Daemon.** A Node process. It keeps the registry, outbox, processed ids and budgets in a pi-durable SQLite store. On restart it cancels unfinished turns and pending approvals rather than replaying tool side effects.
- **Bot.** One lazily created Pi coding-agent SDK `AgentSession` plus its own Nostr key. Prompts are serialized per bot. The Pi transcript is stored separately from SQLite and is [resumable by name](#pi-resources-and-bot-sessions).
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
| kind 1059 | Encrypted provider control messages and wake delegations. |
| kinds 10100 / 20001 | Agent runtime profile (including an optional `wake_url`) / presence. |
| kind 30175 | Owner-signed persona (`d` slug, `display_name`, `runtime=yewholt`, model, provider). |
| kind 30177 | Owner-signed managed agent (`d` = agent pubkey, `persona_id`, `name`, `respond_to`). |
| kind 39002 | Read only. Relay-signed channel member list (`d` = channel id, `["p", pubkey, "", role]`). Each bot follows the lists that name it; see [Channels and scope](#channels-and-scope). |

Yewholt holds each bot key on disk and signs as that bot. It does not depend
on a relay-side information-flow broker.

## Requirements

- Node.js 22.19 or newer.
- For Buzz agents: Buzz desktop, an existing relay that admits the provider
  and daemon, and a supported model credential on the daemon host.
- Building and running the test suite does not require a relay or model login.

## Daemon install

On a new Linux host, install the CLI first:

```bash
npm ci
npm run build
npm link
```

With a Buzz invite, run [`yh join --ssh <alias>`](#join-forge-z-or-another-shared-buzz-community)
from the Mac to initialize the daemon. For manual setup instead, use the
existing relay's WebSocket URL and public signing key (64 lowercase hex
characters). This is the relay's key, not the administrator's or the daemon's.

```bash
yh install --relay "$RELAY_URL" --relay-pubkey "$RELAY_PUBKEY"
```

`install` writes `~/.yewholt` (override with `--home` or `YEWHOLT_HOME`) and prints the daemon pubkey for the relay administrator to admit:

- `config.json` with the relay URL and public key
- `secrets/owner.key`, mode `0600`, the daemon's identity
- `.env`, mode `0600`, for host configuration and provider keys

Admit and pair the daemon via [`yh join`](#join-forge-z-or-another-shared-buzz-community)
or [configure the target manually](#configure-buzz-desktop-targets).
Then run `yh start` and `yh status`. The daemon creates
`state/sessions.sqlite` on startup. `yh start` is not boot supervision; on a
VM that reboots, use its service manager to run `yh daemon` in the foreground.

`start`, `stop`, and `status` manage only the daemon; the relay is run and upgraded by whoever administers it. Running `install` again on the same home with the same relay is a no-op.

### Container

The native install is the normal setup. If you already run Buzz in Compose
or Coolify, you can run an always-on watcher alongside it. The image publishes
Linux AMD64 and ARM64 builds; use `:sha-<commit>` to pin a build instead of
following `:main`. It contains the Yewholt daemon, not the relay.

```sh
docker run -d --name yewholt-watcher --restart unless-stopped \
  -v yewholt-data:/data -e YEWHOLT_RELAY_URL=wss://relay.example \
  -e YEWHOLT_NAME="Yewholt watcher" ghcr.io/forge-z/yewholt:main
```

The first boot reads the signing key from the relay's NIP-11 `self` field
unless `YEWHOLT_RELAY_PUBKEY` is set. Keep `/data` persistent for the
watcher's identity. On a membership-restricted relay, have the admin admit
the public key printed by `docker exec yewholt-watcher yh admin keys`.
In Compose, set `YEWHOLT_PUBKEY_FILE=/handoff/daemon.pubkey` and mount
`/handoff` writable on the watcher and read-only on the relay-admin job.
Have the job wait for the file and admit that key. The watcher itself needs
no relay admin or model credentials. Leave `YEWHOLT_WAKE_URL` and
`YEWHOLT_WAKE_PORT` unset on the watcher. See [Sleeping VMs](#sleeping-vms-wake-on-message).

### Join Forge Z or another shared Buzz community

On the owner's Mac, ask the community owner/admin for a Buzz invite
(**Settings → Community admin → Membership → Invite**), then run:

```sh
yh join --ssh my-vm --ssh owner@another-vm
```

Paste the invite when prompted; omit `--ssh` if you have no SSH targets to add.
Add `--local` to initialize a fresh Mac daemon; an existing Mac daemon is
included without it. On new daemons, `join` reads the invited relay's public
signing key from NIP-11 (`self`) and creates the daemon home, identity and
private `.env` before claiming the invite. If the relay does not publish that
key, ask its admin for the public key and run `yh install` first.

The command admits the Mac provider and daemons, pairs them, and updates Buzz
targets. After admission it checks the signing key against signed group events,
discovering the key for any additional relay. This check times out after 15 seconds.

Allow **one invite use per new identity**: the Mac provider, the Mac daemon
if selected or already installed, and each SSH daemon. A Mac provider and two VMs
without a Mac daemon need three uses. Already-admitted identities don't use
another. A failure is reported per machine without stopping the others, and any
failure gives a nonzero exit status. If none of the requested daemons can be
prepared, the command claims no invite uses.

SSH uses the system `ssh` with `BatchMode=yes` and login `bash` to find `yh` on
PATH. Install/update `yh` on the VMs first and configure non-interactive SSH
access. Invites reach child processes only on stdin, never in their argv.
Successful SSH hosts are remembered on private mode-0600 target files, so
subsequent `yh join` commands include them without `--ssh`. Target IDs, labels,
and wake/SSH options are retained when the daemon key matches existing targets;
all targets for that daemon are updated, not just the first.
A new local target is named `mac` (label `My Mac`); VM IDs come from their hosts.

After admitting the provider, `join` also checks other registered targets without
needing SSH or another invite use. It authenticates to the joined community and
reads Buzz's relay-signed NIP-43 community roster (kind 13534, `member` tags),
then adds that relay to every target whose daemon key is listed. NIP-29 kind
39002 is a channel roster, not a community roster, so it is not used to decide
community membership. Existing relays and target metadata are preserved and
relays are not duplicated. Each changed target gets a `Target <id>: updated for
<relay>` summary line. If the community roster is unavailable or rejected,
unverified targets stay unchanged and the command reports a failure with a
nonzero exit status. This check does not admit, pair, configure or restart those
other daemons; they must already serve the joined relay and be paired with the
provider there for models to load.

The local daemon home is `YEWHOLT_HOME` or `~/.yewholt`. The command never creates
system users or runs isolation setup scripts. After a successful join, it stops
and starts a running local or SSH daemon if it was newly admitted or its relay
was newly added, so it reconnects with its new membership. An already-member daemon with an unchanged
relay is not restarted. New and stopped daemons are not started; run `yh start`
when ready. Existing agents remain on their original relay.
If an external service supervisor manages the daemon, coordinate the restart
with its operator or use manual admission and pairing.
In Buzz, open the joined community and select the desired target when creating
an agent; the human must also be a community member. Install/update the Buzz
provider plugin with `yh provider install` if not already done.

Low-level commands remain available: `yh provider join` admits only the Mac
provider; `yh relay join` admits only that daemon and adds the relay (restart
it yourself). `--relay-pubkey` is optional and, if supplied, must match discovery.
`yh relay list`, `yh pair add ... --relay <url>`, and `yh targets add ...` allow
manual configuration. Omitting `--relay` from pairing commands selects the
primary relay. Pairing changes are read live.

All join commands accept an HTTPS invite page or a `buzz://join` link.
Paste at the prompt or supply the link on the first line of stdin to keep
the invite token out of shell history. When the community has a join policy,
the CLI links to the community's `/api/join-policy/terms` HTML page and, when
privacy text is present, `/api/join-policy/privacy`, instead of printing the full
text. Use `YH_SHOW_TERMS=1 yh join` (also supported by the low-level
joins) to review the full text before explicitly accepting it and any required
age attestation. For non-interactive use, pass `--accept-policy` only after
reviewing the current policy and `--confirm-age` only if the required age
attestation is true, for example:

```sh
yh join --accept-policy --confirm-age < /path/to/private-invite-file
```

Run an interactive join by itself so subsequent shell commands aren't read
as prompt answers. If join fails, share the reported HTTP status and error,
not the invite URL.

All join commands request uncompressed API responses and also handle raw gzip
bodies even when response headers are missing, for compatibility with HTTP
dispatchers loaded by dependencies.

Each newly admitted identity consumes one use. Use a separate link per key if
**Max uses** is 1, or reuse a link with enough uses for all keys. If the
administrator admits the keys directly instead, use `yh relay add` to
configure the extra relay; the provider needs no join command.

### Chat

Agents are created in the Buzz desktop app (see [Buzz 1.0.6: Yewholt remote agents](#buzz-106-yewholt-remote-agents)) and provisioned to the daemon. Mention an agent by name or pubkey to talk to it; in a direct message it follows its `respondTo` setting.

Permissions that the daemon honors are `post` (publish kind 9), `read` (the message is shown to that session), and `code` (the agent becomes a coding agent, see [Coding bots](#coding-bots-code)). Other tokens are stored and shown back; they do not grant extra tools.

A model label is mapped to a pi-ai `provider/modelId`. pi-ai will call it only when that provider and id exist in the catalog and the matching API key is set. Until then the session still exists, keeps its history, and says so when mentioned.

When a model turn ends without an answer, the bot says why instead of a bare failure, for example `I could not answer that (model_error: 429 FreeUsageLimitError: ...).` or `I could not answer that (no_model).` The reason describes the SDK turn outcome, and the detail is the provider's error text, flattened to one line, cut at 300 characters, with token-like runs of 32+ characters shown as `[redacted]`.

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

#### Multi-VM daemon provisioning

The daemon accepts encrypted provisioning from a paired provider through the Buzz
relay, without SSH or an inbound daemon port. The provider is trusted code: it receives the agent's private key
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
admitted owner where the relay allows it.
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
protocol carried by a Buzz kind, not NIP-44 or NIP-59. The designated sender signs the outer event directly, so the daemon can verify
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
  `env_vars` and `system_prompt` are not runtime inputs currently. The daemon
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

### Buzz 1.0.6: Yewholt remote agents

The Yewholt plugin registers a remote harness through the app's agent API. Update
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
   `yewholt-buzz-bridge` process. The plugin is trusted app code. For an
   existing plugin, select **Update** after refreshing the bridge.
3. With that community selected in Buzz, create an agent with **Harness →
   Remote → Yewholt** and select the relay target (e.g. `instabox`). If
   the relay addresses differ, switch or join the target's community first;
   `yewholt targets list` shows its relay address. Choosing a target is not
   a way to move an agent listing to another Buzz community.
4. Select a model from the daemon's catalog or keep **Daemon default**
   (`YEWHOLT_MODEL` on the daemon). Catalog discovery uses the paired
   control channel and does not wake a stopped VM. If the list is empty,
   [configure a supported credential](#provider-keys-on-the-host) on the
   target as the daemon user, then restart only that daemon.
   Credentials on the Mac are not used for VM agents. For example, a DeepSeek
   API-key login or `DEEPSEEK_API_KEY` enables the built-in `deepseek/*` models.
   Code execution is opt-in and requires [workspace isolation](#workspace)
   and [approvals](#approvals).
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
--wake url --url https://my-vm.example/
```

Store InstaBox credentials separately in Keychain or the private fallback
file described below; don't pass them as CLI arguments. For disposable tests
on macOS, `YEWHOLT_PROVIDER_FILE_STORAGE=1` opts out of the real Keychain; set
`YEWHOLT_PROVIDER_HOME` to a disposable directory too.

`targets list` reports the last recorded confirmation, deploy and failure,
and counts distinct agent pubkeys successfully deployed **from this provider**.
It is not a live count and does not decrease on shutdown or deletion.
Non-secret evidence is stored under the provider config directory's `status/`.

`yh targets doctor [id]` checks each configured relay live without waking a
sleeping target. It checks the relay connection and NIP-42 authentication,
then asks the daemon for its model catalog over the signed, encrypted control
channel. It reports the first failed link and how to fix it, and exits with
status 1 if any route fails. A relay accepting the request without a signed
daemon reply means the daemon did not respond on that relay, not necessarily
that the process is stopped. If the catalog is empty, an updated daemon can
report whether its Pi credential store has no saved login. A nonempty catalog
from environment credentials also passes; doctor does not make a model request.

`yewholt targets remove my-vm` removes only that target file; it
does not stop agents. Keep the original target until their removal is confirmed.

### Mac-local daemon target (no Docker)

A local target is an ordinary relay target whose daemon runs natively on this
Mac. With the CLI already installed, use a Buzz invite to set it up:

```sh
yh provider install
yh join --local
```

The first join creates the `mac` target (label `My Mac`). If using direct
admission instead, set up the daemon manually as in [Daemon install](#daemon-install).
Start it with `yh start` when ready.

For code execution only, have the owner approve and run
`sudo env PATH="$PATH" scripts/setup-bot-user-macos.sh` from the checkout
before starting the daemon. Open a new login session to pick up the workspace
group. The script creates a hidden bot user
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
instead of sharing invites, skip `yh join`; on the Mac register and pair the
target with `yh targets add mac --local --label "My Mac"`. On a self-hosted
relay the admin can use:

```sh
buzz-admin add-member --pubkey <daemon-pubkey>
buzz-admin add-member --pubkey <provider-pubkey>
```

Open the same relay community in Buzz, then select **Harness → Remote →
Yewholt → My Mac**. Configure model credentials as the daemon login user and
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
- `{"kind":"url","url":"https://my-vm.example/"}` sends a GET to the VM's
  public URL and waits up to the request timeout for an answer, retrying
  `502`/`503`/`504`. It needs no provider credentials; see
  [Sleeping VMs](#sleeping-vms-wake-on-message).

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
and the Mac target. In the **daemon's** `$YEWHOLT_HOME/.env`, set `YEWHOLT_LOCAL_PORT` to the local WebSocket
listener's port. Restart only the daemon to apply it. It opens the
WebSocket to `ws://127.0.0.1:<port>` with the public `Host` header and
signs NIP-42 AUTH for the original public URL. Use this only when both
routes lead to the same relay. The override applies only to the primary
relay set by `yh install`. Additional relays and the Mac provider are
unchanged. With the variable unset, the daemon connects directly as before.

**Verification.** `npm test` runs the offline provider checks.

### Sleeping VMs: wake on message

Skip this section if your daemon stays online. On a VM that resumes on HTTP
traffic after an idle pause (such as InstaBox or Freestyle), waking on a Buzz
message takes two daemons on the same community relay:

1. **Sleeping VM:** Map a public HTTP(S) URL to a local port and set both
   variables in the VM daemon's `.env`:

   ```text
   YEWHOLT_WAKE_URL=https://my-vm.example/
   YEWHOLT_WAKE_PORT=8787
   ```

   Restart the daemon and verify the URL returns `204` from outside the VM.
   It serves no data; a request wakes the daemon and reconnects its relay
   sockets.
2. **Always-on watcher:** Run another Yewholt daemon admitted to the same
   relay, with no wake URL or port. This can be a native daemon or the
   [optional watcher container](#container).
   If all daemons disconnect, no one sees the message to wake the VM.

The VM's agents announce their wake URL in their runtime profiles. After
`YEWHOLT_IDLE_MINUTES` (default 10) without work or a pending approval, the
daemon announces offline presence and disconnects, letting the VM provider
pause it. On reconnect it reads messages from its stored cursor.

The watcher follows only channels whose member lists it can see. It subscribes
to their live messages by `#h` (the channel ID), then sends a GET to an offline
agent's wake URL if the sender is human and allowed by the agent's
`respond_to` policy. No recent `online` presence (last 150 seconds) counts as
offline; wake requests are limited to one per URL per minute.

#### DMs and private channels

The watcher cannot normally see an agent's DMs or channels it doesn't belong
to. To wake on those messages, set the **watcher's public key** on the
**sleeping VM daemon** and restart the VM daemon:

```text
YEWHOLT_WATCHER_PUBKEY=<64-hex pubkey of the always-on daemon>
```

Get the hex key from `yh admin keys` on the watcher's host (the `owner` line)
or the watcher container's handoff file. Before sleeping, the VM daemon seals
each agent's signing key to that watcher. The watcher uses it to read as the
agent. **The watcher's process receives the full signing key**, not a
read-only credential; only delegate to a watcher you trust. Leave this unset
to keep the keys on the VM.

To verify, let the VM go idle, then send a message from an allowed account
and confirm the agent replies without visiting the wake URL or using the
Buzz target controls. Test a DM separately if you configured delegation.
This mechanism does not boot a manually stopped InstaBox VM; the separate
provider [wake hook](#relay-target-files) can start it for provider operations.

### Coding bots (`code`)

A bot whose stored permissions include `code` is a coding agent. It reads, writes, edits, and runs shell commands in its own workspace, and asks in the chat before anything on the approval list below. A bot without `code` can use MCP and extension tools and read installed skill files, but has no shell, write or edit tools.

`code` is granted or revoked in the agent provisioning file. A permission change disposes the cached SDK session before the next turn. Code bots get Pi’s built-in read/write/edit and an isolated bash tool, plus tool search, MCP and trusted extension tools. Yewholt’s inline `tool_call` approval gate runs before built-in filesystem and shell calls.

The same gate covers built-in calls nested through `codemode` scripts or through a tool-search-loaded extension's `ctx.executeTool()`. Non-code bots cannot reach bash or write through either route.

The bot's instructions say it has a workspace, which tools it has, and what needs approval. Bots without `code` are told that read is limited to installed skill files.

#### Workspace

Each code bot gets `$YEWHOLT_WORKSPACES/<id>`. The root defaults to `/srv/yewholt/workspaces` and must be outside `$YEWHOLT_HOME`. The id is the first 16 hex digits of `sha256("yewholt-workspace:" + pubkey)`, so existing bots keep their ids. The root and each bot directory are owned by `yewholt-bot:yewholt-ws` with mode `2770` (setgid). The daemon belongs to `yewholt-ws`. Both the daemon and the bot shell use umask `007` so ordinary new files and directories are group-writable.

1. Install Yewholt, then run `sudo scripts/setup-bot-user.sh` from the daemon account. On a VM with persistent storage at `/data`, pass `--workspaces /data/yewholt/workspaces` to keep bot files there.
2. Start the daemon from a fresh login session so it picks up the group. Check `yewholt status` for `isolation: ok`.
3. Create an agent with the `code` permission in Buzz. The daemon creates its workspace automatically.

The setup script accepts `--user`, `--group`, `--workspaces`, and `--daemon-user`. Set the corresponding `YEWHOLT_BOT_USER` and `YEWHOLT_BOT_GROUP` in the daemon environment when using custom names. For a custom state directory, pass `YEWHOLT_HOME` through sudo with `sudo --preserve-env=YEWHOLT_HOME scripts/setup-bot-user.sh`. Re-run setup after a VM template update that resets the system accounts or sudoers. Existing folders on persistent storage must still match the recreated account's numeric UID and GID. Legacy files in `$YEWHOLT_HOME/workspaces` stay there. Move any workspace data you want to retain to the corresponding new workspace with the daemon stopped and apply the new ownership and permissions.

#### Approvals

Everything inside the workspace runs without asking. These wait for a person in the chat first (the owner's list; the classifier is `src/danger.ts`):

- a recursive delete: `rm` with `-r`, `-R`, `--recursive`, or a combined flag such as `-rf`, `-fr`, `-vrf`;
- `git push`, in any form (`git -C dir push`, `git -c k=v push`, ...);
- a download piped into a shell (`curl ... | sh`, `wget -qO- ... | sudo bash`) or run by one (`sh -c "$(curl ...)"`, `bash <(curl ...)`);
- `sudo`, `su`, `doas`;
- any bash command that mentions `$YEWHOLT_HOME`, the `.yewholt` folder, `~/.yewholt`, or the state folder's path;
- `write` or `edit` of a path outside the workspace.

The classifier looks into `;`, `&&`, `||`, pipes, subshells, quotes, escapes, `$(...)`, backticks, `<(...)`, wrappers such as `env`, `xargs`, `timeout`, `find -exec`, and `-c` scripts of sh/bash/zsh/dash/ksh/su. When it cannot parse a command, or the command name is a variable or substitution (`$CMD -rf x`), it asks (fail closed). Look-alikes such as `rm -f file`, `git status`, `git stash push`, and `curl -o file url` run freely.

How it works: an inline Pi `tool_call` extension blocks execution while awaiting a chat decision. The bot posts the exact command or path and why in the channel of the turn, asking for `aprovo` or `rejeito`. It waits in memory without starting a process, with a 24-hour deadline after which it is refused. The request is also kept in the registry and shown in `status.json` as `approvals`.

Who may answer, and which request an answer resolves:

- The answer must come from a person in that same channel who is the install owner (the pubkey of `$YEWHOLT_HOME/secrets/owner.key`), the owner of a Buzz-created agent (its NIP-OA `ownerPubkey`), or an admin listed in `YEWHOLT_ADMINS`. Anyone else gets `Only the owner or an admin can answer approval <id>.`: the call stays parked, nothing runs, and the request stays in the queue. Bots never answer.
- `aprovo`, `sim`, or `approve` (with or without a leading `@<bot>` mention) runs the call once. `rejeito`, `não`, or `reject` refuses it; the model gets a tool error saying a person rejected it.
- A reply to the request message (NIP-10 `e` tag) answers that request.
- `@Coder aprovo` answers Coder's oldest request in the channel.
- A plain `aprovo` answers the only request in the channel. If more than one command is waiting, the daemon lists them and asks which one instead of guessing.

The decision resolves that call's in-memory promise once. A second `aprovo` finds nothing to run (`duplicate`). After a restart, pending requests are cancelled with “the daemon restarted; request <id> was cancelled, ask again”. Unfinished turns get “interrupted by a restart, send it again”. Neither approvals nor tool side effects are replayed; send a new request instead of approving an old one.

#### Secret isolation

Code-bot commands run as the dedicated, unprivileged bot account through `sudo -n -u`. The bot has only the workspace group and cannot access the daemon's login HOME. Commands start in the workspace with a clean environment containing `PATH`, `HOME` (the workspace), `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `TERM=dumb`, and `TMPDIR` (the workspace's `.tmp` directory). Pi's session environment variables are not exposed to bash. MCP and extension tools are trusted daemon code and do not inherit these restrictions.

Yewholt checks isolation at startup and before code-bot tool calls, and caches a successful check for at most 60 seconds. If the account, sudo access, group membership, workspace root, or daemon HOME fails validation, the tools return a refusal with the failed check and the setup command. The daemon logs the first failure and exposes the check result in `status.json` and `yewholt status`. For local development only, `YEWHOLT_UNSAFE_SHARED_USER=1` runs shell commands as the daemon user, with workspaces still outside the state directory. Every daemon start in this mode logs a warning.

`read`, `write`, and `edit` run in the daemon with group access. They refuse paths into `$YEWHOLT_HOME`, other bots' workspaces, and Pi's `auth.json`, including through symlinks. Reads elsewhere use the daemon's permissions, including in its login HOME. Writes or edits outside the workspace need approval. The path check and the filesystem operation are separate, so concurrent symlink changes can race the check.

The bot shell can reach the network and access files available to the bot account. All code bots share one Unix user, so shell commands can read or modify each other's workspaces. Package code runs inside the daemon with access to its environment and permissions. Install only packages you trust.

#### Pi resources and bot sessions

All bots use the daemon user's Pi configuration directory, `~/.pi/agent` (or
`PI_CODING_AGENT_DIR`), including `auth.json`, `models.json`, skills,
extensions and ordinary Pi packages. Configure them as the daemon user:

```sh
yh code mcp add docs --url https://mcp.example.com/mcp
yh code install npm:trusted-package
```

MCP servers come from the global `mcp.json`. Put skills in
`~/.pi/agent/skills/<name>/SKILL.md`. Pi package extensions can register
tools and model providers; providers become visible to hosted model listing
once loaded by a bot. Restart the daemon after changing global resources.

These integrations run with the daemon's permissions, not the isolated bot
user. Install only trusted MCP servers, packages and extensions. The built-in
bash tool still uses Yewholt's clean environment and bot user. A non-code bot's
read tool can read only installed skill files. Workspace project resources
(`.pi/settings.json`, extensions, packages, MCP configuration, skills and
context files) are never loaded or trusted: a bot can write its workspace.

Each bot's history is a persistent Pi JSONL session under
`<agentDir>/sessions/yewholt-<workspaceId>/`. It continues the most recent
session after restart, but interrupted work and approvals are not replayed.
Preserve the daemon user's Pi session directory as well as
`$YEWHOLT_HOME` when moving or backing up a daemon. Sessions carry
the bot's display name and follow renames. As the same daemon user, run
`yh` and use `/resume`, switch to all projects, then search for the bot's
name; `yh code --resume` also opens the session picker. Do not run concurrent
writers against a bot's session file while its daemon is active.

### Keys

Back up `secrets/` and keep it offline. Buzz has no key rotation: the pubkey is the identity, and a lost secret cannot be recovered or swapped in place. NIP-OA credentials are capabilities the owner key can reissue; they do not replace the agent secret. To retire a leaked agent key, delete the agent in Buzz (or send `!shutdown` as its owner) and create a new one. The old pubkey remains a Nostr identity until you remove it from the channel.

### Provider keys on the host

Run `/login` inside `yewholt`, or log in with an API key from the terminal. For example:

```bash
yewholt code auth login deepseek --api-key
```

The daemon reads API keys and supported OAuth logins from the same Pi `auth.json`; there is nothing to copy. For example, log in to `openai-codex` in Pi to list and use ChatGPT/Codex subscription models in Buzz. Anthropic remains API-key only: Claude subscription OAuth and `sk-ant-oat` tokens are refused. Log in on the machine running the daemon, with the same Unix user and HOME it uses. Pi defaults to `~/.pi/agent/auth.json`; if you set `PI_CODING_AGENT_DIR`, use the same absolute directory for login and the daemon. The daemon's `--home` changes Yewholt's state directory, not Pi's. Keep the auth file private to the daemon user. Restart the daemon after logging in, changing a key, or logging out so it rebuilds its model catalog.

OAuth request authentication and token refresh use Pi's built-in provider flows. Refreshed tokens are persisted to the same `auth.json` using Pi's file-locked credential store, preserving other logins and serializing concurrent refreshes with the Pi app. Token refresh does not require a daemon restart; failed refreshes fail the request rather than using an expired token.

You can also supply provider keys in the daemon's environment or `$YEWHOLT_HOME/.env` (default `~/.yewholt/.env`, mode `0600`). For the daemon, a usable environment credential takes precedence over a saved Pi key; shell variables win over the `.env` file. `YEWHOLT_HOME` is read before its `.env`, so set it in the service environment if needed.

`YEWHOLT_MODEL` is `provider/modelId`, for example `anthropic/claude-sonnet-4-5`.

### Environment

Daemon model streams request `Accept-Encoding: identity` through Pi's request-header options for providers that support custom HTTP headers. This avoids raw gzip SSE responses and `Stream ended without finish_reason` errors with Node 26.0's native fetch and a dependency-installed Undici dispatcher. It does not change global fetch or dispatcher settings.

None of these are required. A built-in provider is registered when its credential resolves from the environment, a saved Pi API key, or a saved OAuth login supported by that provider (except Anthropic). Usable environment credentials retain precedence over saved credentials. The set is `builtinProviders()` from `@earendil-works/pi-ai` 1.6.0.

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
| `openai-codex` | none | Saved ChatGPT/Codex subscription OAuth from Pi's `auth.json` |

| Variable | Use |
|---|---|
| `YEWHOLT_MODEL` | Default `provider/modelId`, for example `anthropic/claude-sonnet-4-5`. Used for a provisioned agent that names no model, and as the harness default when no `--model` is given |
| `YEWHOLT_TURN_TOKENS` | Tokens charged for one interpreter turn (default 1000) |
| `YEWHOLT_BUDGET_TOKENS` | Per-session cap (default 100000) |
| `YEWHOLT_HOME` | State directory. Host configuration and optional provider variables are in `$YEWHOLT_HOME/.env` |
| `YEWHOLT_NAME` | Optional name for the daemon's own Buzz profile (kind 0). Set it on either a native daemon or a watcher container to identify it in the member list |
| `YEWHOLT_WAKE_URL`, `YEWHOLT_WAKE_PORT` | Public HTTP(S) wake URL and the local port it maps to. Set both to allow idle disconnection |
| `YEWHOLT_IDLE_MINUTES` | Idle time before the daemon disconnects (default 10 minutes), not the VM provider's pause timeout |
| `YEWHOLT_WATCHER_PUBKEY` | Optional public key of a trusted always-on daemon for DM/private-channel wake |
| `YEWHOLT_BOT_USER` | Unprivileged Unix account for code-bot commands (default `yewholt-bot`) |
| `YEWHOLT_BOT_GROUP` | Workspace group shared by the bot account and the daemon (default `yewholt-ws`) |
| `YEWHOLT_WORKSPACES` | Workspace root, outside `$YEWHOLT_HOME` (default `/srv/yewholt/workspaces`) |
| `YEWHOLT_UNSAFE_SHARED_USER` | Development-only escape hatch. Set to `1` to run commands as the daemon user |
| `YEWHOLT_ADMINS` | Optional hex pubkeys (64 characters, separated by commas or spaces) that may answer code-bot approvals besides the owner. Other entries are skipped with a log line |

See [`.env.example`](.env.example) for a starter configuration.

Each model turn sums its SDK assistant-message token usage, and the bot is charged the larger of that total and one configured turn. Approval and rejection do not spend the budget. A session over its cap refuses new work.

`yewholt admin budget <name> <tokens>` changes a cap while the daemon is stopped. `admin keys` and `admin bots` are safe while it is up. Do not open the SQLite file from a second process; pi-durable allows one writer.

`yewholt stop` sends the daemon SIGTERM. It does not touch the relay.

## Tests

`npm test` builds and runs:

- NIP-OA signing test vector
- key files mode `0600` and signed kind 9 events
- approval words and leading-mention stripping
- relay membership from a verbatim Buzz 0.3.0 capture (`test/fixtures/buzz-membership-20261121.json`): newest relay-signed 39002 per channel, removal, forged lists ignored
- the relay client against a loopback WebSocket stub: per-subscription event and `EOSE` routing, `unsubscribe`, `CLOSED` reasons; bot connections, re-subscription, and one-time handling of a message seen on two connections
- control-channel encryption round-trip and rejection of mismatched AAD
- Code-bot workspace isolation and command approval, including cancellation without replay after restart
- Provider credentials from the daemon's environment or Pi login, including Codex OAuth refresh and rejection of Anthropic OAuth
- Persistent per-bot Pi sessions, idle disconnect, wake decisions and sealed wake delegation
- `~/.yewholt/.env` loads at start, does not override the shell, and is mode `0600`
- CLI routing: `yewholt` and `yewholt code ...` reach the harness with arguments unchanged, `YEWHOLT_MODEL` is added only without `--model`, help flags exit 0, daemon commands route to themselves, unknown commands exit 1. The tests do not start the TUI or call a model

Relay bring-up is not part of `npm test`.

## Known gaps

- The trusted information-flow broker is a proposal, not relay behavior. Yewholt signs with the bot key.
- NIP-AA kind filters are not enforced per event by every relay. Yewholt sends a fresh `auth` tag whose `kind=` matches the event, and an unconstrained tag on the AUTH event so the agent can connect. See NIP-AA's credential-scope warning.
- One writer for the SQLite file. `admin budget` refuses to run while the daemon is up.
