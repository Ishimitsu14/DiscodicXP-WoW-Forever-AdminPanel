#!/usr/bin/env bash
set -euo pipefail

source_path="${1:-}"
revision="${2:-}"
origin="${3:-}"
install_path="${DISCODICXP_INSTALL_PATH:-/opt/discodicxp-update}"
runtime_path="${DISCODICXP_RUNTIME_PATH:-/opt/discodicxp-node/current/bin}"
lock_path="${DISCODICXP_LOCK_PATH:-/run/lock/discodicxp-deploy.lock}"
if [[ "$EUID" != 0 || ! "$revision" =~ ^[a-f0-9]{40}$ \
    || ! "$origin" =~ ^https://[a-zA-Z0-9][a-zA-Z0-9.-]*(:[0-9]{1,5})?$ \
    || "$source_path" != /* || "$install_path" != /* || -L "$install_path" \
    || ! -d "$install_path/server" || ! -d "$source_path/server" || ! -d "$source_path/public" \
    || ! -f "$source_path/package.json" || ! -f "$source_path/package-lock.json" \
    || ! -x "$runtime_path/node" || ! -x "$runtime_path/npm" ]]; then
    echo 'CI deployment requires root, an installed service, a complete release, a revision and an HTTPS origin.' >&2
    exit 1
fi
exec 9>"$lock_path"
flock -w 120 9
stage="$(mktemp -d "$install_path.next.XXXXXXXX")"
backup="$stage.previous"
stopped=false
previous_moved=false

cleanup() {
    status=$?
    trap - EXIT
    if [[ "$status" != 0 && "$stopped" == true ]]; then
        if [[ "$previous_moved" == true ]]; then
            if [[ -d "$install_path" ]]; then mv -- "$install_path" "$stage.failed"; fi
            mv -- "$backup" "$install_path"
        fi
        systemctl restart discodicxp-update || true
        echo 'Deployment failed; previous code restored. Persistent data was not rolled back.' >&2
    fi
    rm -rf -- "$stage"
    exit "$status"
}
trap cleanup EXIT

cp -a -- "$source_path/server" "$source_path/public" "$source_path/package.json" "$source_path/package-lock.json" "$stage/"
PATH="$runtime_path:$PATH" "$runtime_path/npm" ci --prefix "$stage" --omit=dev --ignore-scripts
printf '%s\n' "$revision" > "$stage/.deploy-revision"
chmod -R u=rwX,go=rX "$stage"
stopped=true
systemctl stop discodicxp-update
mv -- "$install_path" "$backup"
previous_moved=true
mv -- "$stage" "$install_path"
systemctl start discodicxp-update

healthy=false
for attempt in {1..20}; do
    if systemctl is-active --quiet discodicxp-update \
        && curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/health >/dev/null; then
        healthy=true
        break
    fi
    sleep 1
done
if [[ "$healthy" != true ]]; then
    echo 'Service health check failed.' >&2
    exit 1
fi
curl --fail --silent --show-error --max-time 20 "$origin/health" >/dev/null
stopped=false
printf 'Deployed revision: %s\nPrevious code: %s\n' "$revision" "$backup"
