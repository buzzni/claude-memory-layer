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

const db = new Database(dbPath, { readonly: true });
const total = db.prepare('SELECT COUNT(*) as c FROM events').get();
const noLevel = db.prepare(`SELECT COUNT(*) as c FROM events e LEFT JOIN memory_levels ml ON e.id=ml.event_id WHERE ml.event_id IS NULL`).get();
const outboxPending = db.prepare(`SELECT COUNT(*) as c FROM vector_outbox WHERE status='pending'`).get();
const outboxFailed = db.prepare(`SELECT COUNT(*) as c FROM vector_outbox WHERE status='failed'`).get();

console.log(JSON.stringify({
  status: 'ok',
  dbPath,
  totalEvents: total.c,
  inEventsNotLeveledCount: noLevel.c,
  outboxPendingCount: outboxPending.c,
  outboxFailedCount: outboxFailed.c,
}, null, 2));
