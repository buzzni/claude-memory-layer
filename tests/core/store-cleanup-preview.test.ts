import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

  it('classifies an empty store registered from the temp root as temp once the store file is old enough', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-store-preview-home-'));
    roots.push(homeDir);
    const projectPath = path.join(realpathSync(tmpdir()), 'probe-XyZ123', 'project');
    const projectHash = hashProjectPath(projectPath);
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const storePath = path.join(memoryRoot, 'projects', projectHash);
    mkdirSync(storePath, { recursive: true });
    const dbPath = path.join(storePath, 'events.sqlite');
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();
    await store.close();
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(dbPath, createdAt, createdAt);
    writeFileSync(path.join(memoryRoot, 'session-registry.json'), JSON.stringify({
      version: 2,
      sessions: {
        probe: {
          projectPath,
          projectHash,
          registeredAt: '2026-01-01T00:00:00.000Z',
          lastSeenAt: '2026-01-01T00:00:00.000Z',
          terminal: true
        }
      }
    }));

    const report = previewStoreCleanup({
      homeDir,
      classification: 'temp',
      now: new Date('2026-08-31T00:00:00.000Z')
    });
    expect(report.candidates).toBe(1);
    expect(report.samples[0]?.reasons).toEqual(expect.arrayContaining([
      'temp_root_identity',
      'outside_retention'
    ]));

    const recent = previewStoreCleanup({
      homeDir,
      classification: 'temp',
      now: new Date('2026-01-15T00:00:00.000Z')
    });
    expect(recent.candidates).toBe(0);
  });

  it('recovers temp attribution from the store sessions table after the registry forgot the project', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-store-preview-home-'));
    roots.push(homeDir);
    const projectPath = path.join(realpathSync(tmpdir()), 'probe-forgotten', 'project');
    const projectHash = hashProjectPath(projectPath);
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const storePath = path.join(memoryRoot, 'projects', projectHash);
    mkdirSync(storePath, { recursive: true });
    const dbPath = path.join(storePath, 'events.sqlite');
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();
    await store.upsertSession({ id: 'forgotten-session', projectPath, startedAt: new Date('2026-01-01T00:00:00.000Z') });
    await store.close();
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(dbPath, createdAt, createdAt);
    writeFileSync(path.join(memoryRoot, 'session-registry.json'), JSON.stringify({ version: 2, sessions: {} }));

    const report = previewStoreCleanup({
      homeDir,
      classification: 'temp',
      now: new Date('2026-08-31T00:00:00.000Z')
    });
    expect(report.candidates).toBe(1);
    expect(report.samples[0]?.reasons).toEqual(expect.arrayContaining([
      'temp_root_identity',
      'outside_retention'
    ]));

    const unattributed = previewStoreCleanup({
      homeDir,
      classification: 'unattributed',
      now: new Date('2026-08-31T00:00:00.000Z')
    });
    expect(unattributed.candidates).toBe(0);
  });

  it('does not classify an old inactive workspace store as temp without a temp-path signal', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'cml-store-preview-home-'));
    roots.push(homeDir);
    // Outside tmpdir on purpose: homeDir itself lives under the temp root.
    const projectPath = path.resolve('/srv/workspace/real-project');
    const projectHash = hashProjectPath(projectPath);
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const storePath = path.join(memoryRoot, 'projects', projectHash);
    mkdirSync(storePath, { recursive: true });
    const dbPath = path.join(storePath, 'events.sqlite');
    const store = new SQLiteEventStore(dbPath);
    await store.initialize();
    await store.upsertSession({ id: 'old-session', projectPath, startedAt: new Date('2026-01-01T00:00:00.000Z') });
    await store.close();
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(dbPath, createdAt, createdAt);
    writeFileSync(path.join(memoryRoot, 'session-registry.json'), JSON.stringify({ version: 2, sessions: {} }));

    const report = previewStoreCleanup({
      homeDir,
      classification: 'temp',
      now: new Date('2026-08-31T00:00:00.000Z')
    });
    expect(report.candidates).toBe(0);
    expect(report.protected).toBe(1);
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
