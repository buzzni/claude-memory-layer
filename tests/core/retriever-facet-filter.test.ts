import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { Matcher } from '../../src/core/matcher.js';
import { FacetRepository } from '../../src/core/operations/facet-repository.js';
import { Retriever } from '../../src/core/retriever.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import type { MemoryEvent } from '../../src/core/types.js';

const tempDirs: string[] = [];

const fakeEmbedder = {
  async embed() {
    return { vector: [0.1, 0.2, 0.3] };
  }
};

async function appendEvent(
  store: SQLiteEventStore,
  content: string,
  metadata: Record<string, unknown> = { scope: { project: { hash: 'project-1' } } }
): Promise<MemoryEvent> {
  const result = await store.append({
    eventType: 'agent_response',
    sessionId: 'session-1',
    timestamp: new Date('2026-05-19T00:00:00.000Z'),
    content,
    metadata
  });
  if (!result.success || !result.eventId) {
    throw new Error('append failed');
  }
  const event = await store.getEvent(result.eventId);
  if (!event) throw new Error(`missing appended event ${result.eventId}`);
  return event;
}

async function createFixture(): Promise<{
  store: SQLiteEventStore;
  repo: FacetRepository;
  debugEvent: MemoryEvent;
  releaseEvent: MemoryEvent;
  otherProjectEvent: MemoryEvent;
  retriever: Retriever;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'cml-retriever-facet-'));
  tempDirs.push(dir);
  const store = new SQLiteEventStore(join(dir, 'events.sqlite'));
  await store.initialize();
  const repo = new FacetRepository(store.getDatabase());

  const debugEvent = await appendEvent(store, 'deployment memory debugging workflow fix with shared terms');
  const releaseEvent = await appendEvent(store, 'deployment memory release workflow checklist with shared terms');
  const otherProjectEvent = await appendEvent(
    store,
    'deployment memory debugging workflow from another project with shared terms',
    { scope: { project: { hash: 'project-2' } } }
  );

  await repo.assign({
    targetType: 'event',
    targetId: debugEvent.id,
    dimension: 'workflow',
    value: 'debugging',
    projectHash: 'project-1'
  });
  await repo.assign({
    targetType: 'event',
    targetId: releaseEvent.id,
    dimension: 'workflow',
    value: 'release',
    projectHash: 'project-1'
  });
  await repo.assign({
    targetType: 'event',
    targetId: otherProjectEvent.id,
    dimension: 'workflow',
    value: 'debugging',
    projectHash: 'project-2'
  });

  const vectorStore = {
    async search() {
      return [debugEvent, releaseEvent, otherProjectEvent].map((event, index) => ({
        id: `v-${event.id}`,
        eventId: event.id,
        content: event.content,
        score: 0.96 - index * 0.01,
        sessionId: event.sessionId,
        eventType: event.eventType,
        timestamp: event.timestamp.toISOString()
      }));
    }
  };

  const retriever = new Retriever(store as any, vectorStore as any, fakeEmbedder as any, new Matcher());

  return {
    store,
    repo,
    debugEvent,
    releaseEvent,
    otherProjectEvent,
    retriever,
    cleanup: async () => {
      await store.close();
    }
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Retriever facet filters', () => {
  it('keeps retrieval unchanged when no facet filters are supplied', async () => {
    const { retriever, debugEvent, releaseEvent, cleanup } = await createFixture();

    const out = await retriever.retrieve('deployment memory workflow shared terms', {
      strategy: 'deep',
      topK: 5,
      minScore: 0.1,
      includeSessionContext: false,
      projectScopeMode: 'strict',
      projectHash: 'project-1'
    });
    await cleanup();

    expect(out.memories.map((memory) => memory.event.id)).toEqual([debugEvent.id, releaseEvent.id]);
    expect(out.selectedDebug?.some((detail) => detail.facetMatches?.length)).toBe(false);
  });

  it('strictly filters candidates to event facets in the requested project scope', async () => {
    const { retriever, debugEvent, releaseEvent, otherProjectEvent, cleanup } = await createFixture();

    const out = await retriever.retrieve('deployment memory workflow shared terms', {
      strategy: 'deep',
      topK: 5,
      minScore: 0.1,
      includeSessionContext: false,
      projectScopeMode: 'global',
      projectHash: 'project-1',
      facets: [{ dimension: 'workflow', value: 'debugging' }]
    });
    await cleanup();

    const ids = out.memories.map((memory) => memory.event.id);
    expect(ids).toEqual([debugEvent.id]);
    expect(ids).not.toContain(releaseEvent.id);
    expect(ids).not.toContain(otherProjectEvent.id);
    expect(out.selectedDebug?.[0]?.facetMatches).toEqual([{ dimension: 'workflow', value: 'debugging' }]);
  });

  it('fails closed when a candidate only has the requested facet in another project', async () => {
    const { retriever, cleanup } = await createFixture();

    const out = await retriever.retrieve('deployment memory workflow shared terms', {
      strategy: 'deep',
      topK: 5,
      minScore: 0.1,
      includeSessionContext: false,
      projectScopeMode: 'global',
      projectHash: 'project-missing',
      facets: [{ dimension: 'workflow', value: 'debugging' }]
    });
    await cleanup();

    expect(out.memories).toEqual([]);
    expect(out.candidateDebug).toEqual([]);
  });

  it('fails closed when facet filters are requested without a project hash', async () => {
    const { retriever, cleanup } = await createFixture();

    const out = await retriever.retrieve('deployment memory workflow shared terms', {
      strategy: 'deep',
      topK: 5,
      minScore: 0.1,
      includeSessionContext: false,
      projectScopeMode: 'global',
      facets: [{ dimension: 'workflow', value: 'debugging' }]
    });
    await cleanup();

    expect(out.memories).toEqual([]);
    expect(out.candidateDebug).toEqual([]);
  });
});
