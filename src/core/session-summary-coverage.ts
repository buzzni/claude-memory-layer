import { sqliteAll, sqliteGet, type SQLiteDatabase } from './sqlite-wrapper.js';

export interface SessionSummaryCoverage {
  /** Sessions whose first non-summary event falls in the window. */
  sessionsStarted: number;
  /** Started sessions with >=3 events and >=2 user_prompt/agent_response events (summary events excluded). */
  eligible: number;
  /** Started sessions that have a session_summary event, whenever it was written. */
  withSummary: number;
  /** Started sessions whose session_summary metadata says generated: "llm". */
  llmGenerated: number;
  /** Newest session_summary timestamp inside the window. */
  latestSummaryAt: string | null;
}

/**
 * Read-only: runs on an audit snapshot, so it must not initialize or migrate
 * the store. Mirrors the summary generator's floor so a session that could
 * never get a summary is not reported as a miss.
 */
export function readSessionSummaryCoverage(
  db: SQLiteDatabase,
  options: { since?: Date; until?: Date } = {}
): SessionSummaryCoverage {
  const hasMetadata = sqliteAll<{ name: string }>(db, 'PRAGMA table_info(events)')
    .some((column) => column.name === 'metadata');
  const llmExpression = hasMetadata
    ? `json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.generated') = 'llm'`
    : '0';

  const startClauses: string[] = ['started_at IS NOT NULL'];
  const startParams: unknown[] = [];
  const summaryClauses: string[] = [`event_type = 'session_summary'`];
  const summaryParams: unknown[] = [];
  if (options.since) {
    startClauses.push('julianday(started_at) >= julianday(?)');
    startParams.push(options.since.toISOString());
    summaryClauses.push('julianday(timestamp) >= julianday(?)');
    summaryParams.push(options.since.toISOString());
  }
  if (options.until) {
    startClauses.push('julianday(started_at) < julianday(?)');
    startParams.push(options.until.toISOString());
    summaryClauses.push('julianday(timestamp) < julianday(?)');
    summaryParams.push(options.until.toISOString());
  }

  const totals = sqliteGet<{ started: number; eligible: number | null; summarized: number | null; llm: number | null }>(
    db,
    `SELECT COUNT(*) AS started,
            SUM(CASE WHEN events >= 3 AND conversational >= 2 THEN 1 ELSE 0 END) AS eligible,
            SUM(summarized) AS summarized,
            SUM(llm) AS llm
     FROM (
       SELECT MIN(CASE WHEN event_type != 'session_summary' THEN timestamp END) AS started_at,
              SUM(CASE WHEN event_type != 'session_summary' THEN 1 ELSE 0 END) AS events,
              SUM(CASE WHEN event_type IN ('user_prompt', 'agent_response') THEN 1 ELSE 0 END) AS conversational,
              MAX(CASE WHEN event_type = 'session_summary' THEN 1 ELSE 0 END) AS summarized,
              MAX(CASE WHEN event_type = 'session_summary' AND ${llmExpression} THEN 1 ELSE 0 END) AS llm
       FROM events GROUP BY session_id
     ) WHERE ${startClauses.join(' AND ')}`,
    startParams
  );
  const latest = sqliteGet<{ timestamp: string }>(
    db,
    `SELECT timestamp FROM events WHERE ${summaryClauses.join(' AND ')} ORDER BY julianday(timestamp) DESC LIMIT 1`,
    summaryParams
  );

  return {
    sessionsStarted: Number(totals?.started ?? 0),
    eligible: Number(totals?.eligible ?? 0),
    withSummary: Number(totals?.summarized ?? 0),
    llmGenerated: Number(totals?.llm ?? 0),
    latestSummaryAt: latest?.timestamp ?? null
  };
}
