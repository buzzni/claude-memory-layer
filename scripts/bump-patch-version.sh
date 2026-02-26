#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${ROOT_DIR}"

if [[ ! -f package.json ]]; then
  echo "Error: package.json not found in ${ROOT_DIR}" >&2
  exit 1
fi

old_version="$(node -p "require('./package.json').version")"
npm version patch --no-git-tag-version >/dev/null
new_version="$(node -p "require('./package.json').version")"

echo "Version bumped: ${old_version} -> ${new_version}"
