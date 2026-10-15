#!/usr/bin/env bash
set -euo pipefail

source_file="${1:-}"
expected_sha="${2:-}"
version="${3:-}"
download_root="${DISCODICXP_DOWNLOADS_PATH:-/srv/discodicxp-downloads}"
if [[ "$EUID" != 0 || ! -f "$source_file" || ! "$expected_sha" =~ ^[a-f0-9]{64}$ || ! "$version" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$ || "$download_root" != /* ]]; then
    echo 'Usage as root: bash server/publish-launcher.sh /absolute/launcher.exe <sha256> <version>' >&2
    exit 1
fi
actual_sha="$(sha256sum -- "$source_file" | cut -d ' ' -f 1)"
size="$(stat -c %s -- "$source_file")"
if [[ "$actual_sha" != "$expected_sha" || "$(head -c 2 -- "$source_file")" != MZ || "$size" -gt 134217728 ]]; then
    echo 'Launcher checksum or executable header does not match.' >&2
    exit 1
fi
install -d -m 755 "$download_root/launcher"
temporary="$(mktemp "$download_root/launcher.XXXXXXXX.partial")"
checksum_temporary="$(mktemp "$download_root/checksum.XXXXXXXX.partial")"
manifest_temporary="$(mktemp "$download_root/launcher/manifest.XXXXXXXX.partial")"
immutable_temporary="$(mktemp "$download_root/launcher/binary.XXXXXXXX.partial")"
trap 'rm -f -- "$temporary" "$checksum_temporary" "$manifest_temporary" "$immutable_temporary"' EXIT
install -m 644 "$source_file" "$temporary"
if [[ "$(sha256sum -- "$temporary" | cut -d ' ' -f 1)" != "$expected_sha" ]]; then
    echo 'Launcher changed during publication.' >&2
    exit 1
fi
install -m 644 "$temporary" "$immutable_temporary"
printf '{"version":"%s","sha256":"%s","size":%s,"downloadPath":"/downloads/launcher/%s.exe"}\n' "$version" "$actual_sha" "$size" "$actual_sha" > "$manifest_temporary"
printf '%s  DiscodicXP.Launcher.exe\n' "$actual_sha" > "$checksum_temporary"
chmod 644 "$checksum_temporary" "$manifest_temporary"
mv -f -- "$immutable_temporary" "$download_root/launcher/$actual_sha.exe"
mv -f -- "$temporary" "$download_root/DiscodicXP.Launcher.exe"
mv -f -- "$checksum_temporary" "$download_root/DiscodicXP.Launcher.exe.sha256"
mv -f -- "$manifest_temporary" "$download_root/launcher/latest.json"
printf 'Launcher published: /downloads/DiscodicXP.Launcher.exe\n'
