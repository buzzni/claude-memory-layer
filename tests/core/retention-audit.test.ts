import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runRetentionAudit } from '../../src/core/operations/retention-audit.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

describe('runRetentionAudit', () => {
  it('treats optional operations and telemetry tables as empty in legacy stores', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cml-retention-audit-core-'));
    const dbPath = path.join(dir, 'events.sqlite');
    const db = new Database(dbPath);

    try {
      db.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata TEXT,
          access_count INTEGER DEFAULT 0,
          last_accessed_at TEXT
        )
      `);
      db.prepare(`INSERT INTO events (id, event_type, timestamp, content, metadata, access_count, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'event-legacy-1',
        'user_prompt',
        '2024-01-01T00:00:00.000Z',
        'legacy scoped event',
        JSON.stringify({ scope: { project: { hash: 'abc12345' } } }),
        0,
        null
      );

      const report = runRetentionAudit(db, {
        projectHash: 'abc12345',
        limit: 10,
        now: new Date('2024-01-10T00:00:00.000Z')
      });

      expect(report.scanned).toBe(1);
      expect(report.samples[0].targetId).toBe('event-legacy-1');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts POSIX paths with spaces and Windows paths when only a project hash is provided', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cml-retention-audit-redaction-'));
    const dbPath = path.join(dir, 'events.sqlite');
    const db = new Database(dbPath);

    try {
      db.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata TEXT,
          access_count INTEGER DEFAULT 0,
          last_accessed_at TEXT
        )
      `);
      db.prepare(`INSERT INTO events (id, event_type, timestamp, content, metadata, access_count, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'event-redaction-1',
        'tool_observation',
        '2024-01-01T00:00:00.000Z',
        String.raw`hash-only paths [/Users/alice/Library/Application Support/key.txt], [C:\Users\alice\secret.txt], [\\fileserver\share\team secret.txt]`,
        JSON.stringify({ scope: { project: { hash: 'abc12345' } } }),
        0,
        null
      );

      const report = runRetentionAudit(db, {
        projectHash: 'abc12345',
        limit: 10,
        now: new Date('2024-01-10T00:00:00.000Z')
      });

      expect(report.scanned).toBe(1);
      expect(report.samples[0].redactedPreview).toContain('[REDACTED]');
      expect(report.samples[0].redactedPreview).not.toContain('/Users/alice');
      expect(report.samples[0].redactedPreview).not.toContain('Application Support');
      expect(report.samples[0].redactedPreview).not.toContain('C:\\Users');
      expect(report.samples[0].redactedPreview).not.toContain('\\\\fileserver');
      expect(report.samples[0].redactedPreview).not.toContain('secret.txt');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires explicit matching project scope and applies the scan limit after project filtering', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cml-retention-audit-scope-'));
    const dbPath = path.join(dir, 'events.sqlite');
    const store = new SQLiteEventStore(dbPath, { markdownMirrorRoot: dir });

    try {
      await store.initialize();
      await store.append({
        eventType: 'tool_observation',
        sessionId: 'scope-test',
        timestamp: new Date('2024-01-03T00:00:00.000Z'),
        content: 'foreign project event',
        metadata: { scope: { project: { hash: 'ffffeeee' } } }
      });
      await store.append({
        eventType: 'tool_observation',
        sessionId: 'scope-test',
        timestamp: new Date('2024-01-02T00:00:00.000Z'),
        content: 'unscoped event should not be audited for a project',
        metadata: {}
      });
      const projectEvent = await store.append({
        eventType: 'tool_observation',
        sessionId: 'scope-test',
        timestamp: new Date('2024-01-01T00:00:00.000Z'),
        content: 'matching project event',
        metadata: { scope: { project: { hash: 'abc12345' } } }
      });
      if (projectEvent.success !== true) throw new Error('append failed');

      const report = runRetentionAudit(store.getDatabase(), {
        projectHash: 'abc12345',
        limit: 1,
        now: new Date('2024-01-10T00:00:00.000Z')
      });

      expect(report.scanned).toBe(1);
      expect(report.samples).toHaveLength(1);
      expect(report.samples[0].targetId).toBe(projectEvent.eventId);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
