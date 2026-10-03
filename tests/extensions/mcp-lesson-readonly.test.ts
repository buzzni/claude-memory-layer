import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { LessonRepository } from '../../src/core/operations/lesson-repository.js';
import { MemoryAssetPermissionService } from '../../src/core/operations/memory-asset-permission-service.js';
import { getProjectStoragePath, hashProjectPath } from '../../src/core/registry/project-path.js';
import { handleToolCall } from '../../src/extensions/mcp/handlers.js';
import { snapshotMemoryRoot, diffMemoryRootSnapshots } from '../helpers/memory-root-snapshot.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cml-lesson-readonly-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('CLAUDE_MEMORY_ASSET_PERMISSION_MODE', 'legacy');
  const projectPath = join(root, 'project');
  const projectHash = hashProjectPath(projectPath);
  const dbPath = join(getProjectStoragePath(projectPath), 'events.sqlite');
  const store = new SQLiteEventStore(dbPath);
  await store.initialize();
  const lesson = await new LessonRepository(store.getDatabase()).upsert({
    projectHash, name: 'Read a preview', trigger: 'When a preview is delivered',
    steps: ['Read the complete lesson'], sourceEventIds: ['fixture-event'], sourceClass: 'curated'
  });
  return { root, projectPath, projectHash, dbPath, store, lesson, memoryRoot: join(home, '.claude-code', 'memory') };
}

async function read(projectPath: string, args: Record<string, unknown>) {
  const result = await handleToolCall('mem-lesson-get', { projectPath, ...args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return JSON.parse(String(result.content[0]?.text));
}

describe('MCP lesson body lookup in a read-only runtime', () => {
  it('reads by id and name without writing a closed read-only canonical store', async () => {
    const f = await fixture();
    await f.store.close();
    chmodSync(f.dbPath, 0o444);
    const directory = getProjectStoragePath(f.projectPath);
    chmodSync(directory, 0o555);
    const before = snapshotMemoryRoot(f.memoryRoot);
    try {
      for (const args of [{ lessonId: f.lesson.lessonId }, { name: f.lesson.name }]) {
        expect(await read(f.projectPath, args)).toMatchObject({ found: true, lesson: { steps: f.lesson.steps } });
      }
      expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
    } finally {
      chmodSync(directory, 0o755);
      chmodSync(f.dbPath, 0o644);
    }
  });

  it('reads committed WAL rows and preserves permission and project boundaries', async () => {
    const f = await fixture();
    try {
      await new MemoryAssetPermissionService(f.store.getDatabase()).create({
        projectHash: f.projectHash, requesterActorId: 'owner', assetId: `lesson:${f.lesson.lessonId}`,
        assetType: 'lesson', title: f.lesson.name, sourceRefs: [`lesson:${f.lesson.lessonId}`]
      });
      const foreign = await new LessonRepository(f.store.getDatabase()).upsert({
        projectHash: 'another-project', name: 'Foreign lesson', trigger: 'Never cross projects',
        steps: ['Private step'], sourceEventIds: ['foreign-event']
      });
      vi.stubEnv('CLAUDE_MEMORY_ASSET_PERMISSION_MODE', 'strict');
      const before = snapshotMemoryRoot(f.memoryRoot);
      expect(await read(f.projectPath, { lessonId: f.lesson.lessonId, requesterActorId: 'owner' })).toMatchObject({ found: true });
      expect(await read(f.projectPath, { lessonId: f.lesson.lessonId, requesterActorId: 'other' })).toMatchObject({ found: false });
      expect((await handleToolCall('mem-lesson-get', { projectPath: f.projectPath, lessonId: f.lesson.lessonId })).isError).toBe(true);
      expect(await read(f.projectPath, { lessonId: 'missing', requesterActorId: 'owner' })).toMatchObject({ found: false });
      vi.stubEnv('CLAUDE_MEMORY_ASSET_PERMISSION_MODE', 'legacy');
      expect(await read(f.projectPath, { lessonId: foreign.lessonId })).toMatchObject({ found: false });
      expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
    } finally { await f.store.close(); }
  });

  it('rejects temporary snapshots anywhere inside canonical memory storage', async () => {
    const f = await fixture();
    await f.store.close();
    const temp = join(f.memoryRoot, 'other-project-temp');
    mkdirSync(temp);
    vi.stubEnv('TMPDIR', temp);
    vi.stubEnv('TMP', temp);
    vi.stubEnv('TEMP', temp);
    const before = snapshotMemoryRoot(f.memoryRoot);
    const result = await handleToolCall('mem-lesson-get', { projectPath: f.projectPath, lessonId: f.lesson.lessonId });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain('Snapshot directory must be outside canonical memory storage');
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
  });

  it('does not create an empty store for an unknown project', async () => {
    const f = await fixture();
    await f.store.close();
    const before = snapshotMemoryRoot(f.memoryRoot);
    const result = await handleToolCall('mem-lesson-get', { projectPath: join(f.root, 'unknown'), lessonId: f.lesson.lessonId });
    expect(result.isError).toBe(true);
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
  });

  it('lists lessons from a closed read-only canonical store without writing it', async () => {
    const f = await fixture();
    await f.store.close();
    chmodSync(f.dbPath, 0o444);
    const directory = getProjectStoragePath(f.projectPath);
    chmodSync(directory, 0o555);
    const before = snapshotMemoryRoot(f.memoryRoot);
    try {
      const result = await handleToolCall('mem-lesson-list', { projectPath: f.projectPath });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(JSON.parse(String(result.content[0]?.text))).toMatchObject({
        operation: 'mem-lesson-list', count: 1, lessons: [{ lessonId: f.lesson.lessonId }]
      });
      expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
    } finally {
      chmodSync(directory, 0o755);
      chmodSync(f.dbPath, 0o644);
    }
  });

  it('lists committed WAL rows under strict permissions and project scope', async () => {
    const f = await fixture();
    try {
      await new MemoryAssetPermissionService(f.store.getDatabase()).create({
        projectHash: f.projectHash, requesterActorId: 'owner', assetId: `lesson:${f.lesson.lessonId}`,
        assetType: 'lesson', title: f.lesson.name, sourceRefs: [`lesson:${f.lesson.lessonId}`]
      });
      await new LessonRepository(f.store.getDatabase()).upsert({
        projectHash: 'another-project', name: 'Foreign lesson', trigger: 'Never cross projects',
        steps: ['Private step'], sourceEventIds: ['foreign-event']
      });
      vi.stubEnv('CLAUDE_MEMORY_ASSET_PERMISSION_MODE', 'strict');
      const before = snapshotMemoryRoot(f.memoryRoot);
      const list = async (requesterActorId?: string) => {
        const result = await handleToolCall('mem-lesson-list', { projectPath: f.projectPath, requesterActorId });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        return JSON.parse(String(result.content[0]?.text));
      };
      expect(await list('owner')).toMatchObject({ count: 1, lessons: [{ lessonId: f.lesson.lessonId }] });
      expect(await list('other')).toMatchObject({ count: 0 });
      expect((await handleToolCall('mem-lesson-list', { projectPath: f.projectPath })).isError).toBe(true);
      vi.stubEnv('CLAUDE_MEMORY_ASSET_PERMISSION_MODE', 'legacy');
      const legacy = await list();
      expect(legacy.lessons.map((lesson: { name: string }) => lesson.name)).toEqual([f.lesson.name]);
      expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
    } finally { await f.store.close(); }
  });

  it('reports a missing store with a typed code and creates nothing', async () => {
    const f = await fixture();
    await f.store.close();
    const before = snapshotMemoryRoot(f.memoryRoot);
    const result = await handleToolCall('mem-lesson-list', { projectPath: join(f.root, 'unknown') });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'store_missing', storeStatus: 'missing' });
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
  });

  it('distinguishes an unwritable snapshot directory from an unreadable source store', async () => {
    const f = await fixture();
    await f.store.close();
    const blockedTemp = join(f.root, 'blocked-temp');
    mkdirSync(blockedTemp);
    chmodSync(blockedTemp, 0o555);
    vi.stubEnv('TMPDIR', blockedTemp);
    vi.stubEnv('TMP', blockedTemp);
    vi.stubEnv('TEMP', blockedTemp);
    const before = snapshotMemoryRoot(f.memoryRoot);
    try {
      for (const tool of ['mem-lesson-get', 'mem-lesson-list']) {
        const result = await handleToolCall(tool, { projectPath: f.projectPath, lessonId: f.lesson.lessonId });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ code: 'snapshot_unavailable', remediation: 'snapshot_runtime' });
        expect(JSON.stringify(result)).not.toContain(blockedTemp);
      }
      expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
    } finally {
      chmodSync(blockedTemp, 0o755);
    }
  });

  it('applies unregistered asset permissions to old stores without creating the asset table', async () => {
    const f = await fixture();
    await f.store.close();
    const legacyDb = new Database(f.dbPath);
    legacyDb.exec('DROP TABLE memory_assets');
    legacyDb.close();
    const before = snapshotMemoryRoot(f.memoryRoot);
    for (const mode of ['registered', 'strict'] as const) {
      vi.stubEnv('CLAUDE_MEMORY_ASSET_PERMISSION_MODE', mode);
      const found = mode === 'registered';
      expect(await read(f.projectPath, { lessonId: f.lesson.lessonId, requesterActorId: 'reader' })).toMatchObject({ found });
      const result = await handleToolCall('mem-lesson-list', { projectPath: f.projectPath, requesterActorId: 'reader' });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(JSON.parse(String(result.content[0]?.text))).toMatchObject({ count: found ? 1 : 0 });
      for (const tool of ['mem-lesson-get', 'mem-lesson-list']) {
        expect((await handleToolCall(tool, { projectPath: f.projectPath, lessonId: f.lesson.lessonId })).isError).toBe(true);
      }
    }
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
  });

  it('reads stores that predate optional lesson columns and rejects missing required ones', async () => {
    const f = await fixture();
    await f.store.close();
    const legacyDb = new Database(f.dbPath);
    for (const column of ['revision', 'recall_enabled', 'scope', 'validation_json', 'reconsider_when', 'valid_versions_json', 'source_class']) {
      try { legacyDb.exec(`ALTER TABLE memory_lessons DROP COLUMN ${column}`); } catch { /* column absent in this schema */ }
    }
    legacyDb.close();
    const before = snapshotMemoryRoot(f.memoryRoot);
    expect(await read(f.projectPath, { lessonId: f.lesson.lessonId })).toMatchObject({
      found: true, lesson: { lessonId: f.lesson.lessonId, steps: f.lesson.steps }
    });
    const listed = await handleToolCall('mem-lesson-list', { projectPath: f.projectPath });
    expect(listed.isError, JSON.stringify(listed)).not.toBe(true);
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);

    const brokenDb = new Database(f.dbPath);
    brokenDb.exec('ALTER TABLE memory_lessons DROP COLUMN steps_json');
    brokenDb.close();
    const beforeBroken = snapshotMemoryRoot(f.memoryRoot);
    for (const tool of ['mem-lesson-get', 'mem-lesson-list']) {
      const result = await handleToolCall(tool, { projectPath: f.projectPath, lessonId: f.lesson.lessonId });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: 'schema_incompatible', storeStatus: 'invalid' });
    }
    expect(diffMemoryRootSnapshots(beforeBroken, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
  });
});
