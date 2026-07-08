#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/release-npm.sh [patch|minor|major|prepatch|preminor|premajor|prerelease|x.y.z] [options]

Default:
  scripts/release-npm.sh patch

Options:
  --otp <code>       npm 2FA OTP. You can also set NPM_OTP instead.
  --tag <tag>        npm dist-tag to publish. Default: latest.
  --yes             Do not prompt before npm publish.
  --no-git          Do not create a release commit or git tag.
  --no-push         Do not push the release commit/tag to origin.
  --skip-audit      Skip npm audit --omit=dev.
  --skip-smoke      Skip fresh-install smoke test after publish.
  -h, --help        Show this help.

What this script does:
  1. Requires a clean tracked git working tree unless --no-git is used.
  2. Checks npm login and package self-dependency mistakes.
  3. Bumps package.json/package-lock.json with npm version --no-git-tag-version.
  4. Verifies the target npm version does not already exist.
  5. Runs npm audit --omit=dev, then npm run prepublishOnly.
  6. Runs npm pack --dry-run --json and blocks suspicious files.
  7. Scans pending/release diff for credential-shaped values without printing secrets.
  8. Optionally commits the version bump, publishes to npm, verifies registry state,
     runs a fresh install smoke test, tags v<version>, and optionally pushes.
USAGE
}

log() {
  printf '\n==> %s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup_release_tmp() {
  if [[ -n "${PACK_JSON:-}" ]]; then rm -f "$PACK_JSON"; fi
  if [[ -n "${PACK_PUBLISH_JSON:-}" ]]; then rm -f "$PACK_PUBLISH_JSON"; fi
  if [[ -n "${PACK_TGZ:-}" ]]; then rm -f "$PACK_TGZ"; fi
  if [[ -n "${TMP_DIR:-}" ]]; then rm -rf "$TMP_DIR"; fi
}
trap cleanup_release_tmp EXIT

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

BUMP="patch"
TAG="latest"
OTP="${NPM_OTP:-}"
ASSUME_YES=0
NO_GIT=0
NO_PUSH=0
SKIP_AUDIT=0
SKIP_SMOKE=0

if [[ $# -gt 0 && "${1:-}" != --* && "${1:-}" != "-h" ]]; then
  BUMP="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --otp)
      [[ $# -ge 2 ]] || die "--otp requires a value"
      OTP="$2"
      shift 2
      ;;
    --otp=*)
      OTP="${1#--otp=}"
      shift
      ;;
    --tag)
      [[ $# -ge 2 ]] || die "--tag requires a value"
      TAG="$2"
      shift 2
      ;;
    --tag=*)
      TAG="${1#--tag=}"
      shift
      ;;
    --yes)
      ASSUME_YES=1
      shift
      ;;
    --no-git)
      NO_GIT=1
      shift
      ;;
    --no-push)
      NO_PUSH=1
      shift
      ;;
    --skip-audit)
      SKIP_AUDIT=1
      shift
      ;;
    --skip-smoke)
      SKIP_SMOKE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

case "$BUMP" in
  patch|minor|major|prepatch|preminor|premajor|prerelease|[0-9]*.[0-9]*.[0-9]*) ;;
  *) die "Invalid version bump '$BUMP'. Use patch/minor/major/prerelease/etc. or an exact x.y.z version." ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

require_cmd node
require_cmd npm
require_cmd git

[[ -f package.json ]] || die "package.json not found in ${ROOT_DIR}"
[[ -f package-lock.json ]] || warn "package-lock.json not found; npm version will only update package.json."

PACKAGE_NAME="$(node -p "require('./package.json').name")"
OLD_VERSION="$(node -p "require('./package.json').version")"
PRIVATE_PKG="$(node -p "require('./package.json').private === true ? 'true' : 'false'")"

[[ -n "$PACKAGE_NAME" ]] || die "package.json name is empty"
[[ "$PRIVATE_PKG" != "true" ]] || die "package.json private=true; refusing to publish"

if [[ "$NO_GIT" -eq 0 ]]; then
  log "Checking git state"
  git rev-parse --is-inside-work-tree >/dev/null
  if [[ -n "$(git status --short --untracked-files=no)" ]]; then
    git status --short --untracked-files=no >&2
    die "Tracked working tree is not clean. Commit/stash changes before releasing."
  fi
  BRANCH="$(git branch --show-current)"
  [[ -n "$BRANCH" ]] || die "Detached HEAD is not supported unless --no-git is used."
else
  BRANCH=""
fi

log "Checking npm identity"
npm whoami >/dev/null
NPM_USER="$(npm whoami)"
printf 'npm user: %s\n' "$NPM_USER"
printf 'npm registry: %s\n' "$(npm config get registry)"

log "Checking package metadata and self-dependency"
node <<'NODE'
const pkg = require('./package.json');
const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const offenders = fields.filter((field) => pkg[field] && Object.prototype.hasOwnProperty.call(pkg[field], pkg.name));
if (offenders.length) {
  console.error(`Self dependency detected for ${pkg.name} in: ${offenders.join(', ')}`);
  process.exit(1);
}
console.log(JSON.stringify({ name: pkg.name, version: pkg.version, bin: pkg.bin, files: pkg.files }, null, 2));
NODE

log "Bumping version: ${OLD_VERSION} -> ${BUMP}"
npm version "$BUMP" --no-git-tag-version >/dev/null
NEW_VERSION="$(node -p "require('./package.json').version")"
[[ "$NEW_VERSION" != "$OLD_VERSION" ]] || die "Version did not change (${OLD_VERSION})."
printf 'new version: %s@%s\n' "$PACKAGE_NAME" "$NEW_VERSION"

log "Checking npm version immutability"
if npm view "${PACKAGE_NAME}@${NEW_VERSION}" version >/dev/null 2>&1; then
  die "${PACKAGE_NAME}@${NEW_VERSION} already exists on npm. Choose another version."
fi

if [[ "$NO_GIT" -eq 0 ]]; then
  RELEASE_TAG="v${NEW_VERSION}"
  if git rev-parse -q --verify "refs/tags/${RELEASE_TAG}" >/dev/null; then
    die "Local git tag already exists: ${RELEASE_TAG}"
  fi
  if git ls-remote --exit-code --tags origin "refs/tags/${RELEASE_TAG}" >/dev/null 2>&1; then
    die "Remote git tag already exists on origin: ${RELEASE_TAG}"
  fi
fi

if [[ "$SKIP_AUDIT" -eq 0 ]]; then
  log "Running production dependency audit"
  npm audit --omit=dev
else
  warn "Skipping npm audit --omit=dev"
fi

log "Running prepublish checks"
npm run prepublishOnly

log "Checking npm tarball contents with npm pack --dry-run"
PACK_JSON="$(mktemp)"
npm pack --dry-run --json >"$PACK_JSON"
node - "$PACK_JSON" <<'NODE'
const fs = require('fs');
const packPath = process.argv[2];
const data = JSON.parse(fs.readFileSync(packPath, 'utf8'))[0];
const suspicious = data.files
  .map((file) => file.path)
  .filter((path) => /(^|\/)\.claude-memory(\/|$)|(^|\/)graphify-out(\/|$)|cache|qrels|\.db$|\.sqlite|\.tgz$|^tests\/|^src\/|^specs\//.test(path));
console.log(JSON.stringify({
  name: data.name,
  version: data.version,
  filename: data.filename,
  fileCount: data.files.length,
  packageSize: data.size,
  unpackedSize: data.unpackedSize,
  suspicious,
}, null, 2));
if (suspicious.length) process.exit(1);
NODE

log "Scanning release diff for credential-shaped values"
node <<'NODE'
const { execFileSync } = require('child_process');
const patterns = [
  /(api[_-]?key|secret|password|token|app[_-]?secret|access[_-]?token|crtfc_key|hashkey|serviceKey)\s*[:=]\s*["']?[^"'\s,{]{8,}/i,
  /(api[_-]?key|token|serviceKey|crtfc_key|client_secret)=([^&\s"']{8,})/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
];
function git(args) {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}
let diff = git(['diff', '--unified=0', 'HEAD']);
const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim();
if (upstream) diff += '\n' + git(['diff', '--unified=0', `${upstream}...HEAD`]);
const findings = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++') && !line.includes('[REDACTED]') && patterns.some((pattern) => pattern.test(line)));
console.log(`credential_value_findings=${findings.length}`);
if (findings.length) process.exit(1);
NODE

log "Scanning public output for privacy leaks"
npm run check:public-output-privacy -- --json specs/agent-productivity-architecture scripts/release-npm.sh scripts/scan-public-output-privacy.ts

log "Packing and smoke-testing exact release tarball before publish"
PACK_PUBLISH_JSON="$(mktemp)"
npm pack --json >"$PACK_PUBLISH_JSON"
PACK_TGZ="$(node - "$PACK_PUBLISH_JSON" <<'NODE'
const fs = require('fs');
const path = require('path');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[0];
if (!data?.filename) process.exit(1);
console.log(path.resolve(data.filename));
NODE
)"
[[ -f "$PACK_TGZ" ]] || die "npm pack did not create expected tarball"
TMP_DIR="$(mktemp -d)"
pushd "$TMP_DIR" >/dev/null
npm init -y >/dev/null
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install "$PACK_TGZ"
BIN_NAME="$(node -e "const p=require('./node_modules/${PACKAGE_NAME}/package.json'); const bin=p.bin; console.log(typeof bin === 'string' ? p.name : Object.keys(bin || {})[0] || '')")"
if [[ -n "$BIN_NAME" && -x "./node_modules/.bin/${BIN_NAME}" ]]; then
  "./node_modules/.bin/${BIN_NAME}" --version
else
  warn "No executable bin found in packed tarball smoke test."
fi
node -e "const p=require('./node_modules/${PACKAGE_NAME}/package.json'); console.log(JSON.stringify({name:p.name, version:p.version, bin:p.bin, dependencies:p.dependencies, optionalDependencies:p.optionalDependencies}, null, 2))"
popd >/dev/null
rm -rf "$TMP_DIR"
TMP_DIR=""

if [[ "$NO_GIT" -eq 0 ]]; then
  log "Creating release commit"
  git add package.json package-lock.json
  git commit -m "chore(release): v${NEW_VERSION}"
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  printf '\nReady to publish %s@%s with dist-tag %s.\n' "$PACKAGE_NAME" "$NEW_VERSION" "$TAG"
  read -r -p "Proceed with npm publish? [y/N] " reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) die "Cancelled before npm publish. Version bump remains in the working tree or release commit." ;;
  esac
fi

log "Publishing to npm"
PUBLISH_ARGS=(--tag "$TAG")
if [[ -n "$OTP" ]]; then
  PUBLISH_ARGS+=(--otp "$OTP")
fi
if [[ "$PACKAGE_NAME" == @* ]]; then
  PUBLISH_ACCESS="$(node -p "require('./package.json').publishConfig?.access || ''")"
  if [[ "$PUBLISH_ACCESS" != "restricted" ]]; then
    PUBLISH_ARGS+=(--access public)
  fi
fi
npm publish "${PUBLISH_ARGS[@]}"

log "Verifying npm registry"
npm view "${PACKAGE_NAME}@${NEW_VERSION}" version
npm view "$PACKAGE_NAME" version dist-tags --json

if [[ "$SKIP_SMOKE" -eq 0 ]]; then
  log "Running fresh-install smoke test"
  TMP_DIR="$(mktemp -d)"
  pushd "$TMP_DIR" >/dev/null
  npm init -y >/dev/null
  ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install "${PACKAGE_NAME}@${NEW_VERSION}"
  BIN_NAME="$(node -e "const p=require('./node_modules/${PACKAGE_NAME}/package.json'); const bin=p.bin; console.log(typeof bin === 'string' ? p.name : Object.keys(bin || {})[0] || '')")"
  if [[ -n "$BIN_NAME" && -x "./node_modules/.bin/${BIN_NAME}" ]]; then
    "./node_modules/.bin/${BIN_NAME}" --version
  else
    warn "No executable bin found for smoke test."
  fi
  node -e "const p=require('./node_modules/${PACKAGE_NAME}/package.json'); console.log(JSON.stringify({name:p.name, version:p.version, bin:p.bin, dependencies:p.dependencies, optionalDependencies:p.optionalDependencies}, null, 2))"
  popd >/dev/null
  rm -rf "$TMP_DIR"
  TMP_DIR=""
else
  warn "Skipping fresh-install smoke test"
fi

if [[ "$NO_GIT" -eq 0 ]]; then
  log "Creating git tag v${NEW_VERSION}"
  git tag -a "v${NEW_VERSION}" -m "v${NEW_VERSION}"
  if [[ "$NO_PUSH" -eq 0 ]]; then
    log "Pushing release commit and tag"
    git push origin "$BRANCH"
    git push origin "v${NEW_VERSION}"
  else
    warn "Skipping git push. Push manually with: git push origin ${BRANCH} && git push origin v${NEW_VERSION}"
  fi
fi

log "Release complete: ${PACKAGE_NAME}@${NEW_VERSION}"
