#!/bin/sh
# Container start: install on first boot against YEWHOLT_RELAY_URL, then run
# the daemon in the foreground. The relay key comes from the relay's NIP-11
# `self` field unless YEWHOLT_RELAY_PUBKEY is set.
set -eu
home="${YEWHOLT_HOME:-/data}"

if [ ! -f "$home/config.json" ]; then
  relay="${YEWHOLT_RELAY_URL:?Set YEWHOLT_RELAY_URL, e.g. wss://buzz.example.com}"
  pubkey="${YEWHOLT_RELAY_PUBKEY:-}"
  if [ -z "$pubkey" ]; then
    pubkey=$(node --input-type=module -e '
      const url = process.argv[1].replace(/^ws/, "http");
      for (let attempt = 1; ; attempt++) {
        try {
          const response = await fetch(url, { headers: { accept: "application/nostr+json" } });
          const key = (await response.json()).self;
          if (/^[0-9a-f]{64}$/.test(key ?? "")) { console.log(key); break; }
        } catch {}
        if (attempt === 60) { console.error(`No relay key (NIP-11 self) from ${url}`); process.exit(1); }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }' "$relay")
  fi
  yh install --relay "$relay" --relay-pubkey "$pubkey"
fi

# Publishes the daemon pubkey for a relay admin step (e.g. buzz-admin add-member).
if [ -n "${YEWHOLT_PUBKEY_FILE:-}" ]; then
  node --input-type=module -e '
    const { readKey } = await import("/app/dist/src/keys.js");
    const { pubkeyOf } = await import("/app/dist/src/nostr.js");
    console.log(pubkeyOf(readKey(process.argv[1])));' "$home/secrets/owner.key" > "$YEWHOLT_PUBKEY_FILE"
fi

exec node /app/dist/src/cli.js daemon --home "$home"
