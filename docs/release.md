# MeteorAgent Release Checklist

MeteorAgent releases are downloadable files, not public npm-registry publications. Each release contains one audited cross-platform npm tarball plus separate Windows and macOS launchers.

## 1. Preflight

Run from a clean release branch:

```bash
git status --short --branch
git log --oneline --decorate -5
gh auth status
node -e "const p=require('./package.json'); console.log(p.version, p.engines.node)"
npm test
npx tsc --noEmit
npm run lint
npm audit --omit=dev --registry=https://registry.npmjs.org/
```

The source tree must be clean. Release builds are the explicit exception to the normal rule against running `next build` during development.

## 2. Build the customer artifacts

The private companion workspace `meteoragent-brand` performs an isolated locked build, verifies the tarball, and creates the update manifest:

```bash
cd ../meteoragent-brand
bash build.sh
bash scripts/make-launchers.sh
```

Use the exact `release.*` and `launchers.*` directories printed by those commands:

```bash
RELEASE_DIR=/absolute/release.directory \
LAUNCHER_DIR=/absolute/launchers.directory \
bash scripts/assemble-customer-release.sh
```

The final `customer-release.<version>.*` directory must contain only:

- `meteor21c-webagent-<version>.tgz`
- `MeteorAgent-launcher-Windows.zip`
- `MeteorAgent-launcher-macOS.zip`
- `latest.json`
- `source.json`
- `README-client.txt`
- `SHA256SUMS`

The `.tgz` is portable. The launchers are separated because Windows uses BAT/PowerShell/VBS/ICO while macOS uses an app bundle/ICNS and has different unsigned-app instructions. Both support x64 and ARM64 through the customer's installed Node.js runtime.

## 3. Smoke test

Install the generated tarball into a fresh temporary npm prefix, run `webagent --help`, start it on a free loopback port, and verify `/api/relay-health` reports `MeteorAgent` and `ok`. Also verify both ZIP files with `unzip -t`.

Windows launcher behavior cannot be fully executed on macOS; GitHub CI plus static PowerShell/BAT inspection is the minimum first-release check until a Windows runner is added.

## 4. Commit, tag, and push

Use the product-specific tag namespace so it cannot be confused with upstream tags:

```bash
git tag -a meteoragent-v<version> -m "MeteorAgent v<version>"
git push meteor ui/visual-refresh
git push meteor meteoragent-v<version>
```

## 5. Publish

Create a GitHub Release in `Meteor21c/pi-web` and attach every file from the clean customer directory. Then deploy the same main tarball, manifest, download page, and the two launcher ZIPs to `dl.meteor21c.fun`.

Do not publish the private brand/deployment repository: it contains infrastructure details. Never put customer credentials, API keys, SSH passwords, `.env` files, local caches, traces, or personal build paths in an artifact.

## 6. Final verification

Verify all of the following from an external network when possible:

```bash
gh release view meteoragent-v<version> --repo Meteor21c/pi-web
curl -fsS https://dl.meteor21c.fun/webagent/latest.json
curl -fI https://dl.meteor21c.fun/webagent/latest.tgz
curl -fI https://dl.meteor21c.fun/launcher/MeteorAgent-launcher-Windows.zip
curl -fI https://dl.meteor21c.fun/launcher/MeteorAgent-launcher-macOS.zip
```

The manifest SHA-256 must match both the download-server tarball and the GitHub Release asset. Keep the GitHub Release links as the fallback if the regional download path is unavailable.
