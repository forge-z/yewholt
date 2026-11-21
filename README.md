# Yewholt

**Yewholt: a pi coding harness, and durable agents on Buzz.**

Yewholt has two roles:

1. **Coding harness.** Type `yewholt` in any directory and it opens an interactive [pi](https://pi.dev) coding-agent session on that directory. It is the same harness as the `pi` CLI and it loads the same pi packages (extensions, skills, prompt templates, themes). See [Harness](#harness).
2. **Durable bots on Buzz.** A headless daemon that runs durable coding agents behind [Buzz](https://github.com/block/buzz). The daemon is not a Buzz fork and has no UI of its own. The stock Buzz relay runs unmodified on the same host. The stock Buzz app (Mac or iOS, in [block/buzz-app](https://github.com/block/buzz-app)) talks only to that relay. Each bot is a Nostr member of a channel, the same way a person is.

Calendar, email, MCP, cron, memory, kanban, and browser tools are out of core. They belong in later Buzz plugins.

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

- `$YEWHOLT_HOME/.env` (default `~/.yewholt/.env`) is loaded first, so the provider keys the bots use also work in the harness. A variable set in the shell wins.
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

- **Relay.** The official single-node bundle from Buzz `deploy/compose/` (`ghcr.io/block/buzz:0.3.0`, Postgres, Redis, MinIO). `relay/compose.yml` is a verbatim copy of that file. See `relay/SOURCE.md`.
- **Daemon.** A Node process. It opens one pi-durable `Harness` on a SQLite file and calls `resume()` after every start, so a crashed run continues from the last committed step.
- **Bot.** One ownerless pi-durable conversation (its own instructions, model, and transcript) plus its own Nostr key. The Onboarding Specialist is the first bot, not a router.
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
- Docker with Compose v2, only for `yewholt start` (the relay). Tests do not need it.
- No API key is required. Keys are optional and are read from the environment only when a session calls a model.

## Run

```bash
npm install
npm run build
npm link          # optional, puts `yewholt` on PATH
yewholt           # the coding harness, see Harness
yewholt install   # ~/.yewholt, owner key, relay .env
yewholt start     # official compose, then the daemon
yewholt status
```

`install` writes `~/.yewholt` (override with `--home` or `YEWHOLT_HOME`):

- `secrets/owner.key` and `secrets/bots/<pubkey>.key`, mode `0600`
- `relay/.env`, mode `0600`, and a copy of the official compose file
- `state/sessions.sqlite`, the pi-durable store

Open the Buzz app on `ws://127.0.0.1:3000` (or whatever `--port` you set). The daemon creates a channel named `yewholt` and puts the Onboarding Specialist in it. Your owner key is the relay owner (`RELAY_OWNER_PUBKEY`). Import that secret into a Nostr client, or add your existing pubkey with `buzz-admin add-member` inside the relay container, then talk in the channel.

### Chat

The Onboarding Specialist answers these without a model. It posts a summary and does nothing until you approve.

```text
crie um novo bot e coloque o GPT-6.2 Astra como modelo
approve
```

Also:

```text
@Onboarding Specialist crie um novo bot chamado Coder com o modelo opencode/deepseek-v4.1-flash
@Onboarding Specialist aprovo
crie um novo bot chamado Teste com modelo opencode/deepseek-v4.1-flash
crie um novo bot chamado Teste usando o modelo opencode/deepseek-v4.1-flash
create a bot named Coder with model opencode/deepseek-v4.1-flash
create bot name: Alpha model: openai/gpt-6-sol scope: this permissions: post,read
create bot name: Coder model: openai/gpt-6-sol scope: this permissions: post,read,code
change model of Alpha to anthropic/claude-sonnet-5
change scope of Alpha to this
change permissions of Alpha to post,read
change permissions of Alpha to post,read,code
stop bot Alpha
start bot Alpha
reject
```

The model can be given as `coloque o X como modelo`, `com o modelo X`, `com modelo X`, `usando o modelo X`, `with model X`, or `model: X`. A create request without a model uses `YEWHOLT_MODEL` in the proposal and its summary; only when that is unset too does the Onboarding Specialist ask you to name one.

Leading `@` mentions of Yewholt bots are stripped before the Onboarding Specialist parses a command, so `@Onboarding Specialist aprovo` is the same as `aprovo` (names with spaces and extra spaces are fine). A message that starts with another bot's mention, such as `@Coder sim`, is addressed to that bot and is not an approval.

`approve`, `sim`, and `aprovo` apply the pending proposal. `reject` drops it. Scope `this` is the channel the message was posted in. Permissions that the daemon honors are `post` (publish kind 9), `read` (the message is shown to that session), and `code` (the bot becomes a coding agent, see [Coding bots](#coding-bots-code)). Other tokens are stored on the proposal and shown back; they do not grant extra tools.

A display name such as `GPT-6.2 Astra` is stored as requested and mapped to `openai/gpt-6.2-astra`. pi-ai will call it only when that provider and id exist in the catalog and the matching API key is set. Until then the session still exists, keeps its history, and says so when mentioned.

Mention another bot by name or pubkey. The Onboarding Specialist listens to the whole install channel. Other bots answer only when mentioned, and only while they are `active`. This holds in every channel a bot is a member of, see below.

### Channels and scope

A bot answers in every channel it is currently a member of, including private channels. Adding the bot to a channel from the Buzz app is the approval; removing it there stops it in that channel. Nothing else changes: the mention rules above still apply, a stopped bot stays silent, and the `post`/`read` permissions still decide what it may do. In a channel it only joined from the app, the Onboarding Specialist answers only when mentioned (`@Onboarding Specialist aprovo`), so ordinary chatter that starts with `sim` is not taken as an approval.

How the daemon does it:

- While the daemon runs, each active bot keeps its own connection, signed with its own key plus the owner's NIP-OA `auth` tag. The owner key cannot read private channels it is not in (the relay answers `CLOSED … restricted: not a channel member`), so each bot reads with its own key.
- Each bot subscribes to kind 39002 with `#p` = its pubkey, plus `#d` = the channels it is in so the newer list that drops it is seen too. Only lists signed by the relay key count; that key is derived from `BUZZ_RELAY_PRIVATE_KEY` in `$YEWHOLT_HOME/relay/.env`. Per channel, only the newest list counts. Kind 9000/9001 events alone are not trusted. If the relay key is missing, the daemon logs it once and only the stored scope applies.
- A bot's effective scope is its stored scope plus the channels those lists name. Stored records and proposals are not changed. `yewholt status` (`status.json`) shows both as `scope` and `channels`.
- Each bot subscribes to kind 9 once per effective channel and re-subscribes when the set changes. A message seen on several connections is handled once. The channel is taken from the message's `h` tag. Replies go out on the replying bot's own connection, into that same channel.
- Approving a create or start opens that bot's connection; approving a stop closes it. If a connection drops, the daemon restarts its relay loop and reopens every connection.

### Agents created in the Buzz desktop app

The Buzz desktop app creates and owns these agents. Its backend provider runs on the owner's Mac and writes one file over SSH to `$YEWHOLT_HOME/agents/<agent-pubkey>.json` on the daemon host. The provider sets mode `0600` and replaces the file atomically. The provider holds the agent's `nsec` by design because it provisions the runtime that signs as that agent. Yewholt loads that key from the provisioning file into memory and keeps it out of the bot registry, status output, and agent key files.

| Field | Value |
|---|---|
| `name` | Required nonempty agent name. |
| `nsec` | Required agent secret key as 64 lowercase hex digits. Its public key must match the filename. |
| `authTag` | Required `["auth", "<owner pubkey>", "<conditions>", "<Schnorr signature>"]`. The owner's key must differ from the agent's. The signature covers `sha256("nostr:agent-auth:<agent pubkey>:<conditions>")`. |
| `relayUrl` | WebSocket relay URL. Defaults to the daemon's relay URL. |
| `model` | Object with `provider`, `modelId`, and `label`. Defaults to the daemon model configured by `YEWHOLT_MODEL`. |
| `permissions` | String array. Defaults to `["post", "read"]`. Add `"code"` to give the agent the coding tools and workspace described below. |
| `respondTo` | DM response policy. Defaults to `"anyone"`. |
| `respondToAllowlist` | Array of lowercase hex user public keys for the `"allowlist"` policy. Defaults to `[]`. |
| `channelId` | Optional first channel. Relay membership adds channels to this starting scope. |

Buzz publishes the kind 0 profile with its NIP-OA tag, kind 30175 persona, kind 30177 registration, and kind 9030 and 9000 membership events. Yewholt signs in as the agent with the supplied auth tag and publishes its kind 10100 runtime profile, kind 20001 presence, and kind 9 replies. It sends the profile and online presence after connecting, then refreshes them every 10 minutes and 60 seconds, respectively.

Yewholt recognizes a DM when the newest trusted kind 39002 member list contains exactly two distinct members. An external agent can answer a human DM without a mention. The `anyone` policy accepts any human sender, `allowlist` accepts listed public keys, and other policies refuse the DM. In a group channel, address the agent with an `@mention`. Daemon-created member bots still require an `@mention` in every channel.

The Buzz owner can stop an external agent with a message containing exactly `!shutdown` after trimming whitespace. Yewholt queues offline presence and closes the agent's subscriptions. The provider can restart it by replacing the file with a valid copy whose modification time is newer than the stop. A removed file retires the durable record and triggers offline presence when the daemon has the loaded key. Run `yewholt status` or read `status.json` to see each agent's active, stopped, retired, or invalid state.

### Coding bots (`code`)

A bot whose stored permissions include `code` is a coding agent. It reads, writes, edits, and runs shell commands in its own workspace, and asks in the chat before anything on the approval list below. A bot without `code` has no tools and behaves as before. The Onboarding Specialist never gets `code`: a proposal that gives it `code` is refused.

`code` is granted or revoked like any permission, through an approved proposal (`create bot ... permissions: post,read,code`, `change permissions of X to post,read,code`). The change applies from that bot's next turn; the daemon does not restart. Under the hood every conversation selects no extensions by default; a code bot's conversation selects pi-durable's `CodingTools` (`read`, `write`, `edit`, `bash`), the tool search extension (`tool_search`, so deferred tools do not bloat every turn), the extensions of your Pi packages, and Yewholt's gate (`yewholt-code`), in that order. This follows Buzz's Pi host ([`host.mjs`](https://github.com/block/buzz-app/blob/main/src/bundled/pi/host.mjs)); see [NOTICE](NOTICE).

The bot's instructions say it has a workspace, which tools it has, and what needs approval. Bots without `code` keep the old out-of-scope text.

#### Workspace

Each code bot gets `$YEWHOLT_WORKSPACES/<id>`. The root defaults to `/srv/yewholt/workspaces` and must be outside `$YEWHOLT_HOME`. The id is the first 16 hex digits of `sha256("yewholt-workspace:" + pubkey)`, so existing bots keep their ids. The root and each bot directory are owned by `yewholt-bot:yewholt-ws` with mode `2770` (setgid). The daemon belongs to `yewholt-ws`. Both the daemon and the bot shell use umask `007` so ordinary new files and directories are group-writable.

1. Install Yewholt, then run `sudo scripts/setup-bot-user.sh` from the daemon account. On a VM with persistent storage at `/data`, pass `--workspaces /data/yewholt/workspaces` to keep bot files there.
2. Start the daemon from a fresh login session so it picks up the group. Check `yewholt status` for `isolation: ok`.
3. Create a bot or grant it `code` in Buzz and approve the proposal. The daemon creates its workspace automatically.

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

- The answer must come from a person (not a bot) in that same channel, the same rule as proposal approval.
- `aprovo`, `sim`, or `approve` (with or without a leading `@<bot>` mention) runs the call once. `rejeito`, `não`, or `reject` refuses it; the model gets a tool error saying a person rejected it.
- A reply to the request message (NIP-10 `e` tag) answers that request.
- `@Coder aprovo` answers Coder's oldest request in the channel. `@Onboarding Specialist aprovo` stays with the bot proposal.
- A plain `aprovo` answers the only request in the channel. If a bot proposal is pending there too, or more than one command is waiting, the daemon lists them and asks which one instead of guessing.

The decision is delivered as a pi-durable signal to the parked call's task. A signal key holds one value, so a second `aprovo` finds nothing to run (`duplicate`). A daemon killed while a call is parked keeps it parked: on restart the daemon re-attaches to the bot's unfinished turn by its request id (no second input), `aprovo` still resolves it, the command runs once, and the reply is posted. `bash` is not replay-safe in pi-durable, so a crash while an approved command is running ends it `interrupted`; it is never started a second time.

#### Secret isolation

Code-bot commands run as the dedicated, unprivileged bot account through `sudo -n -u`. The bot has only the workspace group and cannot access the daemon's login HOME. Commands start in the workspace with a clean environment containing `PATH`, `HOME` (the workspace), `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `TERM=dumb`, and `TMPDIR` (the workspace's `.tmp` directory). Bash commands and package commands that use the execution environment receive these same restrictions.

Yewholt checks isolation at startup and before code-bot tool calls, and caches a successful check for at most 60 seconds. If the account, sudo access, group membership, workspace root, or daemon HOME fails validation, the tools return a refusal with the failed check and the setup command. The daemon logs the first failure and exposes the check result in `status.json` and `yewholt status`. For local development only, `YEWHOLT_UNSAFE_SHARED_USER=1` runs shell commands as the daemon user, with workspaces still outside the state directory. Every daemon start in this mode logs a warning.

`read`, `write`, and `edit` run in the daemon with group access. They refuse paths into `$YEWHOLT_HOME` and other bots' workspaces, including through symlinks. Reads elsewhere use the daemon's permissions, including in its login HOME. Writes or edits outside the workspace need approval. The path check and the filesystem operation are separate, so concurrent symlink changes can race the check.

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

Back up `secrets/` and `relay/.env` and keep them offline. Buzz has no key rotation: the pubkey is the identity, and a lost secret cannot be recovered or swapped in place. NIP-OA credentials are capabilities the owner key can reissue; they do not replace the agent secret. To retire a leaked bot key, `stop bot <name>` (it stops answering) and create a new bot. The old pubkey remains a Nostr identity until you remove it from the channel.

### Provider keys on the host

The daemon reads keys from the environment of the process that runs it. `yewholt start` loads `$YEWHOLT_HOME/.env` (default `~/.yewholt/.env`) before it spawns the daemon, and the daemon loads that same file again when it starts. `yewholt install` creates the file if it is missing and sets mode `0600`. A later start tightens the mode to `0600` if the file was created world-readable.

Paste a key over SSH, then restart so the process picks it up:

```bash
umask 077
install -m 600 -d ~/.yewholt
cat >> ~/.yewholt/.env <<'EOF'
OPENCODE_API_KEY=sk-...
YEWHOLT_MODEL=opencode/big-pickle
EOF
chmod 600 ~/.yewholt/.env
yewholt stop
yewholt start
```

A variable already set in the shell wins over the file. The file is not the relay's `relay/.env` (that one holds Postgres, Redis, and the relay key). `YEWHOLT_HOME` is read from the shell before the file, so put it in the service environment if the state directory is not `~/.yewholt`.

`YEWHOLT_MODEL` is `provider/modelId`. OpenCode Zen free models are catalog ids with a zero cost, for example `opencode/big-pickle` or `opencode/deepseek-v4.1-flash-free`. `OPENCODE_API_KEY` registers both `opencode` and `opencode-go`.

### Environment

None of these are required. A provider is registered only when its own credential resolves from the environment. The set is `builtinProviders()` from `@earendil-works/pi-ai` 1.6.0, the same list [pi-bot](https://github.com/forge-z/pi-bot) registers in `src/native-providers.ts`, minus subscription OAuth.

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
| `YEWHOLT_MODEL` | Default `provider/modelId`, for example `opencode/big-pickle`. Used for a create request that names no model, and as the harness default when no `--model` is given |
| `YEWHOLT_TURN_TOKENS` | Tokens charged for one interpreter turn (default 1000) |
| `YEWHOLT_BUDGET_TOKENS` | Per-session cap (default 100000) |
| `YEWHOLT_HOME` | State directory. The key file is `$YEWHOLT_HOME/.env` |
| `YEWHOLT_BOT_USER` | Unprivileged Unix account for code-bot commands (default `yewholt-bot`) |
| `YEWHOLT_BOT_GROUP` | Workspace group shared by the bot account and the daemon (default `yewholt-ws`) |
| `YEWHOLT_WORKSPACES` | Workspace root, outside `$YEWHOLT_HOME` (default `/srv/yewholt/workspaces`) |
| `YEWHOLT_UNSAFE_SHARED_USER` | Development-only escape hatch. Set to `1` to run commands as the daemon user |

The full commented list is in `.env.example`. No dependency was added for this; the file parser is a few lines in `src/env-file.ts`.

Model turns also add pi-durable `pi.usage` token totals, and the session is charged the larger of that delta and one interpreter turn. Approval and rejection do not spend the budget. A session over its cap refuses new work and still accepts `approve` on a proposal it already posted.

`yewholt admin budget <name> <tokens>` changes a cap while the daemon is stopped. `admin keys`, `admin bots`, and `admin channel` are safe while it is up. Do not open the SQLite file from a second process; pi-durable allows one writer.

`yewholt stop` sends the daemon SIGTERM and runs `docker compose stop`. Volumes are kept.

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
- the Portuguese create example, approval, a second session, model change, and stop
- every model phrase above, the verbatim `@Onboarding Specialist …` messages, leading-mention stripping, and the `YEWHOLT_MODEL` default for a create without a model
- relay membership from a verbatim Buzz 0.3.0 capture (`test/fixtures/buzz-membership-20261121.json`): newest relay-signed 39002 per channel, removal, forged lists ignored, no relay key means stored scope only
- the relay client against a loopback WebSocket stub: per-subscription routing, `unsubscribe`, `CLOSED` reasons; bot connections, re-subscription, and one-time handling of a message seen on two connections
- a budget that blocks a second create and still allows `approve`
- the kill -9 resume above
- code bots: the approval classifier (every dangerous form, combined flags, quoting, `cd x && rm -rf y`, safe look-alikes); the workspace folder and its minimal env; a bash call cannot see a variable set in the daemon's `process.env`; `$YEWHOLT_HOME` reads refused, also through symlinks; tools only with `code`, never for the Onboarding Specialist, and grant/revoke on the next turn; the approval flow end to end on pi-ai's faux provider (park, request message, `aprovo` runs once, `rejeito` refuses, ambiguity asks, reply targets one request); a kill -9 while parked, then `aprovo` after reopen runs the command exactly once; the Pi package loader with a fixture `pi.durable` package and a broken one that is skipped
- every pi-ai built-in provider registers only when its env credential resolves, including OpenCode Zen (`opencode/big-pickle`), and Claude/Codex subscription tokens do not
- `~/.yewholt/.env` loads at start, does not override the shell, and is mode `0600`
- CLI routing: `yewholt` and `yewholt code ...` reach the harness with arguments unchanged, `YEWHOLT_MODEL` is added only without `--model`, help flags exit 0, daemon commands route to themselves, unknown commands exit 1. The tests do not start the TUI or call a model

Relay bring-up is not part of `npm test`. It needs Docker.

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
