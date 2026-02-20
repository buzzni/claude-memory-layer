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
const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='candidate_memories'").get();
if (!table) {
  console.log(JSON.stringify({ status: 'skip', reason: 'candidate_memories_table_missing', dbPath }, null, 2));
  process.exit(0);
}

const res = db.prepare(`UPDATE candidate_memories SET status='resolved', updated_at=datetime('now') WHERE status='pending' AND confidence >= 0.9`).run();
console.log(JSON.stringify({ status: 'ok', resolved: Number(res.changes || 0) }, null, 2));
