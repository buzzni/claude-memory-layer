#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const result = {
    apply: false,
    hashes: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      result.apply = true;
      continue;
    }
    if (arg === '--hash' && i + 1 < argv.length) {
      result.hashes.push(String(argv[i + 1]).trim().toLowerCase());
      i += 1;
      continue;
    }
    if (arg.startsWith('--hash=')) {
      result.hashes.push(arg.slice('--hash='.length).trim().toLowerCase());
    }
  }

  return result;
}

function loadRegistryHashes(registryPath) {
  if (!fs.existsSync(registryPath)) return new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const sessions = raw && typeof raw === 'object' ? raw.sessions : null;
    if (!sessions || typeof sessions !== 'object') return new Set();

    const hashes = new Set();
    for (const entry of Object.values(sessions)) {
      if (!entry || typeof entry !== 'object') continue;
      const hash = entry.projectHash;
      if (typeof hash === 'string' && /^[a-f0-9]{8}$/.test(hash)) {
        hashes.add(hash);
      }
    }
    return hashes;
  } catch {
    return new Set();
  }
}

function getDirSizeBytes(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;

  let total = 0;
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirSizeBytes(child);
    } else if (entry.isFile()) {
      total += fs.statSync(child).size;
    }
  }
  return total;
}

function formatBytes(bytes) {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  return `${value.toFixed(1)} ${units[unitIdx]}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const memoryRoot = process.env.CML_MEMORY_ROOT || path.join(os.homedir(), '.claude-code', 'memory');
  const projectsDir = path.join(memoryRoot, 'projects');
  const registryPath = path.join(memoryRoot, 'session-registry.json');

  if (!fs.existsSync(projectsDir)) {
    console.log(JSON.stringify({
      status: 'skip',
      reason: 'projects_dir_not_found',
      projectsDir
    }, null, 2));
    process.exit(0);
  }

  const knownHashes = loadRegistryHashes(registryPath);
  const filterHashes = new Set(
    args.hashes.filter((h) => /^[a-f0-9]{8}$/.test(h))
  );

  const candidates = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^[a-f0-9]{8}$/.test(name))
    .filter((hash) => !knownHashes.has(hash))
    .filter((hash) => filterHashes.size === 0 || filterHashes.has(hash));

  const projectInfo = candidates.map((hash) => {
    const fullPath = path.join(projectsDir, hash);
    const sizeBytes = getDirSizeBytes(fullPath);
    return {
      hash,
      path: fullPath,
      sizeBytes,
      sizeHuman: formatBytes(sizeBytes)
    };
  });

  const totalBytes = projectInfo.reduce((sum, item) => sum + item.sizeBytes, 0);

  if (!args.apply) {
    console.log(JSON.stringify({
      status: 'dry-run',
      message: 'Run with --apply to delete the directories below.',
      memoryRoot,
      projectsDir,
      registryPath,
      unknownCount: projectInfo.length,
      totalSizeBytes: totalBytes,
      totalSizeHuman: formatBytes(totalBytes),
      projects: projectInfo
    }, null, 2));
    process.exit(0);
  }

  let deleted = 0;
  for (const item of projectInfo) {
    fs.rmSync(item.path, { recursive: true, force: true });
    deleted += 1;
  }

  console.log(JSON.stringify({
    status: 'ok',
    mode: 'apply',
    deletedCount: deleted,
    deletedSizeBytes: totalBytes,
    deletedSizeHuman: formatBytes(totalBytes),
    deletedHashes: projectInfo.map((item) => item.hash)
  }, null, 2));
}

main();
