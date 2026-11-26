#!/bin/bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: bash desktop/package-windows.sh <customer-release-directory> [output-directory]" >&2
  exit 1
fi

desktop_dir=$(cd "$(dirname "$0")" && pwd)
release_dir=$(cd "$1" && pwd)
output_root=${2:-"$desktop_dir/../../meteoragent-brand/dist"}
makensis_bin=${MAKENSIS_BIN:-makensis}
node_bin=$(command -v node)
npm_bin=$(command -v npm)
command -v "$makensis_bin" >/dev/null

# Digests from Electron's GitHub release and nodejs.org/dist/v24.22.3/SHASUMS256.txt.
electron_version=45.5.0
electron_archive="electron-v$electron_version-win32-x64.zip"
electron_sha=20155c8b8aa5b1f575f3757bdf21490e0bac2f19a65a26ce9ba99bcf9f2c69bd
node_version=24.22.3
node_release="node-v$node_version-win-x64"
node_archive="$node_release.zip"
node_sha=e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f

sha256() {
  shasum -a 256 < "$1" | awk '{ print $1 }'
}

verify_archive() {
  if [[ $(sha256 "$1") != "$2" ]]; then
    echo "SHA-256 mismatch: $1" >&2
    return 1
  fi
}

read -r agent_version agent_archive agent_sha < <(python3 - "$release_dir/latest.json" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    manifest = json.load(stream)
version, artifact, digest = (manifest[k] for k in ("version", "artifact", "sha256"))
if (
    not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version)
    or artifact != f"meteor21c-webagent-{version}.tgz"
    or not re.fullmatch(r"[0-9a-f]{64}", digest)
    or manifest.get("sourceDirty") is not False
):
    raise SystemExit("Expected a clean, versioned MeteorAgent release manifest")
print(version, artifact, digest)
PY
)
verify_archive "$release_dir/$agent_archive" "$agent_sha"

stage=$(mktemp -d "${TMPDIR:-/tmp}/meteoragent-desktop-win-x64.XXXXXXXX")
app="$stage/app"
resources="$app/resources"
webagent="$resources/runtime/webagent"
icon="$desktop_dir/assets/magent-desktop.ico"
echo "Staged app: $app"

fetch_archive() {
  local filename=$1 url=$2 expected=$3
  local destination="$stage/$filename"
  if [[ -n ${METEOR_DESKTOP_DOWNLOAD_DIR:-} && -f "$METEOR_DESKTOP_DOWNLOAD_DIR/$filename" ]]; then
    destination="$METEOR_DESKTOP_DOWNLOAD_DIR/$filename"
  else
    if ! curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 \
      --max-time 240 "$url" -o "$destination"; then
      if [[ "$filename" != "$electron_archive" ]]; then return 1; fi
      curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 \
        --max-time 240 "https://npmmirror.com/mirrors/electron/$electron_version/$filename" -o "$destination" || return 1
    fi
  fi
  verify_archive "$destination" "$expected" || return 1
  printf '%s\n' "$destination"
}

electron_zip=$(fetch_archive "$electron_archive" \
  "https://github.com/electron/electron/releases/download/v$electron_version/$electron_archive" "$electron_sha")
node_zip=$(fetch_archive "$node_archive" \
  "https://nodejs.org/dist/v$node_version/$node_archive" "$node_sha")

mkdir -p "$app" "$stage/node" "$stage/tools"
unzip -q "$electron_zip" -d "$app"
unzip -q "$node_zip" -d "$stage/node"
mv "$resources/default_app.asar" "$stage/default_app.asar"
mkdir -p "$resources/app" "$resources/runtime" "$webagent"
mv "$stage/node/$node_release" "$resources/runtime/node"
tar -xzf "$release_dir/$agent_archive" --strip-components 1 -C "$webagent"

echo "Installing locked Windows x64 application dependencies…"
touch "$stage/user.npmrc" "$stage/global.npmrc"
npm_args=(
  --ignore-scripts --no-audit --no-fund
  --cache "${METEOR_DESKTOP_NPM_CACHE_DIR:-$stage/npm-cache}"
  --registry https://registry.npmmirror.com
  --userconfig "$stage/user.npmrc" --globalconfig "$stage/global.npmrc"
)
(
  cd "$webagent"
  test "$("$node_bin" -p 'require("./package.json").version')" = "$agent_version"
  test -f npm-shrinkwrap.json
  test -f .next/BUILD_ID
  "$npm_bin" ci --omit=dev --os=win32 --cpu=x64 --bin-links=false "${npm_args[@]}"
  "$node_bin" bin/prepare-runtime.js
  test -f node_modules/@next/swc-win32-x64-msvc/next-swc.win32-x64-msvc.node
  test -f node_modules/node-pty/prebuilds/win32-x64/conpty.node
  test -f node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe
  test -f node_modules/@img/sharp-win32-x64/lib/libvips-42.dll
  if [[ -d node_modules/.meteoragent-runtime-backups ]]; then
    mv node_modules/.meteoragent-runtime-backups "$stage/runtime-backups"
  fi
  mkdir -p "$stage/cross-platform-pty"
  for prebuild in node_modules/node-pty/prebuilds/*; do
    if [[ ${prebuild##*/} != win32-x64 ]]; then
      mv "$prebuild" "$stage/cross-platform-pty/"
    fi
  done
)

echo "Applying the MeteorAgent executable icon…"
cp "$desktop_dir/windows/tools/"{package.json,package-lock.json} "$stage/tools/"
(
  cd "$stage/tools"
  "$npm_bin" ci "${npm_args[@]}"
)
cp "$desktop_dir/windows/brand-exe.mjs" "$stage/tools/"
"$node_bin" "$stage/tools/brand-exe.mjs" "$app/electron.exe" "$icon" "$app/MeteorAgent Beta.exe" "$agent_version"
mv "$app/electron.exe" "$stage/electron.exe"
cp "$desktop_dir/main.cjs" "$desktop_dir/preload.cjs" "$desktop_dir/server.cjs" "$desktop_dir/assets/magent-desktop.png" "$resources/app/"
python3 - "$resources/app/package.json" "$agent_version" <<'PY'
import json
import sys
from pathlib import Path

path, version = sys.argv[1:]
Path(path).write_text(json.dumps({
    "name": "meteoragent-desktop-beta",
    "productName": "MeteorAgent Beta",
    "version": version,
    "main": "main.cjs",
}, indent=2) + "\n", encoding="utf-8")
PY

mkdir -p "$output_root"
output_root=$(cd "$output_root" && pwd)
output=$(mktemp -d "$output_root/desktop-beta-windows.$agent_version.XXXXXXXX")
setup="$output/MeteorAgent-Desktop-Beta-$agent_version-Windows-x64-Setup.exe"
echo "Creating an offline Windows installer…"
"$makensis_bin" -INPUTCHARSET UTF8 -NOCD "-DAPP_STAGE=$app" "-DAPP_ICON=$icon" \
  "-DAPP_VERSION=$agent_version" "-DAPP_INSTALLER=$setup" "$desktop_dir/windows/installer.nsi"
cp "$desktop_dir/windows/安装说明.md" "$output/安装说明.md"
(cd "$output" && shasum -a 256 "$(basename "$setup")" 安装说明.md > SHA256SUMS)
printf 'Installer: %s\n' "$setup"
