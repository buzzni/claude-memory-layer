import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SUMMARY_PENDING_MAX_AGE_MS,
  SUMMARY_PENDING_MAX_ENTRIES,
  getSummaryPendingPath,
  listPendingSummaries,
  savePendingSummary,
  takePendingSummaries
} from '../../src/adapters/llm/summary-pending.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');

let homeDir: string;
let clock: number;
const options = () => ({ homeDir, now: () => clock });

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-summary-pending-'));
  clock = START;
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('summary pending queue', () => {
  it('keeps skipped sessions in the memory root, oldest first', () => {
    savePendingSummary('s1', options());
    clock += 1_000;
    savePendingSummary('s2', options());
    expect(getSummaryPendingPath({ homeDir })).toBe(path.join(homeDir, '.claude-code', 'memory', 'summary-pending.json'));
    expect(listPendingSummaries(options())).toEqual([
      { sessionId: 's1', queuedAt: '2026-01-01T00:00:00.000Z' },
      { sessionId: 's2', queuedAt: '2026-01-01T00:00:01.000Z' }
    ]);
  });

  it('keeps a session once, with the time it was first skipped', () => {
    savePendingSummary('s1', options());
    clock += 5_000;
    savePendingSummary('s1', options());
    expect(listPendingSummaries(options())).toEqual([{ sessionId: 's1', queuedAt: '2026-01-01T00:00:00.000Z' }]);
  });

  it('drops entries older than the age limit', () => {
    savePendingSummary('old', options());
    clock += SUMMARY_PENDING_MAX_AGE_MS + 1;
    savePendingSummary('new', options());
    expect(listPendingSummaries(options()).map((entry) => entry.sessionId)).toEqual(['new']);
  });

  it('keeps only the newest entries past the count limit', () => {
    for (let i = 0; i < SUMMARY_PENDING_MAX_ENTRIES + 5; i += 1) {
      savePendingSummary(`s${i}`, options());
      clock += 1;
    }
    const kept = listPendingSummaries(options());
    expect(kept).toHaveLength(SUMMARY_PENDING_MAX_ENTRIES);
    expect(kept[0].sessionId).toBe('s5');
  });

  it('hands the queue to one taker and empties it', () => {
    savePendingSummary('s1', options());
    savePendingSummary('s2', options());
    expect(takePendingSummaries(options())).toEqual(['s1', 's2']);
    expect(takePendingSummaries(options())).toEqual([]);
    expect(listPendingSummaries(options())).toEqual([]);
  });

  it('does not hand out expired entries', () => {
    savePendingSummary('s1', options());
    clock += SUMMARY_PENDING_MAX_AGE_MS + 1;
    expect(takePendingSummaries(options())).toEqual([]);
  });

  it('reads a missing or corrupt queue as empty', () => {
    expect(listPendingSummaries(options())).toEqual([]);
    fs.mkdirSync(path.dirname(getSummaryPendingPath({ homeDir })), { recursive: true });
    fs.writeFileSync(getSummaryPendingPath({ homeDir }), 'garbage');
    expect(listPendingSummaries(options())).toEqual([]);
    savePendingSummary('s1', options());
    expect(listPendingSummaries(options()).map((entry) => entry.sessionId)).toEqual(['s1']);
  });
});
