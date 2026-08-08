#!/usr/bin/env node
/**
 * Report content_overlap_score for each injection lane, split into time windows.
 *
 * This is the only metric that decides whether a memory change worked. Creation
 * rate, save rate, and "richer" memories have all looked good while grounding
 * stayed flat or fell — most recently when session-start injection was switched
 * to summaries and overlap dropped from 0.081 to 0.008 while every proxy
 * metric improved.
 *
 *   node scripts/measure-injection-grounding.mjs
 *   node scripts/measure-injection-grounding.mjs --since 2026-08-08 --baseline 0.081
 *   node scripts/measure-injection-grounding.mjs --window 2026-08-06..2026-08-07 --window 2026-08-08..
 *
 * Rows whose score has not been computed yet are excluded rather than counted
 * as zero: helpfulness is measured a while after the injection, so counting
 * them would drag a recent window toward zero purely for being recent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const PROJECTS_ROOT = process.env.CLAUDE_MEMORY_PROJECTS_ROOT
  || path.join(os.homedir(), '.claude-code', 'memory', 'projects');

/** Pre-regression session_start level; the bar a fix has to clear again. */
const DEFAULT_BASELINE = 0.081;

/** Below this many scored rows a window is reported but not judged. */
const MIN_SAMPLE = 30;

function parseArgs(argv) {
  const result = { windows: [], baseline: DEFAULT_BASELINE, since: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--window' && i + 1 < argv.length) result.windows.push(argv[i += 1]);
    else if (arg.startsWith('--window=')) result.windows.push(arg.slice('--window='.length));
    else if (arg === '--baseline' && i + 1 < argv.length) result.baseline = Number(argv[i += 1]);
    else if (arg.startsWith('--baseline=')) result.baseline = Number(arg.slice('--baseline='.length));
    else if (arg === '--since' && i + 1 < argv.length) result.since = argv[i += 1];
    else if (arg.startsWith('--since=')) result.since = arg.slice('--since='.length);
  }
  return result;
}

/**
 * "from..to", either side optional. Dates are compared as ISO text, as stored.
 *
 * The separator is `..` rather than `:` because a full timestamp already
 * contains colons — splitting `2026-08-08T06:20:29Z..` on `:` silently yields
 * the bounds "2026-08-08T06" and "20", which quietly reports the wrong window
 * instead of failing.
 */
function parseWindow(spec) {
  const index = spec.indexOf('..');
  if (index < 0) {
    throw new Error(`window "${spec}" must be written from..to (either side may be empty)`);
  }
  const from = spec.slice(0, index);
  const to = spec.slice(index + 2);
  return { label: spec, from: from || null, to: to || null };
}

function storeFiles() {
  if (!fs.existsSync(PROJECTS_ROOT)) return [];
  return fs.readdirSync(PROJECTS_ROOT)
    .filter((dir) => !dir.includes('.bak') && !dir.includes('.merged-'))
    .map((dir) => ({ dir, file: path.join(PROJECTS_ROOT, dir, 'events.sqlite') }))
    .filter((entry) => fs.existsSync(entry.file));
}

function collect(windows) {
  // source -> window label -> totals
  const totals = new Map();

  for (const { file } of storeFiles()) {
    let db;
    try {
      db = new Database(file, { readonly: true });
    } catch {
      continue; // a store mid-write or from a newer schema must not abort the report
    }

    for (const window of windows) {
      const clauses = ['content_overlap_score IS NOT NULL'];
      const params = [];
      if (window.from) { clauses.push('created_at >= ?'); params.push(window.from); }
      if (window.to) { clauses.push('created_at < ?'); params.push(window.to); }

      let rows = [];
      try {
        rows = db.prepare(
          `SELECT source, COUNT(*) AS scored, SUM(content_overlap_score) AS total,
                  SUM(CASE WHEN content_overlap_score > 0 THEN 1 ELSE 0 END) AS grounded
           FROM memory_helpfulness WHERE ${clauses.join(' AND ')} GROUP BY source`
        ).all(...params);
      } catch {
        continue; // store predates the column
      }

      for (const row of rows) {
        const source = row.source || '(unknown)';
        if (!totals.has(source)) totals.set(source, new Map());
        const perWindow = totals.get(source);
        const acc = perWindow.get(window.label) || { scored: 0, total: 0, grounded: 0 };
        acc.scored += row.scored;
        acc.total += row.total || 0;
        acc.grounded += row.grounded || 0;
        perWindow.set(window.label, acc);
      }
    }

    db.close();
  }

  return totals;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  let windows;
  if (options.windows.length > 0) {
    try {
      windows = options.windows.map(parseWindow);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  } else if (options.since) {
    windows = [
      { label: `before ${options.since}`, from: null, to: options.since },
      { label: `since ${options.since}`, from: options.since, to: null }
    ];
  } else {
    windows = [{ label: 'all time', from: null, to: null }];
  }

  const totals = collect(windows);
  if (totals.size === 0) {
    console.log(`No scored injections found under ${PROJECTS_ROOT}`);
    return;
  }

  console.log(`content_overlap_score — ${storeFiles().length} stores, unscored rows excluded\n`);

  for (const [source, perWindow] of [...totals].sort()) {
    console.log(source);
    for (const window of windows) {
      const acc = perWindow.get(window.label);
      if (!acc || acc.scored === 0) {
        console.log(`  ${window.label.padEnd(24)} no scored rows`);
        continue;
      }
      const avg = acc.total / acc.scored;
      const grounded = (100 * acc.grounded) / acc.scored;
      const note = acc.scored < MIN_SAMPLE ? `  (n=${acc.scored}, too few to judge)` : '';
      console.log(
        `  ${window.label.padEnd(24)} avg ${avg.toFixed(4)}`
        + `  grounded ${grounded.toFixed(1)}%  n=${acc.scored}${note}`
      );
    }
    console.log();
  }

  const sessionStart = totals.get('session_start');
  const latest = sessionStart?.get(windows[windows.length - 1].label);
  if (latest && latest.scored > 0) {
    const avg = latest.total / latest.scored;
    if (latest.scored < MIN_SAMPLE) {
      console.log(`session_start is at ${avg.toFixed(4)} on only ${latest.scored} scored rows — wait for more before judging.`);
    } else if (avg >= options.baseline) {
      console.log(`session_start ${avg.toFixed(4)} >= baseline ${options.baseline} — recovered.`);
    } else {
      console.log(`session_start ${avg.toFixed(4)} < baseline ${options.baseline} — NOT recovered.`);
      process.exitCode = 1;
    }
  }
}

main();
