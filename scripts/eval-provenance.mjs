/**
 * Provenance for evaluation results: which code, data and settings a result came from.
 *
 * Every evaluation script adds this block next to its existing output, so a
 * number can be traced back to a commit, fixture bytes and store state. The
 * block never holds an absolute or home path: repository files appear as
 * repository-relative paths and anything else as a hash of its location.
 *
 * Plain .mjs so both the tsx scripts and `node scripts/measure-injection-grounding.mjs` can import it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const SPLITS_PATH = path.join(REPO_ROOT, 'benchmarks', 'lesson-recall', 'splits.json');
/** Env vars that can change a result: memory feature flags, thresholds and rerank weights. */
const RESULT_ENV = /^(CLAUDE_MEMORY_|MEMORY_)/;
const CREDENTIAL_ENV = /(PASSWORD|SECRET|TOKEN|KEY|URI|URL)$/;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** 16-hex digest for identifiers that should be comparable across runs but not readable. */
export const shortHash = (value) => sha256(value).slice(0, 16);

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null; // not a checkout (e.g. an unpacked tarball)
  }
}

/** Repository-relative path for files in the repository, a location hash for anything else. */
export function pathRef(value) {
  const expanded = value === '~' || value.startsWith('~/') ? path.join(homedir(), value.slice(1)) : value;
  const absolute = path.resolve(expanded);
  const relative = path.relative(REPO_ROOT, absolute);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  return `outside-repo:${shortHash(absolute)}`;
}

function sanitizeString(value) {
  if (path.isAbsolute(value) || value === '~' || value.startsWith('~/')) return pathRef(value);
  if (value.includes(homedir()) || value.includes(REPO_ROOT)) return `redacted:${shortHash(value)}`;
  return value;
}

/** Copy of flag/setting values with every path made safe to publish; undefined entries are dropped. */
export function sanitizeSettings(value) {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeSettings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, sanitizeSettings(entry)]));
  }
  return value;
}

/** Result-affecting env vars that are set; credentials are kept as a presence marker only. */
export function pickEnv(env = process.env) {
  return Object.fromEntries(Object.keys(env)
    .filter((name) => RESULT_ENV.test(name) && env[name] !== undefined)
    .sort()
    .map((name) => [name, CREDENTIAL_ENV.test(name) ? '[redacted]' : sanitizeString(env[name])]));
}

/** sha256 of the fixture bytes, checked against benchmarks/lesson-recall/splits.json. */
export function describeFixture(fixturePath) {
  const digest = sha256(readFileSync(fixturePath));
  const manifest = JSON.parse(readFileSync(SPLITS_PATH, 'utf8'));
  const registered = manifest.fixtures.find((fixture) => fixture.sha256 === digest);
  const sameName = manifest.fixtures.some((fixture) => fixture.file === path.basename(fixturePath));
  return {
    ref: pathRef(fixturePath),
    sha256: digest,
    split: registered?.split ?? null,
    manifest: registered ? 'match' : sameName ? 'mismatch' : 'unregistered'
  };
}

/** Row count per table; a table the store does not have counts as null. */
export function countRows(db, tables) {
  return Object.fromEntries(tables.map((table) => {
    try {
      return [table, db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n];
    } catch {
      return [table, null];
    }
  }));
}

/** Whether the store's row counts moved between the start and the end of a run. */
export function corpusChanged(start, end) {
  const tables = new Set([...Object.keys(start), ...Object.keys(end)]);
  return [...tables].some((table) => start[table] !== end[table]);
}

/** Top-k at or above the candidate pool returns every candidate, so ranking quality cannot show. */
export function topKSaturation(topK, candidatePool) {
  return topK >= candidatePool;
}

/**
 * @param {{
 *   generatedAt?: string,
 *   fixtures?: string[],
 *   store?: { ref?: string, rowsAtStart: Record<string, number | null>, rowsAtEnd: Record<string, number | null>, inputRows?: number | Record<string, number>, window?: unknown },
 *   retrieval?: { topK: number, candidatePool: number },
 *   flags?: Record<string, unknown>,
 *   env?: Record<string, string | undefined>
 * }} input
 */
export function buildProvenance(input = {}) {
  const sha = git(['rev-parse', 'HEAD'])?.trim() || null;
  const status = sha ? git(['status', '--porcelain']) : null;
  const fixtures = (input.fixtures ?? []).map(describeFixture);
  const warnings = fixtures
    .filter((fixture) => fixture.manifest === 'mismatch')
    .map((fixture) => `${fixture.ref} differs from the bytes registered in splits.json`);
  const provenance = {
    gitSha: sha,
    gitDirty: status === null ? null : status.trim().length > 0,
    packageVersion: JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    fixtures
  };
  if (input.store) {
    const changed = corpusChanged(input.store.rowsAtStart, input.store.rowsAtEnd);
    const { ref, ...store } = input.store;
    // ref may be relative to the caller's cwd, so it always goes through pathRef.
    provenance.store = { ...(ref ? { ref: pathRef(ref) } : {}), ...sanitizeSettings(store), corpusChanged: changed };
    if (changed) {
      warnings.push(`store corpus changed during the run (rows ${JSON.stringify(input.store.rowsAtStart)} -> ${JSON.stringify(input.store.rowsAtEnd)}); the result may mix two store states`);
    }
  }
  if (input.retrieval) {
    const { topK, candidatePool } = input.retrieval;
    const saturated = topKSaturation(topK, candidatePool);
    provenance.retrieval = { topK, candidatePool, saturated };
    if (saturated) {
      warnings.push(`top-k ${topK} >= candidate pool ${candidatePool}: saturated, every candidate is returned so ranking metrics do not measure ranking`);
    }
  }
  provenance.flags = sanitizeSettings(input.flags ?? {});
  provenance.env = pickEnv(input.env);
  provenance.warnings = warnings;
  return provenance;
}

export function warnProvenance(provenance, stream = process.stderr) {
  for (const warning of provenance.warnings) stream.write(`warning: ${warning}\n`);
}

/** Markdown bullet lines summarizing the provenance block. */
export function formatProvenanceLines(provenance) {
  const commit = provenance.gitSha ? `git ${provenance.gitSha.slice(0, 12)}${provenance.gitDirty ? ' (dirty)' : ''}` : 'git unknown';
  const lines = [`- Provenance: ${commit} · claude-memory-layer ${provenance.packageVersion} · generated ${provenance.generatedAt}`];
  for (const fixture of provenance.fixtures) {
    const split = fixture.split ? `split ${fixture.split}` : `splits.json ${fixture.manifest}`;
    lines.push(`- Fixture file: \`${fixture.ref}\` sha256 ${fixture.sha256.slice(0, 12)} (${split})`);
  }
  if (provenance.store) {
    const { rowsAtStart, rowsAtEnd, inputRows, window } = provenance.store;
    const input = inputRows === undefined ? '' : `, input rows ${typeof inputRows === 'object' ? JSON.stringify(inputRows) : inputRows}`;
    const span = window ? `, window ${JSON.stringify(window)}` : '';
    const changed = provenance.store.corpusChanged ? ' — corpus changed during the run' : '';
    lines.push(`- Store rows: start ${JSON.stringify(rowsAtStart)}, end ${JSON.stringify(rowsAtEnd)}${input}${span}${changed}`);
  }
  if (provenance.retrieval) {
    const { topK, candidatePool, saturated } = provenance.retrieval;
    lines.push(`- Top-k ${topK} / candidate pool ${candidatePool}${saturated ? ' — saturated' : ''}`);
  }
  lines.push(`- Settings: flags ${JSON.stringify(provenance.flags)}, env ${JSON.stringify(provenance.env)}`);
  return lines;
}

/** Insert the provenance lines under a markdown report's title; the rest is unchanged. */
export function withProvenanceHeader(markdown, provenance) {
  const lines = formatProvenanceLines(provenance).join('\n');
  const newline = markdown.indexOf('\n');
  if (!markdown.startsWith('#') || newline < 0) return `${lines}\n\n${markdown}`;
  const rest = markdown.slice(newline + 1);
  return `${markdown.slice(0, newline)}\n\n${lines}\n${rest.startsWith('\n') ? '' : '\n'}${rest}`;
}
