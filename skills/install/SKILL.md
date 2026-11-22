---
name: yewholt-install
description: Install the yh coding CLI and Buzz 1.0.6 bridge on a Mac, and pair Yewholt daemons on the user's Linux VMs.
---

# Install Yewholt

Run this from the Yewholt checkout on the user's Mac. Ask for the approved VM
SSH aliases, the Buzz community WebSocket URL for each, and the relay's public
signing key (64 lowercase hex characters; not the relay private key). You'll
also need a relay admin to admit new identities. Do not provision new VMs,
install a relay, or change existing installations without permission.

## Mac: CLI and bridge

1. Check for Node.js ≥22.19. If missing, use the user's existing Node version
   manager or ask before installing one. In a checkout kept at a stable path,
   run `npm ci`, `npm run build`, and `npm link`. Verify `yh help` and
   `yh code --version`. If the npm prefix or PATH is wrong, fix it with the
   user's Node manager; don't use sudo for npm.
2. Run `yh provider install`. Note the printed plugin folder and provider
   **pubkey**. In Buzz 1.0.6, open **Settings → Plugins → Manage plugins →
   Add → Browse**, select the printed folder and approve
   `yewholt-buzz-bridge`. This is a trusted-app permission; let the user grant
   it if prompted. Start a daemon on the Mac only when a local target is requested.

## Optional Mac-local daemon (no Docker)

Use Node.js ≥22.19 (including Node 26) and the existing external relay.
Run `yh install --home "$HOME/.yewholt" --relay "$RELAY_URL" --relay-pubkey "$RELAY_PUBKEY"`
as the normal daemon login user. Have the owner approve and run
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
Open a new login session for group membership, then run:

```sh
yh start --home "$HOME/.yewholt"
yh targets add my-mac --local --home "$HOME/.yewholt" --label "My Mac"
yh targets doctor my-mac
```

Omitting `--home` uses `YEWHOLT_HOME` or `~/.yewholt`. The home must be installed.
`--local` cannot accompany relay/daemon/wake flags. It stores a normal relay
target and pairs this provider directly; pairings are read live, without restart.
Have the relay administrator admit both printed identities if needed, using
`buzz-admin add-member --pubkey <daemon-pubkey>` and
`buzz-admin add-member --pubkey <provider-pubkey>` on the relay host with its
existing admin environment. Pairing does not replace admission. Configure
model credentials under the daemon user and keep the Mac awake.
Do not set `YEWHOLT_LOCAL_PORT` on the Mac: connect directly to public WSS,
not the InstaBox relay host's loopback proxy. Open that same community in Buzz
and verify a nonempty model catalog in Harness → Remote → Yewholt.
See README's Mac-local target and secret-isolation sections for limitations.

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
3. On a fresh VM initialize the daemon, substituting the actual relay URL and
   public signing key:

   ```sh
   yh install --relay "$RELAY_URL" --relay-pubkey "$RELAY_PUBKEY"
   ```

   The printed **daemon pubkey** is different from the relay signing key and
   Mac provider pubkey. Have the relay administrator admit both the daemon and
   Mac provider pubkeys into the community. On the VM, authorize this Mac:

   ```sh
   yh pair add "$PROVIDER_PUBKEY" --label "My Mac"
   yh pair list
   ```

4. Have the owner run `/login` inside `yh` on the VM and choose an API key, or
   configure a provider credential in the daemon's `$YEWHOLT_HOME/.env`
   (`~/.yewholt/.env` by default, mode 0600). Run login under the same Unix
   user, HOME and Pi agent directory as the daemon so it can read the saved key.
   Don't read, echo or copy credentials. See [Provider keys on the host](../../README.md#provider-keys-on-the-host).
   If using **Daemon default**, set `YEWHOLT_MODEL=provider/modelId` on the VM.
   Run `yh start` and `yh status`, or use the VM's existing approved
   supervisor to run `yh daemon` in the foreground. With no supervisor,
   `yh start` starts it now but not after a VM reboot. Don't run
   `sudo scripts/setup-bot-user.sh` on InstaBox; leave code execution off
   wherever Linux workspace isolation has not been set up and approved.
5. On the Mac, add a relay target for this VM (use a unique lowercase ID):

   ```sh
   yh targets add "$TARGET_ID" --relay "$RELAY_URL" --daemon "$DAEMON_PUBKEY" --label "$VM_LABEL"
   yh targets doctor "$TARGET_ID"
   ```

   Repeat for each VM. A running process or healthy relay is not enough to
   verify pairing. In the matching Buzz community open **Harness → Remote →
   Yewholt** and select the target. Verify that it returns a nonempty model
   catalog without creating an agent. If the catalog is empty, check the
   provider configuration and restart the VM daemon only. If loading fails,
   check relay membership, pairing, community URL and versions on both hosts.
   Report unverified targets and any permissions the owner still needs to grant.
