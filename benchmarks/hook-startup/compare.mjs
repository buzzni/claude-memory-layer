// Phase tables and before/after differences from cold-start.mjs runs.
// node compare.mjs --side base=<work dir> --side final=<work dir> [--csv out.csv]
// Every rows-*.json in a work dir is one side's sample (warm-up runs left out).
// The first side is the reference for the difference table.
import * as fs from 'node:fs';
import * as path from 'node:path';

const argv = process.argv.slice(2);
const sides = [];
let csvPath = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--side') {
    const [name, dir] = argv[++i].split('=');
    sides.push({ name, dir: path.resolve(dir) });
  } else if (argv[i] === '--csv') {
    csvPath = path.resolve(argv[++i]);
  }
}
if (sides.length === 0) {
  console.error('usage: node compare.mjs --side <name>=<work dir> [--side ...] [--csv out.csv]');
  process.exit(1);
}

const PHASES = ['wall', 'boot', 'load', 'db', 'git', 'work', 'exit'];

/** Milliseconds per phase; see README.md for what each covers. */
function phases(row) {
  const t = row.trace;
  const db = t.sqliteOpenMs + t.sqliteExecMs;
  return {
    wall: row.wallMs,
    boot: t.preloadStart,
    load: (t.stdinAt ?? t.exitAt) - t.preloadEnd,
    db,
    git: t.cpSyncMs,
    work: t.stdinAt === null ? 0 : t.exitAt - t.stdinAt - db - t.cpSyncMs,
    exit: row.wallMs - t.exitAt
  };
}

function load(side) {
  return fs.readdirSync(side.dir)
    .filter((file) => /^rows-.*\.json$/.test(file))
    .flatMap((file) => JSON.parse(fs.readFileSync(path.join(side.dir, file), 'utf8'))
      .filter((row) => row.warm && row.trace)
      .map((row) => ({ side: side.name, round: file.replace(/^rows-|\.json$/g, ''), iter: row.iter, hook: row.name, code: row.code, ...phases(row) })));
}

function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const rows = sides.flatMap(load);
const hooks = [...new Set(rows.map((row) => row.hook))];
const pick = (side, hook) => rows.filter((row) => row.side === side && row.hook === hook);
const cell = (values) => `${quantile(values, 0.5).toFixed(0)} / ${quantile(values, 0.9).toFixed(0)}`;

for (const side of sides) {
  console.log(`\n### ${side.name} (ms, p50 / p90)\n`);
  console.log(`| hook | n | ${PHASES.join(' | ')} |`);
  console.log(`|---|---|${PHASES.map(() => '---').join('|')}|`);
  for (const hook of hooks) {
    const sample = pick(side.name, hook);
    if (sample.length === 0) continue;
    console.log(`| ${hook} | ${sample.length} | ${PHASES.map((phase) => cell(sample.map((row) => row[phase]))).join(' | ')} |`);
  }
}

const [reference, ...others] = sides;
for (const other of others) {
  console.log(`\n### ${reference.name} -> ${other.name}: wall and load p50 difference (ms)\n`);
  console.log('| hook | n | wall p50 | Δ wall p50 | load p50 | Δ load p50 |');
  console.log('|---|---|---|---|---|---|');
  for (const hook of hooks) {
    const before = pick(reference.name, hook);
    const after = pick(other.name, hook);
    if (before.length === 0 || after.length === 0) continue;
    const p50 = (sample, phase) => quantile(sample.map((row) => row[phase]), 0.5);
    console.log(`| ${hook} | ${before.length}/${after.length} | ${p50(before, 'wall').toFixed(0)} -> ${p50(after, 'wall').toFixed(0)} | ${(p50(after, 'wall') - p50(before, 'wall')).toFixed(0)} | ${p50(before, 'load').toFixed(0)} -> ${p50(after, 'load').toFixed(0)} | ${(p50(after, 'load') - p50(before, 'load')).toFixed(0)} |`);
  }
}

if (csvPath) {
  const header = ['side', 'round', 'iter', 'hook', 'code', ...PHASES];
  const lines = rows.map((row) => header.map((key) => (typeof row[key] === 'number' && !Number.isInteger(row[key]) ? row[key].toFixed(2) : row[key])).join(','));
  fs.writeFileSync(csvPath, `${header.join(',')}\n${lines.join('\n')}\n`);
  console.log(`\nwrote ${rows.length} rows to ${csvPath}`);
}
