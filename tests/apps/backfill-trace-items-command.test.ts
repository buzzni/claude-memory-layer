import { describe, expect, it } from 'vitest';
import { resolveBackfillTraceItemsOptions } from '../../src/apps/cli/backfill-trace-items-command.js';

describe('backfill trace item limit validation', () => {
  it.each(['1.5', '10junk', '1e3', '0', '-1', '', '9007199254740992'])(
    'rejects invalid limit %j before resolving a write', (limit) => {
      expect(() => resolveBackfillTraceItemsOptions({ limit, apply: true }))
        .toThrow('--limit must be a positive integer');
    }
  );

  it('accepts integer limits and keeps dry-run as the default', () => {
    expect(resolveBackfillTraceItemsOptions({ limit: ' 12 ' }, '/project'))
      .toMatchObject({ limit: 12, dryRun: true });
    expect(resolveBackfillTraceItemsOptions({}, '/project').limit).toBe(1000);
  });
});
