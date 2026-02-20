#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dbPath = process.env.CML_DB_PATH || path.join(os.homedir(), '.claude-code', 'memory', 'events.sqlite');
if (!fs.existsSync(dbPath)) {
  console.log(JSON.stringify({ status: 'skip', reason: 'db_not_found', dbPath }, null, 2));
  process.exit(0);
}

const db = new Database(dbPath);
const hasTable = (name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

let inserted = { changes: 0 };
if (hasTable('events') && hasTable('memory_levels')) {
  inserted = db.prepare(`
    INSERT OR IGNORE INTO memory_levels (event_id, level, promoted_at)
    SELECT e.id, 'L0', datetime('now')
    FROM events e
    LEFT JOIN memory_levels ml ON e.id = ml.event_id
    WHERE ml.event_id IS NULL
  `).run();
}

let recovered = { changes: 0 };
if (hasTable('vector_outbox')) {
  recovered = db.prepare(`UPDATE vector_outbox SET status='pending', updated_at=datetime('now') WHERE status='processing'`).run();
}

console.log(JSON.stringify({ status: 'ok', dbPath, leveledInserted: Number(inserted.changes||0), recoveredProcessingOutbox: Number(recovered.changes||0) }, null, 2));
