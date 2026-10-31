#!/usr/bin/env node
/**
 * Copies package.json's version into every shipped manifest that carries its
 * own version field. Wired as package.json's `version` lifecycle script, so the
 * documented release step `npm version <x> --no-git-tag-version` rewrites them
 * right after the bump and `git commit -am` picks them up with package.json.
 * package-lock.json is not listed: npm version already rewrites it.
 *
 * scripts/guard-release-artifact.cjs `manifest-versions` checks the same list.
 *
 * Usage:
 *   node scripts/sync-manifest-versions.cjs
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Repo-relative paths of JSON manifests with a top-level `version` that must
 * equal package.json's. The build copies `.claude-plugin/` into dist/ as-is,
 * so the dist copy follows from the source and is not listed separately.
 */
const VERSION_MANIFESTS = ['.claude-plugin/plugin.json'];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function syncManifestVersions() {
  const { version } = readJson('package.json');
  for (const manifest of VERSION_MANIFESTS) {
    const data = readJson(manifest);
    if (data.version === version) continue;
    data.version = version;
    fs.writeFileSync(path.join(ROOT, manifest), `${JSON.stringify(data, null, 2)}\n`);
    console.log(`${manifest}: version -> ${version}`);
  }
}

module.exports = { VERSION_MANIFESTS };

if (require.main === module) {
  syncManifestVersions();
}
