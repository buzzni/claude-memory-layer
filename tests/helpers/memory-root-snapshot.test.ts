import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { diffMemoryRootSnapshots, snapshotMemoryRoot } from './memory-root-snapshot.js';

describe('memory root snapshot helper', () => {
  it('detects content, SQLite sidecar, and Lance artifact mutations', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-memory-snapshot-'));
    mkdirSync(path.join(root, 'projects', 'abc12345', 'vectors'), { recursive: true });
    writeFileSync(path.join(root, 'projects', 'abc12345', 'events.sqlite'), 'before');
    const before = snapshotMemoryRoot(root);

    writeFileSync(path.join(root, 'projects', 'abc12345', 'events.sqlite'), 'after');
    writeFileSync(path.join(root, 'projects', 'abc12345', 'events.sqlite-wal'), 'wal');
    writeFileSync(path.join(root, 'projects', 'abc12345', 'vectors', 'manifest.lance'), 'lance');

    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(root))).toEqual(expect.arrayContaining([
      'changed:projects/abc12345/events.sqlite',
      'added:projects/abc12345/events.sqlite-wal',
      'added:projects/abc12345/vectors/manifest.lance'
    ]));
  });

  it('detects creation of a previously missing memory root', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'cml-missing-memory-snapshot-'));
    const root = path.join(parent, 'memory');
    const before = snapshotMemoryRoot(root);
    mkdirSync(root);

    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(root))).toEqual(['added:.']);
  });
});
