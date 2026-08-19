import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import {
  sanitizeGovernanceAuditValue,
  writeGovernanceAuditEntry
} from '../../src/core/operations/governance-audit.js';
import { sqliteGet } from '../../src/core/sqlite-wrapper.js';

const tempDirs: string[] = [];

async function createStore(): Promise<{ store: SQLiteEventStore; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-governance-audit-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  return {
    store,
    cleanup: async () => {
      await store.close();
    }
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('writeGovernanceAuditEntry', () => {
  it('writes an auditable governance operation with normalized scope and JSON payloads', async () => {
    const { store, cleanup } = await createStore();
    const db = store.getDatabase();

    const entry = await writeGovernanceAuditEntry(db, {
      operation: 'facet_tag',
      actor: ' hermes ',
      projectHash: ' project-1 ',
      targetType: 'event',
      targetId: ' event-1 ',
      beforeJson: { previous: null },
      afterJson: { dimension: 'kind', value: 'debugging' },
      sourceEventIds: [' event-source-1 ', 'event-source-2']
    });

    const row = sqliteGet<Record<string, unknown>>(
      db,
      `SELECT * FROM memory_governance_audit WHERE audit_id = ?`,
      [entry.auditId]
    );
    await cleanup();

    expect(entry.actor).toBe('hermes');
    expect(entry.projectHash).toBe('project-1');
    expect(entry.targetId).toBe('event-1');
    expect(entry.sourceEventIds).toEqual(['event-source-1', 'event-source-2']);
    expect(row?.actor).toBe('hermes');
    expect(row?.project_hash).toBe('project-1');
    expect(JSON.parse(String(row?.before_json))).toEqual({ previous: null });
    expect(JSON.parse(String(row?.after_json))).toEqual({ dimension: 'kind', value: 'debugging' });
    expect(JSON.parse(String(row?.source_event_ids))).toEqual(['event-source-1', 'event-source-2']);
  });

  it('defaults source event ids and optional JSON fields safely', async () => {
    const { store, cleanup } = await createStore();
    const db = store.getDatabase();

    const entry = await writeGovernanceAuditEntry(db, {
      operation: 'verify',
      actor: 'system',
      targetType: 'lesson',
      targetId: 'lesson-1'
    });

    const row = sqliteGet<Record<string, unknown>>(
      db,
      `SELECT * FROM memory_governance_audit WHERE audit_id = ?`,
      [entry.auditId]
    );
    await cleanup();

    expect(entry.sourceEventIds).toEqual([]);
    expect(entry.projectHash).toBeUndefined();
    expect(row?.project_hash).toBeNull();
    expect(row?.before_json).toBeNull();
    expect(row?.after_json).toBeNull();
    expect(JSON.parse(String(row?.source_event_ids))).toEqual([]);
  });

  it('redacts credential-shaped and local-path-shaped audit payload strings', async () => {
    const { store, cleanup } = await createStore();
    const db = store.getDatabase();
    const localPath = ['/Users', 'fixture-user', 'workspace', 'private-note.md'].join('/');
    const nonUserLocalPath = ['/opt', 'cml-governance-private', 'note with spaces.md'].join('/');
    const windowsDrivePath = String.raw`C:\Users\fixture-user\secret.txt`;
    const windowsUncPath = String.raw`\\fileserver\private-share\secret.txt`;
    const tokenParam = ['token', 'fixture'].join('=');

    const entry = await writeGovernanceAuditEntry(db, {
      operation: 'facet_tag',
      actor: `${localPath}?${tokenParam}`,
      targetType: 'event',
      targetId: `${localPath}?${tokenParam}`,
      beforeJson: {
        apiKey: 'fixture',
        nested: { note: `read ${localPath}, ${nonUserLocalPath}, ${windowsDrivePath}, ${windowsUncPath}?${tokenParam}` }
      },
      afterJson: { clientSecret: 'fixture', url: `https://example.invalid/callback?${tokenParam}` },
      sourceEventIds: [`${localPath}#event`, nonUserLocalPath, windowsDrivePath, windowsUncPath, tokenParam]
    });

    const row = sqliteGet<Record<string, unknown>>(
      db,
      `SELECT * FROM memory_governance_audit WHERE audit_id = ?`,
      [entry.auditId]
    );
    await cleanup();

    const beforeJson = JSON.parse(String(row?.before_json));
    const afterJson = JSON.parse(String(row?.after_json));
    const sourceEventIds = JSON.parse(String(row?.source_event_ids));

    const unredactedUserPathPrefix = ['/Users', 'fixture-user'].join('/');

    expect(String(row?.actor)).not.toContain(unredactedUserPathPrefix);
    expect(String(row?.actor)).not.toContain(tokenParam);
    expect(String(row?.target_id)).not.toContain(unredactedUserPathPrefix);
    expect(String(row?.target_id)).not.toContain(tokenParam);
    expect(beforeJson.apiKey).toBe('[REDACTED]');
    expect(beforeJson.nested.note).not.toContain(unredactedUserPathPrefix);
    expect(beforeJson.nested.note).not.toContain(nonUserLocalPath);
    expect(beforeJson.nested.note).not.toContain(windowsDrivePath);
    expect(beforeJson.nested.note).not.toContain(windowsUncPath);
    expect(beforeJson.nested.note).not.toContain(tokenParam);
    expect(afterJson.clientSecret).toBe('[REDACTED]');
    expect(afterJson.url).not.toContain(tokenParam);
    expect(sourceEventIds.join(' ')).not.toContain(unredactedUserPathPrefix);
    expect(sourceEventIds.join(' ')).not.toContain(nonUserLocalPath);
    expect(sourceEventIds.join(' ')).not.toContain(windowsDrivePath);
    expect(sourceEventIds.join(' ')).not.toContain(windowsUncPath);
    expect(sourceEventIds.join(' ')).not.toContain(tokenParam);
  });
});

describe('path redaction blast radius', () => {
  it('still fully redacts a real path even when it contains spaces', () => {
    // Regression guard for the fix itself: a bounded tail must not
    // under-redact legitimate multi-segment paths like "Application Support".
    const input = 'hash-only paths [/Users/alice/Library/Application Support/key.txt], '
      + String.raw`[C:\Users\alice\secret.txt], [\\fileserver\share\team secret.txt]`;

    const sanitized = String(sanitizeGovernanceAuditValue(input));

    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('/Users/alice');
    expect(sanitized).not.toContain('Application Support');
    expect(sanitized).not.toContain('C:\\Users');
    expect(sanitized).not.toContain('secret.txt');
  });

  it('does not delete the rest of a long sentence after one incidental slash', () => {
    // This is the bug this fix addresses: a single "/" used inline (a path,
    // a fraction, a "A/B" aside) used to redact from that character to the
    // end of the string because the path pattern's tail was unbounded.
    const tail = '이하 아주 긴 나머지 문장이 살아남아야 한다. '.repeat(20);
    const input = `관찰된 문제: 경로 표기 /apps/desktop/src/foo/bar/baz/qux 이후. ${tail}`;

    const sanitized = String(sanitizeGovernanceAuditValue(input));

    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('/apps/desktop');
    expect(sanitized).toContain('나머지 문장이 살아남아야 한다');
  });

  it('redacts UNC paths that use forward slashes after the host', () => {
    // Windows accepts `\\host/share/file`; retention-audit's (deleted) copy of
    // the UNC pattern matched it and the consolidation must not lose that.
    // The redaction window runs to the end of the line, so the survival
    // marker sits on the next line.
    const input = `preview: \\\\fileserver/share/customer-4711.txt\n다음 줄은 살아남는다`;

    const sanitized = String(sanitizeGovernanceAuditValue(input));

    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('customer-4711');
    expect(sanitized).toContain('다음 줄은 살아남는다');
  });

  it('fully redacts a spaceless path longer than the 300-char window', () => {
    // A deep node_modules/pnpm-style path exceeds 300 chars with no spaces.
    // The bounded window alone leaked its tail — the most identifying part —
    // so the pattern finishes the current whitespace-free token: the whole
    // path is redacted while prose beyond the next space still survives.
    const longPath = `/deep/${'x'.repeat(320)}/customer-4711-report.txt`;
    const input = `설명: ${longPath} 이후 문장은 살아남아야 한다`;

    const sanitized = String(sanitizeGovernanceAuditValue(input));

    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('customer-4711');
    expect(sanitized).toContain('이후 문장은 살아남아야 한다');
  });
});
