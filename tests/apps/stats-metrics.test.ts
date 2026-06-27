import { describe, it, expect } from 'vitest';
import {
  windowToMs,
  inWindow,
  isEditToolName,
  parseToolPayload,
  isTestLikeCommand,
  safeRatio,
  round,
  computeSessionTurnCount
} from '../../src/apps/server/api/stats-metrics.js';
import type { MemoryEvent } from '../../src/core/types.js';

function ev(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: 'e',
    eventType: 'tool_observation',
    sessionId: 's',
    timestamp: new Date(),
    content: '',
    canonicalKey: 'k',
    dedupeKey: 'd',
    metadata: {},
    ...overrides
  };
}

describe('stats-metrics pure helpers', () => {
  it('windowToMs maps each window to its duration', () => {
    expect(windowToMs('24h')).toBe(24 * 60 * 60 * 1000);
    expect(windowToMs('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(windowToMs('30d')).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('inWindow respects the window boundary', () => {
    const now = Date.now();
    expect(inWindow(ev({ timestamp: new Date(now - 1000) }), now, '24h')).toBe(true);
    expect(inWindow(ev({ timestamp: new Date(now - 2 * 24 * 60 * 60 * 1000) }), now, '24h')).toBe(false);
  });

  it('isEditToolName recognizes edit tools only', () => {
    expect(isEditToolName('Edit')).toBe(true);
    expect(isEditToolName('MultiEdit')).toBe(true);
    expect(isEditToolName('Bash')).toBe(false);
  });

  it('isTestLikeCommand recognizes test/build/lint commands', () => {
    expect(isTestLikeCommand('npm test')).toBe(true);
    expect(isTestLikeCommand('vitest run')).toBe(true);
    expect(isTestLikeCommand('git status')).toBe(false);
    expect(isTestLikeCommand(undefined)).toBe(false);
  });

  it('parseToolPayload reads tool fields from content JSON, falling back to metadata', () => {
    const fromContent = parseToolPayload(
      ev({ content: JSON.stringify({ toolName: 'Edit', success: true, metadata: { filePath: '/a.ts', command: 'x' } }) })
    );
    expect(fromContent).toMatchObject({ toolName: 'Edit', success: true, filePath: '/a.ts', command: 'x' });

    const fromMeta = parseToolPayload(
      ev({ content: 'not json', metadata: { toolName: 'Bash', success: false, command: 'ls' } as MemoryEvent['metadata'] })
    );
    expect(fromMeta).toMatchObject({ toolName: 'Bash', success: false, command: 'ls' });

    expect(parseToolPayload(ev({ eventType: 'user_prompt' }))).toBeNull();
  });

  it('safeRatio guards against zero/invalid denominators', () => {
    expect(safeRatio(3, 4)).toBe(0.75);
    expect(safeRatio(1, 0)).toBe(0);
    expect(safeRatio(Number.NaN, 5)).toBe(0);
  });

  it('round limits decimal places', () => {
    expect(round(0.123456)).toBe(0.1235);
    expect(round(0.123456, 2)).toBe(0.12);
  });

  it('computeSessionTurnCount counts distinct turn ids, else user prompts', () => {
    const withTurns = [
      ev({ metadata: { turnId: 't1' } as MemoryEvent['metadata'] }),
      ev({ metadata: { turnId: 't1' } as MemoryEvent['metadata'] }),
      ev({ metadata: { turnId: 't2' } as MemoryEvent['metadata'] })
    ];
    expect(computeSessionTurnCount(withTurns)).toBe(2);

    const noTurns = [
      ev({ eventType: 'user_prompt' }),
      ev({ eventType: 'user_prompt' }),
      ev({ eventType: 'agent_response' })
    ];
    expect(computeSessionTurnCount(noTurns)).toBe(2);
  });
});
