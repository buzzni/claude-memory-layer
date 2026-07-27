import { describe, expect, it } from 'vitest';
import {
  formatPruneToolObservationVectorsResult,
  resolvePruneToolObservationVectorsOptions
} from '../../src/apps/cli/prune-tool-observation-vectors-command.js';

describe('prune tool-observation-vectors CLI helpers', () => {
  it('defaults to cwd and dry-run, rejects empty --project', () => {
    expect(resolvePruneToolObservationVectorsOptions({}, '/repo/current')).toEqual({
      projectPath: '/repo/current',
      dryRun: true
    });
    expect(resolvePruneToolObservationVectorsOptions({ project: '/repo/selected' }, '/repo/current')).toEqual({
      projectPath: '/repo/selected',
      dryRun: true
    });
    expect(resolvePruneToolObservationVectorsOptions({ apply: true }, '/repo/current')).toEqual({
      projectPath: '/repo/current',
      dryRun: false
    });
    expect(() => resolvePruneToolObservationVectorsOptions({ project: '   ' }, '/repo/current')).toThrow(
      '--project must not be empty'
    );
  });

  it('formats a dry-run report with samples and the re-run hint', () => {
    const output = formatPruneToolObservationVectorsResult({
      dryRun: true,
      scanned: 3,
      vectorsDeleted: 0,
      outboxRowsRemoved: 0,
      sampleEventIds: ['event-1', 'event-2']
    });

    expect(output).toContain('Mode: dry-run');
    expect(output).toContain('Scanned: 3');
    expect(output).toContain('Vectors deleted: 0');
    expect(output).toContain('- event-1');
    expect(output).toContain('- event-2');
    expect(output).toContain('Re-run with --apply');
  });

  it('formats an apply report without the dry-run hint', () => {
    const output = formatPruneToolObservationVectorsResult({
      dryRun: false,
      scanned: 3,
      vectorsDeleted: 3,
      outboxRowsRemoved: 3,
      sampleEventIds: []
    });

    expect(output).toContain('Mode: apply');
    expect(output).toContain('Vectors deleted: 3');
    expect(output).toContain('Outbox rows removed: 3');
    expect(output).not.toContain('Re-run with --apply');
    expect(output).not.toContain('Sample event IDs:');
  });
});
