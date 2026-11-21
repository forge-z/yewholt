#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'setup-bot-user: %s\n' "$*" >&2
  exit 1
}

bot_user=yewholt-bot
bot_group=yewholt-ws
workspaces=/srv/yewholt/workspaces
daemon_user=${SUDO_USER:-}
while (( $# )); do
  case $1 in
    --user|--group|--workspaces|--daemon-user)
      (( $# >= 2 )) && [[ -n $2 ]] || fail "$1 requires a value"
      case $1 in
        --user) bot_user=$2 ;;
        --group) bot_group=$2 ;;
        --workspaces) workspaces=$2 ;;
        --daemon-user) daemon_user=$2 ;;
      esac
      shift 2
      ;;
    --help)
      printf '%s\n' 'Usage: sudo scripts/setup-bot-user.sh [--user USER] [--group GROUP] [--workspaces DIR] [--daemon-user USER]'
      exit 0
      ;;
    *) fail "unknown option $1" ;;
  esac
done

(( EUID == 0 )) || fail 'run with sudo'
for name in "$bot_user" "$bot_group" "$daemon_user"; do
  [[ $name =~ ^[a-zA-Z_][a-zA-Z0-9_-]*[$]?$ ]] || fail 'invalid account or group name (use --daemon-user when SUDO_USER is unset)'
done
[[ $bot_user != "$daemon_user" && $bot_user != root ]] || fail 'the bot needs a separate unprivileged account'
[[ $bot_group != sudo && $bot_group != docker ]] || fail 'the bot needs an unprivileged group'

daemon_entry=$(getent passwd "$daemon_user") || fail "daemon account $daemon_user does not exist"
IFS=: read -r _ _ daemon_uid daemon_gid _ daemon_home _ <<< "$daemon_entry"
[[ $daemon_uid != 0 && -d $daemon_home ]] || fail 'the daemon needs a non-root account with a HOME directory'

[[ $workspaces == /* && $workspaces != *$'\n'* && $workspaces != *$'\r'* ]] || fail '--workspaces must be an absolute path on one line'
state=${YEWHOLT_HOME:-$daemon_home/.yewholt}
[[ $state == /* ]] || fail 'YEWHOLT_HOME must be absolute'
daemon_home=$(realpath -e -- "$daemon_home")
state=$(realpath -m -- "$state")
workspaces=$(realpath -m -- "$workspaces")
[[ $workspaces != / && $daemon_home != / ]] || fail 'the workspaces and daemon HOME cannot be the filesystem root'
[[ $workspaces != "$state" && $workspaces != "$state/"* && $state != "$workspaces/"* ]] || fail 'the workspaces must be outside YEWHOLT_HOME'
[[ $workspaces != "$daemon_home" && $workspaces != "$daemon_home/"* && $daemon_home != "$workspaces/"* ]] || fail 'choose workspaces outside the daemon HOME'

getent group "$bot_group" >/dev/null || /usr/sbin/groupadd --system "$bot_group"
IFS=: read -r _ _ group_id _ <<< "$(getent group "$bot_group")"
[[ $group_id != "$daemon_gid" && $group_id != 0 ]] || fail 'the bot group must be separate from the daemon primary group'
if id -- "$bot_user" >/dev/null 2>&1; then
  bot_uid=$(id -u -- "$bot_user")
  [[ $bot_uid != "$daemon_uid" && $bot_uid != 0 ]] || fail 'the existing bot account must have a separate unprivileged UID'
  /usr/sbin/usermod --gid "$bot_group" --shell /bin/bash --lock "$bot_user"
else
  /usr/sbin/useradd --system --gid "$bot_group" --home-dir /nonexistent --no-create-home --shell /bin/bash "$bot_user"
fi
bot_groups=$(id -Gn -- "$bot_user")
[[ $bot_groups == "$bot_group" ]] || fail "the bot must belong only to $bot_group (current groups: $bot_groups)"
/usr/sbin/usermod --append --groups "$bot_group" "$daemon_user"

chmod o-rwx,g-w -- "$daemon_home"
install -d -o "$bot_user" -g "$bot_group" -m 2770 -- "$workspaces"

sudoers_tmp=$(mktemp /etc/sudoers.d/.yewholt.XXXXXX)
trap 'rm -f -- "$sudoers_tmp"' EXIT
printf '%s ALL=(%s) NOPASSWD: ALL\n' "$daemon_user" "$bot_user" > "$sudoers_tmp"
chown root:root -- "$sudoers_tmp"
chmod 0440 -- "$sudoers_tmp"
/usr/sbin/visudo -cf "$sudoers_tmp"
mv -fT -- "$sudoers_tmp" /etc/sudoers.d/yewholt

# Write as the daemon account so the privileged script never opens or replaces its files as root.
# ENVIRON copies the workspace path literally, including backslashes and interior spaces.
sudo -n -u "$daemon_user" -- /bin/bash -s -- "$state" "$workspaces" <<'ENV_SCRIPT'
set -euo pipefail
umask 077
mkdir -p -- "$1"
file=$1/.env
if [[ -L $file || ( -e $file && ! -f $file ) ]]; then
  printf '%s\n' 'setup-bot-user: expected a regular .env file' >&2
  exit 1
fi
if [[ -e $file ]]; then
  source_file=$file
else
  source_file=/dev/null
fi
tmp=$(mktemp -- "$1/.env.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
YEWHOLT_SETUP_WORKSPACES=$2 awk '
  BEGIN { replacement = "YEWHOLT_WORKSPACES=" ENVIRON["YEWHOLT_SETUP_WORKSPACES"] }
  /^[[:space:]]*(export[[:space:]]+)?YEWHOLT_WORKSPACES[[:space:]]*=/ {
    if (!replaced++) print replacement
    next
  }
  { print }
  END { if (!replaced) print replacement }
' "$source_file" > "$tmp"
chmod 0600 -- "$tmp"
mv -fT -- "$tmp" "$file"
ENV_SCRIPT

printf 'Bot user groups: %s\n' "$(id -Gn -- "$bot_user")"
sudo -n -u "$daemon_user" -- sudo -n -u "$bot_user" -- /bin/true
printf 'Verified sudo access from %s to %s.\n' "$daemon_user" "$bot_user"
sudo -n -u "$bot_user" -- /bin/bash -c '[[ ! -r $1 && ! -x $1 ]]' yewholt "$daemon_home" ||
  fail 'the bot can access the daemon HOME or its access could not be verified'
printf 'Verified %s cannot access the daemon HOME.\n' "$bot_user"
printf '%s\n' 'Restart the daemon from a new login session so the group membership applies.'
