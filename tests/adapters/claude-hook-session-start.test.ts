import { describe, expect, it } from 'vitest';
import { formatCoreMemoryBlockContext } from '../../src/adapters/claude/hooks/session-start.js';
import type { CoreMemoryBlock } from '../../src/core/types.js';

function block(overrides: Partial<CoreMemoryBlock> = {}): CoreMemoryBlock {
  return {
    projectHash: 'proj-1',
    blockKey: 'project',
    content: 'This project uses SQLite + LanceDB.',
    sourceEventIds: [],
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides
  };
}

describe('formatCoreMemoryBlockContext', () => {
  it('returns an empty string when there are no blocks', () => {
    expect(formatCoreMemoryBlockContext([])).toBe('');
  });

  it('skips blocks whose content is empty or whitespace-only', () => {
    expect(formatCoreMemoryBlockContext([block({ content: '   ' })])).toBe('');
  });

  it('renders a labeled section per non-empty block, unconditionally (no query/scoring)', () => {
    const context = formatCoreMemoryBlockContext([
      block({ blockKey: 'project', content: 'Prefer plain function edits over new abstractions.' }),
      block({ blockKey: 'user', content: 'Terse responses, no trailing summaries.' })
    ]);

    expect(context).toContain('## Core Memory');
    expect(context).toContain('**Project**: Prefer plain function edits over new abstractions.');
    expect(context).toContain('**User**: Terse responses, no trailing summaries.');
  });

  it('drops only the empty block while keeping the non-empty one', () => {
    const context = formatCoreMemoryBlockContext([
      block({ blockKey: 'project', content: 'Kept content.' }),
      block({ blockKey: 'user', content: '' })
    ]);

    expect(context).toContain('**Project**: Kept content.');
    expect(context).not.toContain('**User**:');
  });
});
