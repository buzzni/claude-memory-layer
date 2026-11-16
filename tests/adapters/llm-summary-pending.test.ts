import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SUMMARY_PENDING_MAX_AGE_MS,
  SUMMARY_PENDING_MAX_ATTEMPTS,
  SUMMARY_PENDING_MAX_ENTRIES,
  SUMMARY_PENDING_STALE_CLAIM_MS,
  claimPendingSummary,
  completePendingSummary,
  getSummaryPendingDir,
  listPendingSummaries,
  pendingSummarySessionIds,
  releasePendingSummary,
  savePendingSummary,
  type SummaryPendingOptions
} from '../../src/adapters/llm/summary-pending.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');
const ME = 1111;
const OTHER = 2222;

let homeDir: string;
let clock: number;
let running: Set<number>;

const options = (overrides: Partial<SummaryPendingOptions> = {}): SummaryPendingOptions => ({
  homeDir,
  now: () => clock,
  pid: ME,
  isProcessRunning: (pid) => running.has(pid),
  ...overrides
});

const ids = () => listPendingSummaries(options()).map((entry) => entry.sessionId);

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-summary-pending-'));
  clock = START;
  running = new Set([ME, OTHER]);
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('keeping skipped summaries', () => {
  it('keeps one file per session in the memory root, listed oldest first', () => {
    savePendingSummary('s1', options());
    clock += 1_000;
    savePendingSummary('s2', options());
    expect(getSummaryPendingDir({ homeDir })).toBe(path.join(homeDir, '.claude-code', 'memory', 'summary-pending'));
    expect(fs.readdirSync(getSummaryPendingDir({ homeDir })).filter((name) => name.endsWith('.json')).sort()).toEqual(['s1.json', 's2.json']);
    expect(listPendingSummaries(options())).toEqual([
      { sessionId: 's1', queuedAt: '2026-01-01T00:00:00.000Z', attempts: 0 },
      { sessionId: 's2', queuedAt: '2026-01-01T00:00:01.000Z', attempts: 0 }
    ]);
  });

  it('keeps a session once, with the time it was first skipped', () => {
    savePendingSummary('s1', options());
    clock += 5_000;
    savePendingSummary('s1', options());
    expect(listPendingSummaries(options())).toEqual([{ sessionId: 's1', queuedAt: '2026-01-01T00:00:00.000Z', attempts: 0 }]);
  });

  it('drops entries older than the age limit', () => {
    savePendingSummary('old', options());
    clock += SUMMARY_PENDING_MAX_AGE_MS + 1;
    savePendingSummary('new', options());
    expect(ids()).toEqual(['new']);
    expect(fs.readdirSync(getSummaryPendingDir({ homeDir })).filter((name) => name.endsWith('.json'))).toEqual(['new.json']);
  });

  it('keeps only the newest entries past the count limit', () => {
    for (let i = 0; i < SUMMARY_PENDING_MAX_ENTRIES + 5; i += 1) {
      savePendingSummary(`s${i}`, options());
      clock += 1;
    }
    const kept = ids();
    expect(kept).toHaveLength(SUMMARY_PENDING_MAX_ENTRIES);
    expect(kept[0]).toBe('s5');
  });

  it('counts claimed entries toward the limit (review case: 100 claimed + 100 new kept 200)', () => {
    for (let i = 0; i < SUMMARY_PENDING_MAX_ENTRIES; i += 1) {
      savePendingSummary(`c${i}`, options());
      claimPendingSummary(`c${i}`, options());
    }
    for (let i = 0; i < SUMMARY_PENDING_MAX_ENTRIES; i += 1) {
      clock += 1;
      savePendingSummary(`n${i}`, options());
    }
    expect(listPendingSummaries(options()).length).toBeLessThanOrEqual(SUMMARY_PENDING_MAX_ENTRIES);
    // Claimed entries belong to running retries and are never pruned.
    expect(ids().filter((id) => id.startsWith('c'))).toHaveLength(SUMMARY_PENDING_MAX_ENTRIES);
  });

  it('drops the oldest unclaimed entries first when claimed ones fill part of the queue', () => {
    for (let i = 0; i < 10; i += 1) {
      savePendingSummary(`c${i}`, options());
      claimPendingSummary(`c${i}`, options());
    }
    for (let i = 0; i < SUMMARY_PENDING_MAX_ENTRIES; i += 1) {
      clock += 1;
      savePendingSummary(`n${i}`, options());
    }
    const kept = ids();
    expect(kept).toHaveLength(SUMMARY_PENDING_MAX_ENTRIES);
    expect(kept).not.toContain('n9');
    expect(kept).toContain('n10');
  });

  it('ignores corrupt files', () => {
    fs.mkdirSync(getSummaryPendingDir({ homeDir }), { recursive: true });
    fs.writeFileSync(path.join(getSummaryPendingDir({ homeDir }), 'bad.json'), 'garbage');
    savePendingSummary('s1', options());
    expect(ids()).toEqual(['s1']);
  });
});

describe('summary pending storage failures', () => {
  it('never throws from save, claim or complete when the directory turns read-only', () => {
    if (process.getuid?.() === 0) return; // root ignores the permission bits
    savePendingSummary('s1', options());
    const dir = getSummaryPendingDir({ homeDir });
    fs.chmodSync(dir, 0o500);
    try {
      clock += SUMMARY_PENDING_MAX_AGE_MS + 1;
      expect(() => savePendingSummary('s2', options())).not.toThrow();
      clock = START;
      expect(claimPendingSummary('s1', options())).toBeNull();
      expect(() => completePendingSummary({ sessionId: 's1', record: { sessionId: 's1', queuedAt: '2026-01-01T00:00:00.000Z', attempts: 0 }, claimPath: path.join(dir, 's1.json'), queuePath: path.join(dir, 's1.json') })).not.toThrow();
      expect(ids()).toEqual(['s1']);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});

describe('queue lock', () => {
  function holdQueueLock(): void {
    const dir = getSummaryPendingDir({ homeDir });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: OTHER, ownerId: 'other', acquiredAt: '2026-01-01T00:00:00.000Z' }));
  }

  it('changes nothing, and above all removes nothing, while another process holds the queue lock (review case: prune vs claim)', () => {
    savePendingSummary('s1', options());
    const claim = claimPendingSummary('s1', options())!;
    savePendingSummary('s2', options());
    const before = fs.readdirSync(getSummaryPendingDir({ homeDir })).sort();
    holdQueueLock();

    clock += SUMMARY_PENDING_MAX_AGE_MS + 1;
    savePendingSummary('s3', options());
    completePendingSummary(claim, options());
    releasePendingSummary(claim, { failed: true }, options());
    expect(claimPendingSummary('s2', options())).toBeNull();
    expect(pendingSummarySessionIds(options())).toEqual([]);

    expect(fs.readdirSync(getSummaryPendingDir({ homeDir })).filter((name) => name !== '.lock').sort()).toEqual(before);
  });

  it('takes over the queue lock of a dead process', () => {
    savePendingSummary('s1', options());
    holdQueueLock();
    running.delete(OTHER);
    expect(pendingSummarySessionIds(options())).toEqual(['s1']);
  });
});

describe('retrying kept summaries', () => {
  it('removes an entry only when its retry completes', () => {
    savePendingSummary('s1', options());
    const claim = claimPendingSummary('s1', options())!;
    expect(ids()).toEqual(['s1']);
    completePendingSummary(claim);
    expect(ids()).toEqual([]);
  });

  it('gives a session to one claimer at a time', () => {
    savePendingSummary('s1', options());
    expect(claimPendingSummary('s1', options())).not.toBeNull();
    expect(claimPendingSummary('s1', options({ pid: OTHER }))).toBeNull();
    expect(pendingSummarySessionIds(options())).toEqual([]);
  });

  it('puts an entry back after a failed retry and counts the attempt (review case: timeout)', () => {
    savePendingSummary('s1', options());
    releasePendingSummary(claimPendingSummary('s1', options())!, { failed: true });
    expect(listPendingSummaries(options())).toEqual([{ sessionId: 's1', queuedAt: '2026-01-01T00:00:00.000Z', attempts: 1 }]);
    expect(pendingSummarySessionIds(options())).toEqual(['s1']);
  });

  it('puts an entry back after a deferred retry without counting it (review case: store busy)', () => {
    savePendingSummary('s1', options());
    releasePendingSummary(claimPendingSummary('s1', options())!, { failed: false });
    expect(listPendingSummaries(options())).toEqual([{ sessionId: 's1', queuedAt: '2026-01-01T00:00:00.000Z', attempts: 0 }]);
  });

  it('drops an entry after the last failed attempt', () => {
    savePendingSummary('s1', options());
    for (let i = 0; i < SUMMARY_PENDING_MAX_ATTEMPTS; i += 1) {
      releasePendingSummary(claimPendingSummary('s1', options())!, { failed: true });
    }
    expect(ids()).toEqual([]);
  });

  it('keeps the original queuedAt when the session is skipped again during its retry (review recommendation)', () => {
    savePendingSummary('s1', options());
    const claim = claimPendingSummary('s1', options())!;
    clock += 60_000;
    savePendingSummary('s1', options());
    releasePendingSummary(claim, { failed: false });
    expect(listPendingSummaries(options())).toEqual([{ sessionId: 's1', queuedAt: '2026-01-01T00:00:00.000Z', attempts: 0 }]);
  });

  it('does not hand out expired entries', () => {
    savePendingSummary('s1', options());
    clock += SUMMARY_PENDING_MAX_AGE_MS + 1;
    expect(claimPendingSummary('s1', options())).toBeNull();
    expect(ids()).toEqual([]);
  });

  it('does not let an owner whose claim was taken back overwrite or remove the new state (review recommendation)', () => {
    savePendingSummary('s1', options());
    const stale = claimPendingSummary('s1', options({ pid: OTHER }))!;
    running.delete(OTHER);
    expect(pendingSummarySessionIds(options())).toEqual(['s1']);
    const fresh = claimPendingSummary('s1', options())!;

    releasePendingSummary(stale, { failed: true }, options());
    completePendingSummary(stale, options());
    expect(fs.existsSync(fresh.claimPath)).toBe(true);
    expect(listPendingSummaries(options())).toMatchObject([{ sessionId: 's1', attempts: 0 }]);
  });

  it('a save while the session is claimed adds no second entry and no second claim (review case)', () => {
    savePendingSummary('s1', options());
    const claim = claimPendingSummary('s1', options())!;
    savePendingSummary('s1', options());
    expect(claimPendingSummary('s1', options({ pid: OTHER }))).toBeNull();
    expect(fs.readdirSync(getSummaryPendingDir({ homeDir })).filter((name) => name.startsWith('s1.'))).toEqual([path.basename(claim.claimPath)]);
  });

  it('takes back a claim whose owner died mid-retry (review case: daemon crash)', () => {
    savePendingSummary('s1', options());
    savePendingSummary('s2', options());
    claimPendingSummary('s1', options({ pid: OTHER }));
    running.delete(OTHER);
    expect(pendingSummarySessionIds(options())).toEqual(['s1', 's2']);
  });

  it('leaves a fresh claim of a live owner alone', () => {
    savePendingSummary('s1', options());
    claimPendingSummary('s1', options({ pid: OTHER }));
    clock += SUMMARY_PENDING_STALE_CLAIM_MS;
    expect(pendingSummarySessionIds(options())).toEqual([]);
  });

  it('takes back a claim older than any summary run even if its pid is alive', () => {
    savePendingSummary('s1', options());
    claimPendingSummary('s1', options({ pid: OTHER }));
    clock += SUMMARY_PENDING_STALE_CLAIM_MS + 1;
    expect(pendingSummarySessionIds(options())).toEqual(['s1']);
  });

  it('takes back a claim dated in the future, as after the clock went back', () => {
    savePendingSummary('s1', options());
    claimPendingSummary('s1', options({ pid: OTHER, now: () => START + 60 * 60_000 }));
    expect(pendingSummarySessionIds(options())).toEqual(['s1']);
  });
});
