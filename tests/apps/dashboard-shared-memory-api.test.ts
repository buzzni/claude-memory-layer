import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';

import { createSharedEventStore } from '../../src/core/shared-event-store.js';
import { createSharedStore } from '../../src/core/shared-store.js';
import { SharedMemoryActorAdapter } from '../../src/extensions/shared-memory/shared-memory-actor-adapter.js';
import { sharedMemoryRouter } from '../../src/apps/server/api/shared-memory.js';
import { SHARED_MEMORY_STORAGE_PATH_ENV } from '../../src/services/memory-service-config.js';

const tempDirs: string[] = [];
const originalSharedPath = process.env[SHARED_MEMORY_STORAGE_PATH_ENV];

afterEach(() => {
  if (originalSharedPath === undefined) delete process.env[SHARED_MEMORY_STORAGE_PATH_ENV];
  else process.env[SHARED_MEMORY_STORAGE_PATH_ENV] = originalSharedPath;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createApp() {
  const app = new Hono();
  app.route('/api/shared', sharedMemoryRouter);
  return app;
}

describe('dashboard shared actor API', () => {
  it('returns aggregate mapping scope and unlinks without exposing the principal', async () => {
    const sharedPath = mkdtempSync(join(tmpdir(), 'cml-dashboard-shared-'));
    tempDirs.push(sharedPath);
    process.env[SHARED_MEMORY_STORAGE_PATH_ENV] = sharedPath;
    const eventStore = createSharedEventStore(join(sharedPath, 'shared.duckdb'));
    await eventStore.initialize();
    try {
      const adapter = new SharedMemoryActorAdapter(createSharedStore(eventStore));
      await adapter.link({ projectHash: 'abc12345', actorId: 'actor-a', sharedPrincipalId: 'principal-private' });
      await adapter.link({ projectHash: 'def67890', actorId: 'actor-b', sharedPrincipalId: 'principal-private' });
    } finally {
      await eventStore.close();
    }

    const app = createApp();
    const status = await app.request('/api/shared/actor?project=abc12345&actorId=actor-a');
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody).toEqual({ projectHash: 'abc12345', linked: true, linkedProjectCount: 2 });
    expect(JSON.stringify(statusBody)).not.toContain('principal-private');

    const unlinked = await app.request('/api/shared/actor?project=abc12345&actorId=actor-a', { method: 'DELETE' });
    expect(unlinked.status).toBe(200);
    expect(await unlinked.json()).toEqual({ projectHash: 'abc12345', unlinked: true });

    const after = await app.request('/api/shared/actor?project=abc12345&actorId=actor-a');
    expect(await after.json()).toEqual({ projectHash: 'abc12345', linked: false, linkedProjectCount: 0 });
  });

  it('does not create a shared store merely to report an unlinked actor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cml-dashboard-shared-empty-'));
    tempDirs.push(root);
    const sharedPath = join(root, 'shared');
    process.env[SHARED_MEMORY_STORAGE_PATH_ENV] = sharedPath;

    const response = await createApp().request('/api/shared/actor?project=abc12345&actorId=actor-a');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projectHash: 'abc12345', linked: false, linkedProjectCount: 0 });
  });
});
