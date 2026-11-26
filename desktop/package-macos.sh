#!/bin/bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || $(uname -s) != Darwin || $(uname -m) != arm64 ]]; then
  echo "Usage on Apple Silicon macOS: bash desktop/package-macos.sh <customer-release-directory> [output-directory]" >&2
  exit 1
fi

desktop_dir=$(cd "$(dirname "$0")" && pwd)
release_dir=$(cd "$1" && pwd)
output_root=${2:-"$desktop_dir/../../meteoragent-brand/dist"}
icon_source="$desktop_dir/assets/magent-desktop.png"
app_name="MeteorAgent Beta"
bundle_id="fun.meteor21c.magent.desktop.beta"

# Digests from Electron's GitHub release and nodejs.org/dist/v24.22.3/SHASUMS256.txt.
electron_version=45.5.0
electron_archive="electron-v$electron_version-darwin-arm64.zip"
electron_sha256=00d345b061064de7e6e2c02bec7ffa1adb7ef488fe4b673bd8ad3e059a182245
node_version=24.22.3
node_archive="node-v$node_version-darwin-arm64.tar.gz"
node_sha256=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd

sha256() {
  shasum -a 256 < "$1" | awk '{ print $1 }'
}

verify_archive() {
  if [[ $(sha256 "$1") != "$2" ]]; then
    echo "SHA-256 mismatch: $1" >&2
    return 1
  fi
}

read -r agent_version agent_archive agent_sha256 < <(python3 - "$release_dir/latest.json" <<'PY'
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
verify_archive "$release_dir/$agent_archive" "$agent_sha256"
test -f "$desktop_dir/main.cjs"
test -f "$desktop_dir/preload.cjs"
test -f "$desktop_dir/server.cjs"
test -f "$icon_source"

stage=$(mktemp -d "${TMPDIR:-/tmp}/meteoragent-desktop-arm64.XXXXXXXX")
image="$stage/image"
app="$image/$app_name.app"
resources="$app/Contents/Resources"
echo "Staged app: $app"

# An optional directory of exact upstream archives can be reused for local builds.
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

echo "Verifying Electron and Node.js distributions…"
electron_zip=$(fetch_archive "$electron_archive" \
  "https://github.com/electron/electron/releases/download/v$electron_version/$electron_archive" "$electron_sha256")
node_tarball=$(fetch_archive "$node_archive" \
  "https://nodejs.org/dist/v$node_version/$node_archive" "$node_sha256")

mkdir -p "$stage/electron" "$image"
ditto -x -k "$electron_zip" "$stage/electron"
mv "$stage/electron/Electron.app" "$app"
mv "$resources/default_app.asar" "$stage/electron/default_app.asar"
mkdir -p "$resources/app" "$resources/notices" "$resources/runtime/node" "$resources/runtime/webagent"
for notice in LICENSE LICENSES.chromium.html; do
  if [[ -f "$stage/electron/$notice" ]]; then
    cp "$stage/electron/$notice" "$resources/notices/$notice"
  fi
done
cp "$desktop_dir/main.cjs" "$desktop_dir/preload.cjs" "$desktop_dir/server.cjs" "$resources/app/"
cp "$icon_source" "$resources/app/magent-desktop.png"
# node-gyp obtains versioned headers as needed. The app's runtime uses the
# bundled Node executable, npm, and prebuilt native libraries.
tar -xzf "$node_tarball" --strip-components 1 \
  --exclude "node-v$node_version-darwin-arm64/include" -C "$resources/runtime/node"
tar -xzf "$release_dir/$agent_archive" --strip-components 1 -C "$resources/runtime/webagent"

node_bin="$resources/runtime/node/bin/node"
npm_cli="$resources/runtime/node/lib/node_modules/npm/bin/npm-cli.js"
webagent="$resources/runtime/webagent"
test "$("$node_bin" -p '`${process.platform}-${process.arch}-${process.versions.node}`')" = "darwin-arm64-$node_version"

echo "Installing locked application dependencies into the bundle…"
touch "$stage/user.npmrc" "$stage/global.npmrc"
(
  cd "$webagent"
  test "$("$node_bin" -p 'require("./package.json").version')" = "$agent_version"
  test -f npm-shrinkwrap.json
  test -f .next/BUILD_ID
  PATH="$resources/runtime/node/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    "$node_bin" "$npm_cli" ci --omit=dev --ignore-scripts --no-audit --no-fund \
    --cache "${METEOR_DESKTOP_NPM_CACHE_DIR:-$stage/npm-cache}" \
    --registry https://registry.npmmirror.com --userconfig "$stage/user.npmrc" --globalconfig "$stage/global.npmrc"
  "$node_bin" bin/prepare-runtime.js
  "$node_bin" bin/prepare-terminal.js
  test -x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
  "$node_bin" -e 'require("node-pty"); require("next/package.json")'
  if [[ -d node_modules/.meteoragent-runtime-backups ]]; then
    mv node_modules/.meteoragent-runtime-backups "$stage/runtime-backups"
  fi
)

# A signed app bundle must stay read-only even when Next renders a new page.
mv "$webagent/next.config.ts" "$webagent/next.config.original.ts"
cat > "$webagent/next.config.ts" <<'NEXT_CONFIG'
import originalConfig from "./next.config.original";

export default {
  ...originalConfig,
  experimental: {
    ...originalConfig.experimental,
    isrFlushToDisk: false,
  },
};
NEXT_CONFIG

python3 - "$app" "$agent_version" "$app_name" "$bundle_id" <<'PY'
import json
import plistlib
import sys
from pathlib import Path

app, version, name, bundle_id = sys.argv[1:]
contents = Path(app) / "Contents"
plist_path = contents / "Info.plist"
with plist_path.open("rb") as stream:
    metadata = plistlib.load(stream)
metadata.update({
    "CFBundleIdentifier": bundle_id,
    "CFBundleName": name,
    "CFBundleDisplayName": name,
    "CFBundleShortVersionString": version,
    "CFBundleVersion": version,
    "CFBundleIconFile": "MeteorAgent.icns",
    "CFBundleIconName": "MeteorAgent",
    # The bundled Node binary's Mach-O deployment target is newer than Electron's.
    "LSMinimumSystemVersion": "13.5",
})
with plist_path.open("wb") as stream:
    plistlib.dump(metadata, stream)
(contents / "Resources/app/package.json").write_text(json.dumps({
    "name": "meteoragent-desktop-beta",
    "productName": name,
    "version": version,
    "main": "main.cjs",
}, indent=2) + "\n", encoding="utf-8")
PY

# Provide the bitmap fallback for macOS versions before Tahoe.
iconset="$stage/MeteorAgent.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  double=$((size * 2))
  sips -z "$size" "$size" "$icon_source" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$double" "$double" "$icon_source" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$resources/MeteorAgent.icns"

# Tahoe frames legacy-only app icons in gray. Compile a native icon stack
# from the shared artwork, with the bitmap above as the legacy resource.
icon_document="$stage/MeteorAgent.icon"
compiled_icons="$stage/compiled-icons"
mkdir -p "$icon_document/Assets" "$compiled_icons"
cp "$desktop_dir/assets/magent-macos-icon.json" "$icon_document/icon.json"
cp "$icon_source" "$icon_document/Assets/Art.png"
xcrun actool "$icon_document" --compile "$compiled_icons" \
  --platform macosx --target-device mac --minimum-deployment-target 13.5 \
  --app-icon MeteorAgent --output-partial-info-plist "$stage/icon.plist" \
  --output-format human-readable-text
cp "$compiled_icons/Assets.car" "$resources/Assets.car"

# Apple Silicon executes signed code. This local ad-hoc signature uses no developer identity.
echo "Applying and verifying a local ad-hoc signature…"
codesign --force --deep --sign - --preserve-metadata=entitlements "$app"
codesign --verify --deep --strict "$app"
ln -s /Applications "$image/Applications"

mkdir -p "$output_root"
output_root=$(cd "$output_root" && pwd)
output=$(mktemp -d "$output_root/desktop-beta.$agent_version.XXXXXXXX")
dmg="$output/MeteorAgent-Desktop-Beta-$agent_version-macOS-arm64.dmg"
echo "Creating disk image…"
hdiutil create -srcfolder "$image" -volname "$app_name" -format UDZO -imagekey zlib-level=9 "$dmg"
hdiutil verify "$dmg"
(cd "$output" && shasum -a 256 "$(basename "$dmg")" > SHA256SUMS)
printf 'Installer: %s\n' "$dmg"
