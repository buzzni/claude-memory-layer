import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { Hono } from 'hono';

import { createSharedEventStore } from '../../../core/shared-event-store.js';
import { createSharedStore } from '../../../core/shared-store.js';
import { resolveSharedMemoryStoragePath } from '../../../services/memory-service-config.js';
import { SharedMemoryActorAdapter } from '../../../extensions/shared-memory/shared-memory-actor-adapter.js';
import { jsonError } from './utils.js';

export const sharedMemoryRouter = new Hono();

function requiredQuery(c: { req: { query(name: string): string | undefined } }, name: string): string {
  const value = c.req.query(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function withSharedMemoryActorAdapter<T>(
  callback: (adapter: SharedMemoryActorAdapter) => Promise<T>
): Promise<T | null> {
  const dbPath = path.join(resolveSharedMemoryStoragePath(), 'shared.duckdb');
  // Status/unlink must not create a global shared store merely because the
  // dashboard was opened.
  if (!existsSync(dbPath)) return null;
  const eventStore = createSharedEventStore(dbPath);
  await eventStore.initialize();
  try {
    return await callback(new SharedMemoryActorAdapter(createSharedStore(eventStore)));
  } finally {
    await eventStore.close();
  }
}

// GET /api/shared/actor?project=<hash>&actorId=<id>
sharedMemoryRouter.get('/actor', async (c) => {
  try {
    const projectHash = requiredQuery(c, 'project');
    const actorId = requiredQuery(c, 'actorId');
    const scope = await withSharedMemoryActorAdapter((adapter) => adapter.scope({ projectHash, actorId }));
    return c.json({
      projectHash,
      linked: Boolean(scope?.identity),
      linkedProjectCount: scope?.linkedProjectCount ?? 0
    });
  } catch (error) {
    return jsonError(c, error, { status: 400, message: 'Shared actor status unavailable' });
  }
});

// DELETE /api/shared/actor?project=<hash>&actorId=<id>
sharedMemoryRouter.delete('/actor', async (c) => {
  try {
    const projectHash = requiredQuery(c, 'project');
    const actorId = requiredQuery(c, 'actorId');
    const unlinked = await withSharedMemoryActorAdapter((adapter) => adapter.unlink({ projectHash, actorId }));
    return c.json({ projectHash, unlinked: unlinked === true });
  } catch (error) {
    return jsonError(c, error, { status: 400, message: 'Shared actor unlink unavailable' });
  }
});
