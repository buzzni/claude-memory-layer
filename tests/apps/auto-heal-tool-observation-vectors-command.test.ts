import { describe, expect, it } from 'vitest';
import {
  formatAutoHealToolObservationVectorsResult,
  resolveAutoHealToolObservationVectorsOptions
} from '../../src/apps/cli/auto-heal-tool-observation-vectors-command.js';

describe('auto-heal tool-observation-vectors CLI helpers', () => {
  it('defaults project path to cwd, rejects empty --project', () => {
    expect(resolveAutoHealToolObservationVectorsOptions({}, '/repo/current')).toEqual({
      projectPath: '/repo/current',
      lockPath: undefined
    });
    expect(resolveAutoHealToolObservationVectorsOptions({ project: '/repo/selected' }, '/repo/current')).toEqual({
      projectPath: '/repo/selected',
      lockPath: undefined
    });
    expect(() => resolveAutoHealToolObservationVectorsOptions({ project: '  ' }, '/repo/current')).toThrow(
      '--project must not be empty'
    );
  });

  it('passes through an explicit lock path override', () => {
    expect(resolveAutoHealToolObservationVectorsOptions(
      { project: '/repo/selected', lockPath: '/tmp/custom.lock' },
      '/repo/current'
    )).toEqual({
      projectPath: '/repo/selected',
      lockPath: '/tmp/custom.lock'
    });
  });

  it('formats each outcome distinctly', () => {
    expect(formatAutoHealToolObservationVectorsResult({ status: 'already-healed' }))
      .toContain('already healed');
    expect(formatAutoHealToolObservationVectorsResult({ status: 'lock-busy' }))
      .toContain('another process');
    expect(formatAutoHealToolObservationVectorsResult({ status: 'no-store' }))
      .toContain('no store found');
    const healed = formatAutoHealToolObservationVectorsResult({
      status: 'healed',
      result: { dryRun: false, scanned: 5, vectorsDeleted: 5, outboxRowsRemoved: 5, sampleEventIds: [] }
    });
    expect(healed).toContain('Vectors deleted: 5');
    expect(healed).toContain('Outbox rows removed: 5');
  });
});
