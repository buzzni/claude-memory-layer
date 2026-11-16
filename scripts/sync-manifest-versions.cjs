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
 * JSON manifests whose version fields must equal package.json's: the
 * repo-relative path, and the objects inside the parsed manifest that carry a
 * `version`. The build copies `.claude-plugin/` into dist/ as-is, so the dist
 * copy follows from the source and is not listed separately.
 */
const VERSION_MANIFESTS = [
  { path: '.claude-plugin/plugin.json', versionHolders: (data) => [data] },
  // plugin.json wins at install time; the entry is kept equal so `claude plugin
  // validate` does not warn and the catalog shows the version users get.
  { path: '.claude-plugin/marketplace.json', versionHolders: (data) => data.plugins || [] }
];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function syncManifestVersions() {
  const { version } = readJson('package.json');
  for (const manifest of VERSION_MANIFESTS) {
    const data = readJson(manifest.path);
    const stale = manifest.versionHolders(data).filter((holder) => holder.version !== version);
    if (stale.length === 0) continue;
    for (const holder of stale) holder.version = version;
    fs.writeFileSync(path.join(ROOT, manifest.path), `${JSON.stringify(data, null, 2)}\n`);
    console.log(`${manifest.path}: version -> ${version}`);
  }
}

module.exports = { VERSION_MANIFESTS };

if (require.main === module) {
  syncManifestVersions();
}
