---
name: yewholt-install
description: Install the yh coding CLI and Buzz bridge on a Mac, and connect native Mac or Linux daemons to an existing Buzz community.
---

# Install Yewholt

Run this from a stable Yewholt checkout on the user's Mac. Confirm which
machines to use (including whether the Mac should host agents), and reuse
existing SSH aliases and daemon configuration. Prefer one Buzz invite for
the community; ask for relay details only when a new daemon needs them.
Do not provision VMs, install a relay, or change existing installations
without permission. An existing relay, including one on InstaBox, is managed
separately from Yewholt.

## Mac: CLI and bridge

1. Check for Node.js ≥22.19. If missing, use the user's existing Node version
   manager or ask before installing one. In a checkout kept at a stable path,
   run `npm ci`, `npm run build`, and `npm link`. Verify `yh help` and
   `yh code --version`. If the npm prefix or PATH is wrong, fix it with the
   user's Node manager; don't use sudo for npm.
2. For Buzz, run `yh provider install`. In Buzz desktop, open
   **Settings → Plugins → Manage plugins → Add → Browse**, select the printed
   plugin folder, and let the user approve `yewholt-buzz-bridge`. If already
   installed in Buzz, use **Update** for the plugin. For the coding CLI alone,
   stop here after step 1.

## Daemon initialization

For each new daemon, `yh install --relay "$RELAY_URL" --relay-pubkey "$RELAY_PUBKEY"`
needs the relay's WebSocket URL and public signing key (64 lowercase hex
characters). Use the existing relay configuration or the relay's NIP-11
`self` field where available; otherwise ask the relay admin. Never ask for
the relay's private key. The invite joins **initialized** daemons; it does
not replace this step.

## Join from the Mac

After initializing the requested daemons, use `yh join` on the Mac, adding an
`--ssh <alias>` for each new VM. Check that `ssh -o BatchMode=yes <alias>`
can run `yh` from a login Bash shell first. The CLI remembers successful SSH
targets on later joins. Have the user paste the invite at the prompt and
review and accept any community policy themselves. Allow one invite use per
new identity: the Mac provider plus each daemon, including the Mac daemon
if installed. No manual key copy, pairing, or target creation is needed.

`yh join` can stop and start a running daemon. If a daemon is managed by a
service supervisor, coordinate with its operator before joining; use the manual
admission and pairing steps below if it must be restarted by that supervisor.
Existing stopped daemons stay stopped. If joining an additional relay does
not discover its key, or no invite is available, see [manual relay setup](../../README.md#join-forge-z-or-another-shared-buzz-community).

## Optional Mac-local daemon (no Docker)

Initialize as the normal daemon login user. For shell and file tools, have
the owner approve and run
`sudo env PATH="$PATH" scripts/setup-bot-user-macos.sh`. For custom state,
also pass `YEWHOLT_HOME="/absolute/state"` through `sudo env`.
The script creates a hidden bot user, workspace group, sudo rule and mode-2770
workspaces at `/Users/Shared/yewholt/workspaces`, restricts daemon HOME access,
and updates its `.env`. It accepts `--daemon-user USER` and
`--workspaces /absolute/path`; workspaces must be outside daemon HOME/state.
Do not run the Linux setup script or use the unsafe shared-user bypass on Mac.
macOS validation ignores only the implicit `everyone` and `localaccounts`
groups; any other group besides `yewholt-ws` is rejected. Linux is unchanged.
Keep code-bot executables outside the protected daemon HOME (Homebrew paths,
not a private Node version-manager directory). Validate setup on the intended
macOS version before claiming that native isolation works.
Open a new login session for group membership before starting the daemon.
`yh join` creates the local target as `mac`. If using direct admission
instead, follow the [manual Mac-local target steps](../../README.md#mac-local-daemon-target-no-docker).
Keep the Mac awake. Connect directly to the public WSS endpoint; don't copy a
VM's `YEWHOLT_LOCAL_PORT` setting to the Mac.

## Each approved VM: daemon only

1. Resolve the approved alias with `ssh -G <alias>`; its `identityfile` entries
   and `ssh-add -l` show what SSH can use. Use the configured identities or
   ssh-agent without reading, copying or printing private keys. Confirm the
   host key through a trusted source if SSH has not seen it before. Check access
   with `ssh -o BatchMode=yes <alias> 'uname -s; node --version'`. If access
   fails, ask for the correct alias or identity; don't try unrelated hosts.
2. Check for an existing Yewholt checkout, daemon and state directory. Keep their
   identity, config, provider credentials, supervisor and workspaces intact.
   Don't point a fresh install at an existing state directory with another
   relay or mode. For a new VM, check out the same revision as the Mac in a
   stable user-owned directory, then run `npm ci`, `npm run build`, and
   `npm link`. If the VM can't read the repository, transfer a source archive
   of that revision over the approved SSH connection; do not copy credentials
   or forward the SSH agent. Use user-owned Node/npm paths.
3. Initialize a new daemon as above. When using direct admission instead
   of an invite, have the relay administrator admit the daemon and Mac provider
   pubkeys printed by their installers. Neither is the relay signing key.
   On the VM, authorize this Mac:

   ```sh
   yh pair add "$PROVIDER_PUBKEY" --label "My Mac"
   yh pair list
   ```

   Then register the VM target on the Mac (use a unique lowercase ID):

   ```sh
   yh targets add "$TARGET_ID" --relay "$RELAY_URL" --daemon "$DAEMON_PUBKEY" --label "$VM_LABEL"
   ```

4. Don't run `sudo scripts/setup-bot-user.sh` on InstaBox. Leave code execution
   off wherever [workspace isolation](../../README.md#workspace) hasn't been
   set up and approved. Configure [wake on message](../../README.md#sleeping-vms-wake-on-message)
   only if the VM should sleep while idle.

## Start and verify each target

1. Have the user run `/login` inside `yh` on the daemon host, or set a supported
   credential in the daemon's private `$YEWHOLT_HOME/.env`. Use the daemon's
   Unix user, HOME and Pi agent directory; don't read or copy credentials.
   See [Provider keys on the host](../../README.md#provider-keys-on-the-host).
   Set `YEWHOLT_MODEL` only if using **Daemon default**.
2. Run `yh start` and `yh status`, or use the existing approved supervisor
   to run `yh daemon` in the foreground. `yh start` is not boot supervision.
   If credentials changed while the daemon was running, restart the daemon
   through its existing launcher. Never restart the relay as part of setup.
3. On the Mac, list targets with `yh targets list` and use `yh targets doctor`
   to check relay connectivity. A running process or healthy relay doesn't
   prove pairing. In the matching Buzz community, open **Harness → Remote →
   Yewholt** and verify that each target returns a nonempty model catalog
   before creating an agent. If empty, check the daemon user's credentials;
   if unreachable, check that the daemon is awake, both identities are relay
   members, and the provider is paired. Report anything still unverified.
