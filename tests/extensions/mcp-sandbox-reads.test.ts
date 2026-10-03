import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Embedder } from '../../src/core/embedder.js';
import { generateCitationId } from '../../src/core/citation-generator.js';
import { VectorStore } from '../../src/core/vector-store.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { LessonRepository } from '../../src/core/operations/lesson-repository.js';
import { ActorRepository } from '../../src/core/operations/actor-repository.js';
import { ActorCardRepository } from '../../src/core/operations/actor-card-repository.js';
import { getProjectStoragePath, hashProjectPath } from '../../src/core/registry/project-path.js';
import { MemoryService } from '../../src/services/memory-service.js';
import { handleToolCall, shutdownMcpMemoryServices } from '../../src/extensions/mcp/handlers.js';
import { isReadOnlyMcpRuntime } from '../../src/extensions/mcp/read-only-runtime.js';
import { diffMemoryRootSnapshots, snapshotMemoryRoot } from '../helpers/memory-root-snapshot.js';

const mocked = vi.hoisted(() => ({ homedir: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => mocked.homedir || actual.homedir() };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocked.homedir || actual.homedir() };
});

const roots: string[] = [];
const stores: SQLiteEventStore[] = [];
beforeEach(() => {
  vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', '');
  vi.stubEnv('CLAUDE_MEMORY_MCP_READ_ONLY', '');
  vi.stubEnv('CLAUDE_MEMORY_ASSET_PERMISSION_MODE', 'legacy');
  vi.spyOn(Embedder.prototype, 'initialize').mockRejectedValue(new Error('Model initialization must not run in a sandbox read'));
  vi.spyOn(VectorStore.prototype, 'initialize').mockRejectedValue(new Error('Vector initialization must not run in a sandbox read'));
  vi.spyOn(MemoryService.prototype, 'recordReferenceNavigation').mockRejectedValue(new Error('Navigation must not run in a sandbox read'));
});
afterEach(async () => {
  await shutdownMcpMemoryServices();
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mocked.homedir = '';
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cml-mcp-sandbox-'));
  roots.push(root);
  const home = join(root, 'home');
  const snapshots = join(root, 'snapshots');
  mkdirSync(home);
  mkdirSync(snapshots);
  mocked.homedir = home;
  for (const env of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(env, snapshots);
  const projectPath = join(root, 'project');
  mkdirSync(projectPath);
  const projectHash = hashProjectPath(projectPath);
  const dbPath = join(getProjectStoragePath(projectPath), 'events.sqlite');
  const store = new SQLiteEventStore(dbPath);
  stores.push(store);
  await store.initialize();
  const first = await store.append({
    eventType: 'user_prompt', sessionId: 'fixture-session', timestamp: new Date(),
    content: 'Sandbox recall navigation should preserve project memory and return source references.',
    metadata: { scope: { project: { hash: projectHash } } }
  });
  const second = await store.append({
    eventType: 'agent_response', sessionId: 'fixture-session', timestamp: new Date(Date.now() + 1),
    content: 'Sandbox recall neighbor verification succeeded. api_key=neighbor-sensitive-fixture',
    metadata: { scope: { project: { hash: projectHash } } }
  });
  expect(first.success).toBe(true);
  expect(second.success).toBe(true);
  const lesson = await new LessonRepository(store.getDatabase()).upsert({
    projectHash, name: 'Verify sandbox memory reads', trigger: 'Sandbox recall navigation',
    steps: ['Open the returned source reference'], sourceEventIds: [first.eventId!], sourceClass: 'curated'
  });
  return { root, snapshots, projectPath, projectHash, dbPath, store, firstId: first.eventId!, secondId: second.eventId!, lesson, memoryRoot: join(home, '.claude-code', 'memory') };
}

function textOf(result: Awaited<ReturnType<typeof handleToolCall>>) {
  return result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

async function expectReadable(name: string, args: Record<string, unknown>) {
  const result = await handleToolCall(name, args);
  expect(result.isError, textOf(result)).not.toBe(true);
  return textOf(result);
}

function expectModelFree() {
  expect(Embedder.prototype.initialize).not.toHaveBeenCalled();
  expect(VectorStore.prototype.initialize).not.toHaveBeenCalled();
  expect(MemoryService.prototype.recordReferenceNavigation).not.toHaveBeenCalled();
}

describe('sandboxed direct MCP reads', () => {
  it('keeps ordinary and host-worker runtimes unrestricted', () => {
    expect(isReadOnlyMcpRuntime({})).toBe(false);
    expect(isReadOnlyMcpRuntime({ CLAUDE_MEMORY_RECALL_OWNER: 'host-worker' })).toBe(false);
    expect(isReadOnlyMcpRuntime({ CLAUDE_MEMORY_MCP_READ_ONLY: '0' })).toBe(false);
    expect(isReadOnlyMcpRuntime({ CLAUDE_MEMORY_RECALL_OWNER: 'host' })).toBe(true);
    expect(isReadOnlyMcpRuntime({ CLAUDE_MEMORY_MCP_READ_ONLY: '1' })).toBe(true);
  });

  it.each(['host-owner', 'explicit-read-only'])('reads a closed canonical store without writes or model initialization (%s)', async (mode) => {
    const f = await fixture();
    if (mode === 'host-owner') vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', 'host');
    else vi.stubEnv('CLAUDE_MEMORY_MCP_READ_ONLY', '1');
    await f.store.close();
    const directory = getProjectStoragePath(f.projectPath);
    chmodSync(f.dbPath, 0o444);
    chmodSync(directory, 0o555);
    const before = snapshotMemoryRoot(f.memoryRoot);
    try {
      for (const [name, args, expected] of [
        ['mem-context-pack', { query: 'Sandbox recall navigation' }, 'Project Context Pack'],
        ['mem-search', { query: 'Sandbox recall navigation' }, generateCitationId(f.firstId)],
        ['mem-details', { ids: [f.firstId] }, 'Sandbox recall navigation should preserve'],
        ['mem-source-ref', { ids: [f.firstId], includeNeighbors: true }, 'neighbor verification succeeded'],
        ['mem-timeline', { ids: [f.firstId] }, 'Timeline Context'],
        ['mem-project-timeline', {}, 'Project Memory Timeline'],
        ['mem-stats', {}, 'Total Events'],
        ['mem-lesson-get', { lessonId: f.lesson.lessonId }, f.lesson.name],
        ['mem-lesson-list', {}, f.lesson.name]
      ] as const) {
        const output = await expectReadable(name, { projectPath: f.projectPath, ...args });
        expect(output).toContain(expected);
        expect(output).not.toContain('neighbor-sensitive-fixture');
      }
      expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
      expectModelFree();
      expect(readdirSync(f.snapshots)).toEqual([]);
    } finally {
      chmodSync(directory, 0o755);
      chmodSync(f.dbPath, 0o644);
    }
  });

  it('reads committed WAL rows and closes every temporary snapshot without touching the live store', async () => {
    const f = await fixture();
    vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', 'host');
    expect(existsSync(`${f.dbPath}-wal`)).toBe(true);
    const before = snapshotMemoryRoot(f.memoryRoot);
    const output = await expectReadable('mem-source-ref', { projectPath: f.projectPath, ids: [f.secondId], includeNeighbors: true });
    expect(output).toContain('neighbor verification succeeded');
    expect(output).not.toContain('neighbor-sensitive-fixture');
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
    expectModelFree();
    expect(readdirSync(f.snapshots)).toEqual([]);
  });

  it('disables implicit freshness imports for generic continuation queries', async () => {
    const f = await fixture();
    await f.store.close();
    vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', 'host');
    const before = snapshotMemoryRoot(f.memoryRoot);
    const output = await expectReadable('mem-context-pack', { projectPath: f.projectPath, query: 'continue', sessionsDir: join(f.root, 'must-not-import') });
    expect(output).not.toContain('Freshness refresh:');
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
    expectModelFree();
    expect(readdirSync(f.snapshots)).toEqual([]);
  });

  it('keeps refreshLatest:false model-free outside constrained runtimes, including hybrid lesson experiments', async () => {
    const f = await fixture();
    await f.store.close();
    vi.stubEnv('CLAUDE_MEMORY_LESSON_HYBRID_EXPERIMENT', 'true');
    const before = snapshotMemoryRoot(f.memoryRoot);
    await expectReadable('mem-context-pack', { projectPath: f.projectPath, query: 'Unrelated topic which must not warm semantic lessons', refreshLatest: false });
    expectModelFree();
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
    expect(readdirSync(f.snapshots)).toEqual([]);
  });

  it('reads optional perspective context from a snapshot rather than migrating canonical storage', async () => {
    const f = await fixture();
    const actors = new ActorRepository(f.store.getDatabase());
    for (const actorId of ['fixture-observer', 'fixture-target']) {
      await actors.upsert({ actorId, projectHash: f.projectHash, displayName: actorId, source: 'fixture' });
    }
    await new ActorCardRepository(f.store.getDatabase()).upsert({
      projectHash: f.projectHash, observerActorId: 'fixture-observer', observedActorId: 'fixture-target',
      entries: ['ATTRIBUTE: Prefers verifiable source references'], sourceEventIds: [f.firstId]
    });
    await f.store.close();
    vi.stubEnv('CLAUDE_MEMORY_MCP_READ_ONLY', '1');
    const directory = getProjectStoragePath(f.projectPath);
    chmodSync(f.dbPath, 0o444);
    chmodSync(directory, 0o555);
    const before = snapshotMemoryRoot(f.memoryRoot);
    try {
      const output = await expectReadable('mem-context-pack', {
        projectPath: f.projectPath, query: 'Sandbox recall navigation',
        observerActorId: 'fixture-observer', targetActorId: 'fixture-target'
      });
      expect(output).toContain('Prefers verifiable source references');
      expect(output).not.toContain('perspective context unavailable');
      expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
      expectModelFree();
      expect(readdirSync(f.snapshots)).toEqual([]);
    } finally {
      chmodSync(directory, 0o755);
      chmodSync(f.dbPath, 0o644);
    }
  });

  it.each([
    ['mem-context-pack', { refreshLatest: true }],
    ['mem-import-latest', {}],
    ['mem-lesson-save', {}],
    ['mem-facet-query', {}]
  ])('rejects unsupported constrained operation %s before creating a store', async (name, args) => {
    const f = await fixture();
    await f.store.close();
    vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', 'host');
    const before = snapshotMemoryRoot(f.memoryRoot);
    const result = await handleToolCall(name, { projectPath: join(f.root, 'unknown-project'), ...args });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'read_only_runtime' });
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
    expectModelFree();
  });

  it('never creates an empty store for a missing project', async () => {
    const f = await fixture();
    await f.store.close();
    vi.stubEnv('CLAUDE_MEMORY_MCP_READ_ONLY', '1');
    const before = snapshotMemoryRoot(f.memoryRoot);
    for (const name of ['mem-context-pack', 'mem-source-ref', 'mem-details']) {
      const result = await handleToolCall(name, { projectPath: join(f.root, 'missing-project'), ids: [f.firstId] });
      expect(result.isError, textOf(result)).not.toBe(true);
      expect(textOf(result)).not.toContain('Sandbox recall navigation should preserve');
      expect(textOf(result)).not.toContain('neighbor verification succeeded');
    }
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
    expect(readdirSync(f.snapshots)).toEqual([]);
    expectModelFree();
  });

  it('rejects snapshots inside canonical memory storage without modifying it', async () => {
    const f = await fixture();
    await f.store.close();
    vi.stubEnv('CLAUDE_MEMORY_RECALL_OWNER', 'host');
    const unsafeTmp = join(f.memoryRoot, 'unsafe-snapshots');
    mkdirSync(unsafeTmp);
    for (const env of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(env, unsafeTmp);
    const before = snapshotMemoryRoot(f.memoryRoot);
    const result = await handleToolCall('mem-details', { projectPath: f.projectPath, ids: [f.firstId] });
    expect(result.isError).toBe(true);
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
    expectModelFree();
  });

  it('reports unavailable temporary storage without exposing paths or modifying canonical files', async () => {
    const f = await fixture();
    await f.store.close();
    vi.stubEnv('CLAUDE_MEMORY_MCP_READ_ONLY', '1');
    const unavailableTmp = join(f.root, 'missing-snapshot-directory');
    for (const env of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(env, unavailableTmp);
    const before = snapshotMemoryRoot(f.memoryRoot);
    const result = await handleToolCall('mem-source-ref', { projectPath: f.projectPath, ids: [f.firstId] });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(unavailableTmp);
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(f.memoryRoot))).toEqual([]);
    expectModelFree();
    expect(existsSync(unavailableTmp)).toBe(false);
  });
});
