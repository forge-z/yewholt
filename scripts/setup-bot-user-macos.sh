#!/bin/bash
set -euo pipefail

fail() { printf 'setup-bot-user-macos: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Darwin ]] || fail 'macOS only'
(( EUID == 0 )) || fail 'run with sudo'
bot_user=yewholt-bot
bot_group=yewholt-ws
workspaces=/Users/Shared/yewholt/workspaces
daemon_user=${SUDO_USER:-}
while (( $# )); do
  case $1 in
    --daemon-user|--workspaces)
      (( $# >= 2 )) || fail "$1 requires a value"
      case $1 in
        --daemon-user) daemon_user=$2 ;;
        --workspaces) workspaces=$2 ;;
      esac
      shift 2 ;;
    *) fail 'Usage: sudo scripts/setup-bot-user-macos.sh [--daemon-user USER] [--workspaces DIR]' ;;
  esac
done
[[ $daemon_user =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ && $daemon_user != root && $daemon_user != "$bot_user" ]] || fail 'choose a non-root daemon account'
daemon_uid=$(id -u "$daemon_user")
daemon_gid=$(id -g "$daemon_user")
[[ $daemon_uid != 0 ]] || fail 'daemon must not be root'
daemon_home=$(dscl . -read "/Users/$daemon_user" NFSHomeDirectory | sed 's/^NFSHomeDirectory: //')
[[ -d $daemon_home ]] || fail 'daemon HOME is missing'
state=${YEWHOLT_HOME:-$daemon_home/.yewholt}
[[ $state == /* && $workspaces == /* && $workspaces != *$'\n'* && $workspaces != *$'\r'* ]] || fail 'paths must be absolute and on one line'
node_bin=$(command -v node) || fail 'Node must be on PATH; use sudo env PATH="$PATH"'
# Canonicalize missing paths without GNU realpath, including existing symlinks.
canonical() {
  /usr/bin/sudo -H -u "$daemon_user" "$node_bin" --input-type=module -e '
    import {realpathSync, existsSync} from "node:fs";
    import {resolve, dirname, basename, join} from "node:path";
    function physical(p) { return existsSync(p) ? realpathSync(p) : join(physical(dirname(p)), basename(p)); }
    console.log(physical(resolve(process.argv[1])));
  ' "$1"
}
daemon_home=$(canonical "$daemon_home")
state=$(canonical "$state")
workspaces=$(canonical "$workspaces")
[[ $workspaces != / && $daemon_home != / ]] || fail 'root directory is not allowed'
[[ $workspaces != "$state" && $workspaces != "$state/"* && $state != "$workspaces/"* ]] || fail 'workspaces must be outside state'
[[ $workspaces != "$daemon_home" && $workspaces != "$daemon_home/"* && $daemon_home != "$workspaces/"* ]] || fail 'workspaces must be outside daemon HOME'

if ! dscl . -read "/Groups/$bot_group" >/dev/null 2>&1; then
  dseditgroup -o create "$bot_group"
fi
group_id=$(dscl . -read "/Groups/$bot_group" PrimaryGroupID | awk '{print $2}')
[[ $group_id != 0 && $group_id != "$daemon_gid" ]] || fail 'workspace group must be separate'
if ! dscl . -read "/Users/$bot_user" >/dev/null 2>&1; then
  uid=400
  while dscl . -search /Users UniqueID "$uid" | read -r _; do uid=$((uid + 1)); done
  (( uid < 500 )) || fail 'no free hidden system UID (400-499)'
  dscl . -create "/Users/$bot_user"
  dscl . -create "/Users/$bot_user" UniqueID "$uid"
  dscl . -create "/Users/$bot_user" PrimaryGroupID "$group_id"
fi
[[ $(id -u "$bot_user") != 0 && $(id -u "$bot_user") != "$daemon_uid" ]] || fail 'bot must have separate UID'
bot_groups=$(id -Gn "$bot_user")
explicit_groups=()
for group in $bot_groups; do
  case $group in
    everyone|localaccounts) ;;
    *) explicit_groups+=("$group") ;;
  esac
done
[[ $(id -g "$bot_user") == "$group_id" && ${#explicit_groups[@]} == 1 && ${explicit_groups[0]} == "$bot_group" ]] || fail 'bot must belong only to workspace group (apart from everyone/localaccounts)'
dscl . -create "/Users/$bot_user" IsHidden 1
dscl . -create "/Users/$bot_user" UserShell /usr/bin/false
dscl . -create "/Users/$bot_user" NFSHomeDirectory /var/empty
dscl . -create "/Users/$bot_user" Password '*'
dseditgroup -o edit -a "$daemon_user" -t user "$bot_group"
chmod o-rwx,g-w "$daemon_home"
mkdir -p "$workspaces"
chown "$bot_user:$bot_group" "$workspaces"
chmod 2770 "$workspaces"

sudoers_tmp=$(mktemp /etc/sudoers.d/.yewholt.XXXXXX)
trap 'rm -f "$sudoers_tmp"' EXIT
printf '%s ALL=(%s) NOPASSWD: ALL\n' "$daemon_user" "$bot_user" > "$sudoers_tmp"
chown root:wheel "$sudoers_tmp"
chmod 0440 "$sudoers_tmp"
/usr/sbin/visudo -cf "$sudoers_tmp"
mv -f "$sudoers_tmp" /etc/sudoers.d/yewholt

sudo -H -u "$daemon_user" /bin/bash -s -- "$state" "$workspaces" <<'ENV_SCRIPT'
set -euo pipefail
umask 077
mkdir -p "$1"
file=$1/.env
[[ ! -L $file && ( ! -e $file || -f $file ) ]] || exit 1
source_file=/dev/null
[[ ! -e $file ]] || source_file=$file
tmp=$(mktemp "$1/.env.XXXXXX")
trap 'rm -f "$tmp"' EXIT
YEWHOLT_SETUP_WORKSPACES=$2 awk '
  BEGIN { replacement = "YEWHOLT_WORKSPACES=" ENVIRON["YEWHOLT_SETUP_WORKSPACES"] }
  /^[[:space:]]*(export[[:space:]]+)?YEWHOLT_WORKSPACES[[:space:]]*=/ { if (!replaced++) print replacement; next }
  { print }
  END { if (!replaced) print replacement }
' "$source_file" > "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$file"
ENV_SCRIPT
sudo -H -u "$daemon_user" sudo -n -u "$bot_user" /bin/true
sudo -n -u "$bot_user" /bin/bash -c '[[ ! -r $1 && ! -x $1 ]]' yewholt "$daemon_home" || fail 'bot can access daemon HOME'
printf '%s\n' 'Restart the daemon from a new login session so group membership applies.'
