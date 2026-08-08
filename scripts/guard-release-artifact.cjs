#!/usr/bin/env node
/**
 * Release artifact guards, shared by scripts/release-npm.sh and the
 * publish-npm workflow so a local release and a tag-triggered release enforce
 * the same rules. Previously these lived only as heredocs inside the shell
 * script, which meant CI had no way to run them.
 *
 * Usage:
 *   node scripts/guard-release-artifact.cjs self-dependency
 *   node scripts/guard-release-artifact.cjs provenance
 *   node scripts/guard-release-artifact.cjs tarball <npm-pack-dry-run-json>
 *
 * Exits non-zero and prints what failed; prints a JSON summary on success.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

/**
 * Self-dependency has been reintroduced repeatedly by `npm install` restoring
 * it from package-lock.json, so it is checked on both files rather than
 * package.json alone — a lock entry survives a hand-edit of package.json and
 * puts the cycle straight back on the next install.
 */
function guardSelfDependency() {
  const pkg = readPackageJson();
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  const offenders = fields.filter((field) => (
    pkg[field] && Object.prototype.hasOwnProperty.call(pkg[field], pkg.name)
  ));
  if (offenders.length) {
    fail(`self dependency on ${pkg.name} in package.json: ${offenders.join(', ')}`);
  }

  const lockPath = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const rootEntry = lock.packages && lock.packages[''];
    const lockOffenders = rootEntry
      ? fields.filter((field) => (
        rootEntry[field] && Object.prototype.hasOwnProperty.call(rootEntry[field], pkg.name)
      ))
      : [];
    if (lockOffenders.length) {
      fail(`self dependency on ${pkg.name} in package-lock.json: ${lockOffenders.join(', ')}`);
    }
    if (lock.packages && lock.packages[`node_modules/${pkg.name}`]) {
      fail(`package-lock.json contains a nested node_modules/${pkg.name} entry (self dependency)`);
    }
  }

  console.log(JSON.stringify({ check: 'self-dependency', name: pkg.name, version: pkg.version, ok: true }));
}

/**
 * npm rejects a provenance-signed publish whose package.json `repository.url`
 * does not match the repository the signature was minted from. The registry
 * only reports that after the tarball has been uploaded and the provenance
 * statement written to the public transparency log, so the failure costs a
 * full release run — v2.2.3's first attempt died exactly here with an empty
 * `repository.url`. Checking it before publish makes that a five-second
 * failure instead.
 */
function guardProvenance() {
  const pkg = readPackageJson();
  const url = pkg.repository && (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url);
  if (!url) fail('package.json has no repository.url; npm provenance requires it');

  // GITHUB_REPOSITORY is "owner/name"; only set inside Actions.
  const ghRepo = process.env.GITHUB_REPOSITORY;
  if (ghRepo) {
    const expected = `https://github.com/${ghRepo}`;
    const normalized = url.replace(/^git\+/, '').replace(/\.git$/, '');
    if (normalized !== expected) {
      fail(`repository.url is "${normalized}", expected "${expected}" — provenance would be rejected`);
    }
  }

  console.log(JSON.stringify({ check: 'provenance', repository: url, matchedAgainst: ghRepo || null, ok: true }));
}

/**
 * Files that must never reach the registry: sources and tests (the package
 * ships `dist/` only), and any local state that a developer machine
 * accumulates — stores, caches, evaluation qrels, stray tarballs.
 */
const FORBIDDEN_IN_TARBALL = /(^|\/)\.claude-memory(\/|$)|(^|\/)graphify-out(\/|$)|cache|qrels|\.db$|\.sqlite|\.tgz$|^tests\/|^src\/|^specs\//;

function guardTarball(packJsonPath) {
  if (!packJsonPath) fail('usage: guard-release-artifact.cjs tarball <npm-pack-dry-run-json>');
  const parsed = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'));
  const data = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!data || !Array.isArray(data.files)) fail(`unrecognised npm pack JSON in ${packJsonPath}`);

  const suspicious = data.files
    .map((file) => file.path)
    .filter((filePath) => FORBIDDEN_IN_TARBALL.test(filePath));

  console.log(JSON.stringify({
    check: 'tarball',
    name: data.name,
    version: data.version,
    filename: data.filename,
    fileCount: data.files.length,
    packageSize: data.size,
    unpackedSize: data.unpackedSize,
    suspicious
  }, null, 2));

  if (suspicious.length) fail(`${suspicious.length} forbidden file(s) would be published`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'self-dependency':
    guardSelfDependency();
    break;
  case 'provenance':
    guardProvenance();
    break;
  case 'tarball':
    guardTarball(rest[0]);
    break;
  default:
    fail('usage: guard-release-artifact.cjs <self-dependency|tarball> [args]');
}
