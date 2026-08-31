import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { previewStoreCleanup } from '../../src/core/operations/store-cleanup-preview.js';
import { hashProjectPath } from '../../src/core/registry/project-path.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('store cleanup preview', () => {
  it('requires multiple temp signals and never removes the project store', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-store-preview-home-'));
    roots.push(homeDir);
    const projectPath = path.join(tmpdir(), 'cml-e2e-fixture', 'project');
    const projectHash = hashProjectPath(projectPath);
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const storePath = path.join(memoryRoot, 'projects', projectHash);
    mkdirSync(storePath, { recursive: true });
    const store = new SQLiteEventStore(path.join(storePath, 'events.sqlite'));
    await store.initialize();
    await store.append({
      eventType: 'user_prompt',
      sessionId: 'temp-session',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      content: 'synthetic fixture',
      metadata: { scope: { project: { hash: projectHash } } }
    });
    await store.close();
    writeFileSync(path.join(memoryRoot, 'session-registry.json'), JSON.stringify({
      version: 2,
      sessions: {
        old: {
          projectPath,
          projectHash,
          registeredAt: '2026-01-01T00:00:00.000Z',
          lastSeenAt: '2026-01-01T00:00:00.000Z',
          terminal: true
        }
      }
    }));

    const baseline = previewStoreCleanup({
      homeDir,
      classification: 'temp',
      now: new Date('2026-08-31T00:00:00.000Z')
    });
    const nestedVectorDirectory = path.join(storePath, 'vectors', 'event_vectors_v2');
    mkdirSync(nestedVectorDirectory, { recursive: true });
    const nestedBytes = Buffer.byteLength('nested vector fixture');
    writeFileSync(path.join(nestedVectorDirectory, 'fragment.bin'), 'nested vector fixture');
    const externalFile = path.join(homeDir, 'external-vector-data.bin');
    writeFileSync(externalFile, 'must not be counted through a symlink');
    symlinkSync(externalFile, path.join(nestedVectorDirectory, 'external.bin'));

    const report = previewStoreCleanup({
      homeDir,
      classification: 'temp',
      now: new Date('2026-08-31T00:00:00.000Z')
    });
    expect(report.candidates).toBe(1);
    expect(report.candidateBytes).toBe(baseline.candidateBytes + nestedBytes);
    expect(report.action).toBe('quarantine_candidate');
    expect(report.samples[0]?.reasons).toEqual(expect.arrayContaining([
      'temp_root_identity',
      'fixture_identity',
      'outside_retention'
    ]));
    expect(report.samples[0]?.opaqueId).not.toContain(projectHash);
    expect(() => previewStoreCleanup({ homeDir, classification: 'temp' })).not.toThrow();
  });

  it('protects unattributed stores when age cannot be established', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-store-preview-home-'));
    roots.push(homeDir);
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    mkdirSync(path.join(memoryRoot, 'projects', 'abcdef12'), { recursive: true });
    const report = previewStoreCleanup({ homeDir, classification: 'unattributed' });
    expect(report.candidates).toBe(0);
    expect(report.protected).toBe(1);
  });

  it('rejects a symlinked projects root instead of scanning outside owned storage', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-store-preview-home-'));
    roots.push(homeDir);
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const outside = path.join(homeDir, 'outside-projects');
    mkdirSync(memoryRoot, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, path.join(memoryRoot, 'projects'));

    expect(() => previewStoreCleanup({ homeDir, classification: 'unattributed' }))
      .toThrow(/non-symlink directory/);
  });
});
