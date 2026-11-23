---
name: yewholt-install
description: Install Yewholt on a new Linux VM (or a Mac) and join it to a Buzz community with a single invite, so the user can create Buzz agents that run there.
---

# Install Yewholt

Yewholt is a wrapper around Pi: Pi is the engine, Yewholt adds durable agents
and the connection to Buzz. You install it on the machine that will run the
agents (usually a fresh Linux VM, running these steps on the VM itself) and
join it to the user's Buzz community. The user's only input is one Buzz
invite, plus a model login if the VM has none. Never ask for a relay URL,
relay key, daemon key or pairing step: `yh join --daemon` finds them.

Do not install or restart a Buzz relay, create system users, or change an
existing Yewholt installation without asking.

## 1. Check the machine

```sh
uname -sm; node --version; command -v yh && yh status
```

- If `yh status` shows an existing daemon, keep its home (`~/.yewholt`) and
  Pi directory (`~/.pi/agent`). Run `yh update`, then go to step 3; it does
  not spend the invite again for a daemon that is already a member.
- Node.js must be 22.19 or newer. If it is missing or older, install a current
  Node LTS as the user who will run the daemon (for example with nvm in that
  user's HOME). Don't run npm with sudo.

## 2. Install the CLI

Download the source; no Git or GitHub login is needed:

```sh
mkdir -p ~/yewholt
curl -fsSL https://codeload.github.com/forge-z/yewholt/tar.gz/refs/heads/main | tar -xz -C ~/yewholt --strip-components=1
cd ~/yewholt && npm ci && npm run build && npm link
yh help >/dev/null && echo ok
```

If `npm link` fails because the global prefix is not writable, run
`npm_config_prefix="$HOME/.local" npm link` and add `$HOME/.local/bin` to the
login PATH (`~/.profile`). Later, `yh update` updates this install in place.

## 3. Get the invite and join

1. Ask the user for a Buzz community invite (in Buzz: **Settings → Community
   admin → Membership → Invite**). Request it through your harness's secure
   input, a secret or masked field whose value stays out of the chat and tool
   logs. Never ask for it in chat. If your harness has no such field, say so
   and stop. Invites may be single-use: ask once and finish the setup with it.
2. Write it to a private file and join, without putting it in a command
   argument or shell history:

   ```sh
   umask 077
   # write the invite (one line) to ~/.yh-invite with your file-write tool
   yh join --daemon < ~/.yh-invite; status=$?
   rm -f ~/.yh-invite
   ```

   Keep the file only until the join has succeeded (you may need it for the
   policy rerun below), then delete it.
3. If it stops with "Explicit consent required", the community has a join
   policy. Show the user the terms (and privacy) links it printed. Only after
   they accept, rerun with `--accept-policy`, adding `--confirm-age` only if
   the policy requires age confirmation and they confirm it. Nothing is claimed
   before consent.
4. On success it has created the daemon, joined it, started it, and opened a
   pairing offer for 24 hours. Tell the user the next step it printed:
   - **"in Buzz on the relay operator's Mac"**: nothing to run on the Mac. In
     Buzz, they create an agent with **Harness → Remote → Yewholt**; this VM
     appears in the target list by itself. The first agent created on it pairs
     their Mac.
   - **"on the Mac: run yh join"**: they run `yh join` on the Mac and paste the
     same invite. A Mac that is already a community member doesn't use it again.

   The Mac needs Yewholt's Buzz plugin either way (see
   [Setup](../../README.md#setup) step 1). If they never set it up, point
   them to it.
5. Keep the VM awake until the pairing is done. If the 24 hours pass, rerun
   step 2 with the same invite: it reopens the offer without using it again.

## 4. Models

Agents use the models Pi sees on this VM as this user; the Mac's logins don't
carry over. Check what is available with `yh code --list-models`. If it is empty, ask the user which provider to use:

- **API key** (e.g. DeepSeek, OpenAI, OpenRouter): request the key through the
  secure field, append `PROVIDER_API_KEY=<key>` to `~/.yewholt/.env` (mode
  `0600`) with your file tool, never echoing it. [`.env.example`](../../.env.example)
  lists the variable names.
- **Account login** (e.g. ChatGPT/Codex): `/login` inside `yh`, or
  `yh code auth login <provider> --no-browser`, needs an interactive terminal. Run it in a
  terminal you can drive and relay the sign-in link, or have the user run it
  on the VM.
- **Claude Code:** `yh code install npm:pi-claude-code` (as this user) adds
  `claude-code/*` models, which use the `claude` CLI logged in on the VM
  (`claude auth login`), not an Anthropic key. The
  built-in `anthropic` provider takes API keys only.

Then restart the daemon so it rebuilds the catalog: `yh stop && yh start`.

## 5. Verify and report

```sh
yh status
```

The daemon must be running. On Linux `yh start` is not boot supervision: if
the VM reboots, run `yh start` again (or set up the host's service manager to
run `yh daemon`). The setup is done when the user sees this VM in Buzz's
Yewholt target list with a nonempty model list and their first agent answers.

Report what you did, the next step for the user, and anything not yet
verified. Leave code execution off: it needs a dedicated Unix account
([Coding agents](../../README.md#coding-agents)) and only on request. If the
VM pauses when idle, mention [Sleeping VMs](../../README.md#sleeping-vms) as
an option; don't configure it unasked.

## Other cases

- **Mac as an agent host:** on the Mac, run `yh join --local` instead of
  `--daemon`; it also joins the Mac's provider and creates the `mac` target.
- **VMs reachable from the Mac over SSH:** install the CLI on each VM, then on
  the Mac run `yh join --ssh <alias>`. Use the user's SSH config and agent;
  never read, copy or print private keys. Each new identity uses one invite
  use.
- **No invite (admin admits keys directly):** see
  [Manual setup without an invite](../../README.md#manual-setup-without-an-invite).
