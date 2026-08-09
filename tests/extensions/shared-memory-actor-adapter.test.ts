import { describe, expect, it } from 'vitest';

import { createSharedEventStore } from '../../src/core/shared-event-store.js';
import { createSharedStore } from '../../src/core/shared-store.js';
import { SharedMemoryActorAdapter } from '../../src/extensions/shared-memory/shared-memory-actor-adapter.js';

async function createFixture() {
  const eventStore = createSharedEventStore(':memory:');
  await eventStore.initialize();
  const store = createSharedStore(eventStore);
  const adapter = new SharedMemoryActorAdapter(store);
  return { eventStore, store, adapter };
}

async function promote(store: ReturnType<typeof createSharedStore>, projectHash: string, sourceEntryId: string, title: string) {
  await store.promoteEntry({
    sourceProjectHash: projectHash,
    sourceEntryId,
    title,
    symptoms: ['timeout'],
    rootCause: 'stale cache',
    solution: 'clear cache',
    topics: ['cache'],
    confidence: 0.9
  });
}

describe('SharedMemoryActorAdapter', () => {
  it('returns only entries from explicitly linked projects', async () => {
    const { eventStore, store, adapter } = await createFixture();
    try {
      await promote(store, 'project-a', 'entry-a', 'Project A timeout');
      await promote(store, 'project-b', 'entry-b', 'Project B timeout');
      await promote(store, 'project-c', 'entry-c', 'Project C timeout');

      await adapter.link({ projectHash: 'project-a', actorId: 'alice', sharedPrincipalId: 'principal-alice' });
      await adapter.link({ projectHash: 'project-b', actorId: 'alice', sharedPrincipalId: 'principal-alice' });

      const result = await adapter.search({
        projectHash: 'project-a', actorId: 'alice', query: 'timeout', topK: 10
      });

      expect(result.identity).toMatchObject({
        projectHash: 'project-a', actorId: 'alice', sharedPrincipalId: 'principal-alice'
      });
      expect(result.sourceProjectHashes).toEqual(['project-a', 'project-b']);
      expect(result.entries.map((entry) => entry.sourceProjectHash)).toEqual(['project-a', 'project-b']);
    } finally {
      await eventStore.close();
    }
  });

  it('fails closed when the requester has no explicit identity link', async () => {
    const { eventStore, store, adapter } = await createFixture();
    try {
      await promote(store, 'project-a', 'entry-a', 'Project A timeout');
      await adapter.link({ projectHash: 'project-a', actorId: 'alice', sharedPrincipalId: 'principal-alice' });

      await expect(adapter.search({
        projectHash: 'project-a', actorId: 'unlinked', query: 'timeout'
      })).resolves.toEqual({ identity: null, sourceProjectHashes: [], entries: [] });
    } finally {
      await eventStore.close();
    }
  });

  it('requires the explicitly named source actor to share the requester principal', async () => {
    const { eventStore, adapter } = await createFixture();
    try {
      await adapter.link({ projectHash: 'project-a', actorId: 'alice', sharedPrincipalId: 'principal-alice' });
      await adapter.link({ projectHash: 'project-b', actorId: 'alice-source', sharedPrincipalId: 'principal-alice' });
      await adapter.link({ projectHash: 'project-b', actorId: 'bob-source', sharedPrincipalId: 'principal-bob' });

      await expect(adapter.sharesPrincipalWith({
        projectHash: 'project-a', actorId: 'alice', sourceProjectHash: 'project-b', sourceActorId: 'alice-source'
      })).resolves.toBe(true);
      await expect(adapter.sharesPrincipalWith({
        projectHash: 'project-a', actorId: 'alice', sourceProjectHash: 'project-b', sourceActorId: 'bob-source'
      })).resolves.toBe(false);
    } finally {
      await eventStore.close();
    }
  });

  it('revokes a prior principal on relink or unlink', async () => {
    const { eventStore, store, adapter } = await createFixture();
    try {
      await promote(store, 'project-a', 'entry-a', 'Project A timeout');
      await adapter.link({ projectHash: 'project-a', actorId: 'alice', sharedPrincipalId: 'principal-old' });
      await adapter.link({ projectHash: 'project-b', actorId: 'alice', sharedPrincipalId: 'principal-old' });
      await adapter.link({ projectHash: 'project-a', actorId: 'alice', sharedPrincipalId: 'principal-new' });

      expect(await store.listProjectHashesForPrincipal('principal-old')).toEqual(['project-b']);
      expect(await store.listProjectHashesForPrincipal('principal-new')).toEqual(['project-a']);
      await expect(adapter.unlink({ projectHash: 'project-a', actorId: 'alice' })).resolves.toBe(true);
      await expect(adapter.unlink({ projectHash: 'project-a', actorId: 'alice' })).resolves.toBe(false);
      await expect(adapter.status({ projectHash: 'project-a', actorId: 'alice' })).resolves.toBeNull();
    } finally {
      await eventStore.close();
    }
  });
});
