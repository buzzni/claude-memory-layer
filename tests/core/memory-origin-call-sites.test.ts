import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A memory's origin is computed once, where a row is read from SQLite with
 * its raw columns (src/core/memory-origin.ts). Everything after that passes
 * the value on. Classifying again later, from metadata that may have been
 * parsed, dropped or merged on the way, is how unreadable metadata once came
 * back looking like "no metadata" and a trusted row.
 */

const SRC = path.join(__dirname, '../../src');

/** Readers of raw event rows, all with their own SQL; nothing else may classify. */
const ROW_READERS = [
  'core/sqlite-event-store.ts',
  'core/working-set-store.ts',
  // Instantiated only by tests today; kept consistent with the others.
  'core/event-store.ts',
  'adapters/claude/hooks/pre-edit-memory.ts'
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts|js|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}

describe('memory origin call sites', () => {
  const files = sourceFiles(SRC)
    .map((file) => ({ rel: path.relative(SRC, file).split(path.sep).join('/'), text: readFileSync(file, 'utf8') }))
    .filter(({ rel }) => rel !== 'core/memory-origin.ts');

  it('classifies stored rows only where raw rows are read', () => {
    const callers = files.filter(({ text }) => /\b(?:classifyStoredEvent|readStoredMetadata)\b/.test(text)).map(({ rel }) => rel).sort();
    expect(callers).toEqual([...ROW_READERS].sort());
  });

  it('never classifies from an already converted event or metadata', () => {
    const callers = files.filter(({ text }) => /\bclassifyMemoryOrigin\b/.test(text)).map(({ rel }) => rel);
    expect(callers).toEqual([]);
  });
});
