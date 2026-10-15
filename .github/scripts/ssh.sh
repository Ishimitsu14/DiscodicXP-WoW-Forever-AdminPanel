set -euo pipefail

for setting in DEPLOY_HOST DEPLOY_USER DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS; do
    if [[ -z "${!setting:-}" ]]; then
        echo "Missing GitHub Actions secret: $setting" >&2
        exit 1
    fi
done
DEPLOY_PORT="${DEPLOY_PORT:-22}"
DEPLOY_ORIGIN="${DEPLOY_ORIGIN:-https://$DEPLOY_HOST}"
if [[ ! "$DEPLOY_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ || ! "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ \
    || ! "$DEPLOY_PORT" =~ ^[0-9]{1,5}$ || "$DEPLOY_PORT" -lt 1 || "$DEPLOY_PORT" -gt 65535 \
    || ! "$DEPLOY_ORIGIN" =~ ^https://[a-zA-Z0-9][a-zA-Z0-9.-]*(:[0-9]{1,5})?$ ]]; then
    echo 'Invalid SSH connection settings or HTTPS origin.' >&2
    exit 1
fi
umask 077
ssh_directory="$(mktemp -d "${RUNNER_TEMP:-/tmp}/discodicxp-ssh.XXXXXXXX")"
printf '%s\n' "$DEPLOY_SSH_KEY" > "$ssh_directory/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$ssh_directory/known_hosts"
SSH_CONFIG="$ssh_directory/config"
cat > "$SSH_CONFIG" <<CONFIG
Host discodicxp
    HostName $DEPLOY_HOST
    User $DEPLOY_USER
    Port $DEPLOY_PORT
    IdentityFile "$ssh_directory/key"
    UserKnownHostsFile "$ssh_directory/known_hosts"
    StrictHostKeyChecking yes
    IdentitiesOnly yes
    BatchMode yes
    ConnectTimeout 15
CONFIG
unset DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS
