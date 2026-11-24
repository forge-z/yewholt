---
name: yewholt-install
description: Install Yewholt on a new Linux VM (or a Mac) and join it to a Buzz community with a single invite, so the user can create Buzz agents that run there.
---

# Install Yewholt

Yewholt is a wrapper around Pi: Pi is the engine, Yewholt adds durable agents
and the connection to Buzz. You install it on the machine that will run the
agents (usually a fresh Linux VM) and join it to the user's Buzz community.
For a new VM, the normal flow needs one Buzz invite and a model login if
the VM has none. It does not require the user to copy relay or daemon keys.

If your harness has no secure, unlogged input for the invite, don't ask for
it in chat and don't stop at that warning. Do the non-secret setup you can,
then give the user the remaining steps below, starting with how to open the
VM terminal. Say which steps run on the VM, which run on the Mac, and what
to expect after each. Never ask for the invite, API keys, or login codes in
chat or in a terminal session you can read or record.

Do not install or restart a Buzz relay, create system users, or change an
existing Yewholt installation without asking.

## 1. Open the VM and check prerequisites

Run the VM steps through SSH or the VM provider's interactive console, as
the Unix user who will run the daemon. For a manual install, use your own
private terminal and stay on the VM through step 4. Don't use `sudo` to run
Yewholt or npm.

```sh
uname -sm; node --version; command -v yh && yh status
```

- If the daemon is already joined to this community, keep its home
  (`~/.yewholt`) and Pi directory (`~/.pi/agent`). Skip reinstalling and
  joining; run `yh start` if stopped, with the user's approval, then go to
  step 4. Refresh the pairing offer only if needed (step 5).
- Node.js must be 22.19 or newer. If it is missing or older, install a current
  [Node.js LTS](https://nodejs.org/en/download) as the daemon user (with nvm,
  run `nvm install --lts`). Recheck `node --version` before continuing.

## 2. Install the CLI

If `yh` is not installed, download the source; no Git or GitHub login is
needed:

```sh
mkdir -p ~/yewholt
curl -fsSL https://codeload.github.com/forge-z/yewholt/tar.gz/refs/heads/main | tar -xz -C ~/yewholt --strip-components=1
cd ~/yewholt && npm ci && npm run build && npm link
yh help >/dev/null && echo ok
```

If `npm link` fails because the global prefix is not writable, run
`npm_config_prefix="$HOME/.local" npm link` and add `$HOME/.local/bin` to the
login PATH (`~/.profile`). Later, `yh update` updates this install in place.

## 3. Join Buzz on the VM

In Buzz, create or copy an invite from **Settings → Community admin →
Membership → Invite**. Use it to join only the VM daemon; it may be single-use.

**Manual (no secure field):** In your private VM terminal, run this command
without the link. At `Paste Buzz invite URL:`, paste the link and press Enter.
The prompt can display the link, so don't use a shared or recorded terminal.

```sh
yh join --daemon
```

If Buzz shows terms or a privacy policy, review them and answer the consent
and age prompts yourself.

**Agent-assisted (secure field available):** Request the invite only through
the harness's secure field. Use its secret binding to feed one line to
`yh join --daemon` on stdin. For example, if the harness injects the secret as
`YEWHOLT_INVITE` on the VM, with shell tracing off:

```sh
printf '%s\n' "$YEWHOLT_INVITE" | yh join --daemon
```

Never substitute the actual invite into a tool call, command argument, or
shell history. If the harness can't keep it secret all the way to the VM,
use the manual path. If the command says `Explicit consent required`, show
the user the terms and privacy links. Rerun with `--accept-policy` only after
they accept, adding `--confirm-age` only if required and confirmed. The
invite is not claimed before consent.

On success, `yh join --daemon` joins and starts the daemon and opens a
24-hour pairing offer. Check that `yh status` reports `daemon: running`.

## 4. Log in to a model provider on the VM

The daemon uses Pi's models on the VM, under the same Unix user and Pi
directory as the daemon. The Mac's logins don't carry over. Check the list:

```sh
yh code --list-models
```

If there are no models, run `yh` in the private VM terminal, type `/login`
inside Pi, choose a provider, and complete its prompts. For ChatGPT/Codex
on a VM without a browser, you can instead run:

```sh
yh code auth login openai-codex --no-browser
```

Follow its sign-in instructions in your own browser, then return to the VM
terminal to finish. Exit Pi if you used `/login` (Ctrl+D with an empty
input), then rerun `yh code --list-models` to confirm models appear.

- **API keys:** Use Pi's `/login` if it offers API key input for that provider,
  or open `~/.yewholt/.env` in a private editor on the VM and add the provider's
  variable, using [`.env.example`](../../.env.example) for the name. Keep the
  file at mode `0600` (`chmod 600 ~/.yewholt/.env`). An agent can configure a
  key only through a secure secret binding that keeps it out of tool logs.
- **Claude Code:** `yh code install npm:pi-claude-code` (as this user) adds
  `claude-code/*` models, which use the `claude` CLI logged in on the VM
  (`claude auth login`), not an Anthropic key. The
  built-in `anthropic` provider takes API keys only.

## 5. Discover the VM and create an agent in Buzz on the Mac

1. Use Buzz desktop on the Mac, signed in as the community operator. If
   needed, install and enable the Yewholt plugin and confirm the Mac's
   Yewholt provider is already a member of this community (see
   [Setup step 1](../../README.md#setup)). Keep the VM awake until pairing is done.
2. In that community, open the create-agent form and choose **Harness →
   Remote → Yewholt**. Buzz discovers VMs by daemon public key and lists
   them under **Yewholt target**. Select the new VM and a model, leave code
   execution off, and create the agent. That first agent pairs the Mac
   with the VM. Don't run `yh join` on the operator's Mac or paste the VM
   invite there.
3. Send the agent a test message. If the model list is empty, verify step 4
   on the VM and reopen the picker. A model login doesn't require a daemon
   restart.

If the VM is missing, verify `yh status` on the VM, confirm Buzz is open to
the same community with the plugin enabled, and reopen the create-agent form.
If names look alike, `yh admin keys` on the VM shows its public key on the
`owner` line; match it against `yh targets list` on the Mac after discovery.
If the offer expired, run `yh join --daemon` again **on the VM** with the same
link. This refreshes the offer without consuming another use if the daemon is
still a member.

If the join output instead says
`operator discovery is unavailable, so pair manually`, operator discovery
isn't available for that join. See [Setup step 3](../../README.md#setup) for
how to pair and add the target without the invite or reinstalling the VM.

## 6. Report what works

Setup is verified when the VM appears in Buzz, its model list is nonempty,
and the first agent answers. On Linux `yh start` is not boot supervision: if
the VM reboots, run it again (or set up the host's service manager to run
`yh daemon`).

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
