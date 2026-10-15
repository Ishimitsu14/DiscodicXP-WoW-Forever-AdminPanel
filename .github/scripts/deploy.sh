#!/usr/bin/env bash
set -euo pipefail
source .github/scripts/ssh.sh

remote_stage=''
cleanup() {
    if [[ "$remote_stage" =~ ^/tmp/discodicxp-ci\.[a-zA-Z0-9]{8}$ ]]; then
        ssh -F "$SSH_CONFIG" discodicxp "rm -rf -- '$remote_stage'" || true
    fi
    rm -rf -- "$ssh_directory"
}
trap cleanup EXIT

[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]]
archive="${RUNNER_TEMP}/discodicxp-server.tar.gz"
git archive --format=tar.gz --output="$archive" "$GITHUB_SHA" server public package.json package-lock.json
archive_hash="$(sha256sum "$archive" | cut -d ' ' -f 1)"
remote_stage="$(ssh -F "$SSH_CONFIG" discodicxp 'umask 077; mktemp -d /tmp/discodicxp-ci.XXXXXXXX')"
[[ "$remote_stage" =~ ^/tmp/discodicxp-ci\.[a-zA-Z0-9]{8}$ ]]
scp -F "$SSH_CONFIG" "$archive" "discodicxp:$remote_stage/server.tar.gz"
ssh -F "$SSH_CONFIG" discodicxp "bash -s -- '$remote_stage' '$archive_hash' '$GITHUB_SHA' '$DEPLOY_ORIGIN'" <<'REMOTE'
set -euo pipefail
cd "$1"
printf '%s  server.tar.gz\n' "$2" | sha256sum --check --status
tar -xzf server.tar.gz
if [[ "$(id -u)" == 0 ]]; then
    bash server/ci-deploy.sh "$PWD" "$3" "$4"
else
    sudo -n bash server/ci-deploy.sh "$PWD" "$3" "$4"
fi
REMOTE
printf 'Deployed %s to %s\n' "$GITHUB_SHA" "$DEPLOY_ORIGIN" >> "$GITHUB_STEP_SUMMARY"
