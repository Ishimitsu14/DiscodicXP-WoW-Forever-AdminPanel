#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" != 0 ]]; then
    echo 'Run as root: bash /opt/discodicxp-update/server/create-admin.sh' >&2
    exit 1
fi
read -r -p 'Admin login [admin]: ' admin_login
admin_login="${admin_login:-admin}"
read -r -s -p 'New admin password (12+ characters): ' admin_password
printf '\n'
read -r -s -p 'Repeat password: ' admin_confirmation
printf '\n'
trap 'unset admin_password admin_confirmation' EXIT
if [[ "$admin_password" != "$admin_confirmation" ]]; then
    echo 'Passwords do not match.' >&2
    exit 1
fi
printf '%s\0%s' "$admin_login" "$admin_password" | runuser -u discodicxp-update -- \
    env DATABASE_PATH=/var/lib/discodicxp/discodicxp.sqlite \
    /opt/discodicxp-node/current/bin/node /opt/discodicxp-update/server/setup.mjs --stdin
