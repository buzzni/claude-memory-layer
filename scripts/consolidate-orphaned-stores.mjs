#!/usr/bin/env node
/**
 * Consolidate project stores that no longer match the hash their path resolves to.
 *
 * Project hashes derive from the main checkout owning a path's .git, so a
 * worktree or subdirectory shares its repository's store. Stores created before
 * that resolution existed sit under a hash nothing will ever look up again —
 * their events are stranded. This folds them back into the store their path
 * resolves to today.
 *
 * Dry run by default; pass --apply to write.
 *
 *   node scripts/consolidate-orphaned-stores.mjs
 *   node scripts/consolidate-orphaned-stores.mjs --hash ad83c813 --apply
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { hashProjectPath } from '../dist/core/index.js';

const PROJECTS_ROOT = process.env.CLAUDE_MEMORY_PROJECTS_ROOT
  || path.join(os.homedir(), '.claude-code', 'memory', 'projects');

/** Tables merged from the source store. FTS is rebuilt by the events triggers. */
const MERGED_TABLES = ['events', 'sessions'];

function parseArgs(argv) {
  const result = { apply: false, hashes: [], keepSource: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') result.apply = true;
    else if (arg === '--keep-source') result.keepSource = true;
    else if (arg === '--hash' && i + 1 < argv.length) {
      result.hashes.push(String(argv[i += 1]).trim().toLowerCase());
    } else if (arg.startsWith('--hash=')) {
      result.hashes.push(arg.slice('--hash='.length).trim().toLowerCase());
    }
  }
  return result;
}

function tableColumns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  } catch {
    return [];
  }
}

/** The project path a store was written for, taken from the sessions it recorded. */
function dominantProjectPath(db) {
  try {
    const row = db.prepare(
      `SELECT project_path AS p FROM sessions
       WHERE project_path IS NOT NULL AND project_path <> ''
       GROUP BY project_path ORDER BY COUNT(*) DESC LIMIT 1`
    ).get();
    return row?.p ?? null;
  } catch {
    return null;
  }
}

function countRows(db, table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  } catch {
    return 0;
  }
}

/** Stores whose recorded path still exists but now hashes somewhere else. */
function findOrphans(filterHashes) {
  const orphans = [];
  for (const dir of fs.readdirSync(PROJECTS_ROOT)) {
    if (dir.includes('.bak-') || dir.includes('.merged-')) continue;
    if (filterHashes.length > 0 && !filterHashes.includes(dir)) continue;

    const dbPath = path.join(PROJECTS_ROOT, dir, 'events.sqlite');
    if (!fs.existsSync(dbPath)) continue;

    const db = new Database(dbPath, { readonly: true });
    const projectPath = dominantProjectPath(db);
    const events = countRows(db, 'events');
    const sessions = countRows(db, 'sessions');
    db.close();

    if (!projectPath) continue;
    if (!fs.existsSync(projectPath)) continue; // path is gone; nothing to resolve onto

    const target = hashProjectPath(projectPath);
    if (target === dir) continue;
    if (!fs.existsSync(path.join(PROJECTS_ROOT, target, 'events.sqlite'))) continue;

    orphans.push({ dir, target, projectPath, events, sessions });
  }
  return orphans.sort((a, b) => b.events - a.events);
}

/**
 * Move a merged-away store aside under a name that is free. Re-merging the same
 * hash within the same second must not collide with the previous archive —
 * renameSync onto an existing non-empty directory fails.
 */
function archiveSourceDir(dir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let name = `${dir}.merged-${stamp}`;
  for (let n = 2; fs.existsSync(path.join(PROJECTS_ROOT, name)); n += 1) {
    name = `${dir}.merged-${stamp}-${n}`;
  }
  fs.renameSync(path.join(PROJECTS_ROOT, dir), path.join(PROJECTS_ROOT, name));
  return name;
}

function mergeStore(orphan, { apply, keepSource }) {
  const sourcePath = path.join(PROJECTS_ROOT, orphan.dir, 'events.sqlite');
  const targetPath = path.join(PROJECTS_ROOT, orphan.target, 'events.sqlite');

  const target = new Database(targetPath, { readonly: !apply });
  const stats = { tables: {}, enqueued: 0 };

  try {
    target.prepare('ATTACH ? AS src').run(sourcePath);

    for (const table of MERGED_TABLES) {
      const targetCols = tableColumns(target, table);
      const sourceCols = new Set(
        target.prepare(`PRAGMA src.table_info(${table})`).all().map((row) => row.name)
      );
      const shared = targetCols.filter((col) => sourceCols.has(col));
      if (shared.length === 0 || !shared.includes('id')) {
        stats.tables[table] = { copied: 0, skipped: 0, note: 'incompatible schema' };
        continue;
      }

      const before = countRows(target, table);
      const list = shared.map((col) => `"${col}"`).join(', ');
      const sql = `INSERT OR IGNORE INTO main.${table} (${list}) SELECT ${list} FROM src.${table}`;

      if (apply) {
        target.prepare(sql).run();
      }
      const sourceRows = target.prepare(`SELECT COUNT(*) AS c FROM src.${table}`).get().c;
      const copied = apply ? countRows(target, table) - before : null;
      stats.tables[table] = {
        sourceRows,
        copied,
        skipped: copied === null ? null : sourceRows - copied
      };
    }

    // Merged events carry no vectors in the target store, so queue them for
    // embedding. The outbox's own uniqueness constraint absorbs re-runs.
    if (apply) {
      const version = target.prepare(
        `SELECT embedding_version AS v FROM vector_outbox
         GROUP BY embedding_version ORDER BY COUNT(*) DESC LIMIT 1`
      ).get()?.v;

      if (version) {
        const queued = target.prepare(
          `INSERT OR IGNORE INTO vector_outbox (job_id, item_kind, item_id, embedding_version, status)
           SELECT lower(hex(randomblob(16))), 'event', e.id, ?, 'pending'
           FROM src.events e WHERE EXISTS (SELECT 1 FROM main.events m WHERE m.id = e.id)`
        ).run(version);
        stats.enqueued = queued.changes;
      } else {
        stats.enqueueNote = 'no embedding_version in target outbox; run `process` to backfill';
      }
    }
  } finally {
    try { target.prepare('DETACH src').run(); } catch { /* already detached */ }
    target.close();
  }

  if (apply && !keepSource) {
    stats.archivedAs = archiveSourceDir(orphan.dir);
  }

  return stats;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(PROJECTS_ROOT)) {
    console.error(`No project stores at ${PROJECTS_ROOT}`);
    process.exit(1);
  }

  const orphans = findOrphans(options.hashes);
  if (orphans.length === 0) {
    console.log('No orphaned stores found.');
    return;
  }

  console.log(options.apply ? '🔧 Consolidating orphaned stores\n' : '🔍 Dry run (pass --apply to write)\n');

  let totalEvents = 0;
  let failed = 0;
  for (const orphan of orphans) {
    console.log(`${orphan.dir} → ${orphan.target}`);
    console.log(`   path: ${orphan.projectPath}`);
    console.log(`   source: ${orphan.events} events, ${orphan.sessions} sessions`);

    // One unmergeable store must not strand the rest of the batch. The merge
    // itself is idempotent, so a failed store is safe to retry.
    let stats;
    try {
      stats = mergeStore(orphan, options);
    } catch (error) {
      failed += 1;
      console.log(`   ❌ failed: ${error.message}\n`);
      continue;
    }

    for (const [table, result] of Object.entries(stats.tables)) {
      if (result.note) console.log(`   ${table}: skipped (${result.note})`);
      else if (result.copied === null) console.log(`   ${table}: ${result.sourceRows} rows to merge`);
      else console.log(`   ${table}: copied ${result.copied}, deduped ${result.skipped}`);
    }
    if (stats.enqueued) console.log(`   queued ${stats.enqueued} events for embedding`);
    if (stats.enqueueNote) console.log(`   ${stats.enqueueNote}`);
    console.log();

    totalEvents += orphan.events;
  }

  console.log(`${orphans.length} store(s), ${totalEvents} source events.`);
  if (failed > 0) {
    console.log(`${failed} store(s) failed; re-running is safe.`);
    process.exitCode = 1;
  }
  if (options.apply) {
    console.log('Merged stores were renamed to <hash>.merged-<timestamp>.');
    console.log('Run `claude-memory-layer process -p <project>` to embed the merged events.');
  } else {
    console.log('Re-run with --apply to merge.');
  }
}

main();
