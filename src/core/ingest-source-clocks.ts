import { sqliteAll, toDateFromSQLite, type SQLiteDatabase } from './sqlite-wrapper.js';

/** Audit dimensions are enums, never arbitrary metadata or filesystem paths. */
export function safeSourceLabel(value: unknown): string {
  if (value == null || value === '') return 'native';
  return ['native', 'claude', 'claude-code', 'codex', 'hermes', 'import', 'manual'].includes(String(value))
    ? String(value) : 'other';
}

export function safeClientLabel(value: unknown): string {
  return ['claude-hook', 'codex-hook', 'mcp', 'hermes', 'cli', 'dashboard'].includes(String(value))
    ? String(value) : 'unknown';
}

/** Reads clocks without initialization or migrations, suitable for audit snapshots. */
export function readIngestSourceClocks(db: SQLiteDatabase, options: { since?: Date; until?: Date } = {}) {
    const eventColumns = new Set(sqliteAll<{ name: string }>(db, 'PRAGMA table_info(events)').map((row) => row.name));
    const sourceExpression = eventColumns.has('metadata')
      ? `COALESCE(
           json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.source'),
           'native'
         )`
      : `'native'`;
    const occurredAtExpression = eventColumns.has('metadata')
      ? `COALESCE(
           json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.originalTimestamp'),
           json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.ingest.occurredAt')
         )`
      : 'NULL';
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.since) {
      clauses.push('julianday(timestamp) >= julianday(?)');
      params.push(options.since.toISOString());
    }
    if (options.until) {
      clauses.push('julianday(timestamp) < julianday(?)');
      params.push(options.until.toISOString());
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = sqliteAll<{ source: string | null; timestamp: string; occurred_at: string | null }>(
      db,
      `SELECT
         ${sourceExpression} AS source,
         timestamp,
         ${occurredAtExpression} AS occurred_at
       FROM events${where}`,
      params
    );

    const bySource = new Map<string, {
      events: number;
      lags: number[];
      unknown: number;
      latestOccurredAt: number | null;
      latestIngestedAt: number | null;
    }>();
    for (const row of rows) {
      const source = safeSourceLabel(row.source);
      const entry = bySource.get(source)
        ?? { events: 0, lags: [], unknown: 0, latestOccurredAt: null, latestIngestedAt: null };
      entry.events += 1;
      const ingestedMs = toDateFromSQLite(row.timestamp ?? '').getTime();
      if (Number.isFinite(ingestedMs)) {
        entry.latestIngestedAt = entry.latestIngestedAt === null
          ? ingestedMs
          : Math.max(entry.latestIngestedAt, ingestedMs);
      }
      const occurredMs = row.occurred_at ? toDateFromSQLite(row.occurred_at).getTime() : NaN;
      if (Number.isFinite(occurredMs)) {
        entry.latestOccurredAt = entry.latestOccurredAt === null
          ? occurredMs
          : Math.max(entry.latestOccurredAt, occurredMs);
        if (Number.isFinite(ingestedMs)) entry.lags.push(Math.max(0, ingestedMs - occurredMs));
      } else {
        entry.unknown += 1;
      }
      bySource.set(source, entry);
    }

    return Array.from(bySource.entries())
      .map(([source, entry]) => {
        const sorted = [...entry.lags].sort((a, b) => a - b);
        return {
          source,
          events: entry.events,
          withSourceClock: entry.lags.length,
          unknownSourceClock: entry.unknown,
          latestOccurredAt: entry.latestOccurredAt === null ? null : new Date(entry.latestOccurredAt).toISOString(),
          latestIngestedAt: entry.latestIngestedAt === null ? null : new Date(entry.latestIngestedAt).toISOString(),
          maxLagMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
          medianLagMs: sorted.length > 0 ? sorted[Math.floor((sorted.length - 1) / 2)] : null
        };
      })
      .sort((a, b) => b.events - a.events);
}
