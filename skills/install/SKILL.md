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
   it if prompted. Don't start a daemon on the Mac.

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

4. Have the owner configure a model credential privately in the daemon's
   `$YEWHOLT_HOME/.env` (`~/.yewholt/.env` by default, mode 0600); don't read,
   echo or copy the credential. See the [provider variable list](../../README.md#environment).
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
