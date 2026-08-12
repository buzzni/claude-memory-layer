import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { statsRouter } from '../../src/apps/server/api/stats.js';
import { healthRouter } from '../../src/apps/server/api/health.js';
import { eventsRouter } from '../../src/apps/server/api/events.js';
import { projectsRouter } from '../../src/apps/server/api/projects.js';
import { diffMemoryRootSnapshots, snapshotMemoryRoot } from '../helpers/memory-root-snapshot.js';

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function createApp() {
  const app = new Hono();
  app.route('/api/stats', statsRouter);
  app.route('/api/health', healthRouter);
  app.route('/api/events', eventsRouter);
  app.route('/api/projects', projectsRouter);
  return app;
}

describe('dashboard diagnostic filesystem invariance', () => {
  it('returns structured empty reads without creating a missing project store', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-read-api-missing-'));
    const homeDir = path.join(root, 'home');
    mkdirSync(homeDir);
    process.env.HOME = homeDir;
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const before = snapshotMemoryRoot(memoryRoot);
    const projectPath = encodeURIComponent(path.join(root, 'missing-project'));
    const app = createApp();

    const stats = await app.request(`/api/stats?project=${projectPath}`);
    const health = await app.request(`/api/health?project=${projectPath}`);
    const events = await app.request(`/api/events?project=${projectPath}`);
    const detail = await app.request('/api/projects/abc12345/detail');

    expect(stats.status).toBe(200);
    expect(await stats.json()).toMatchObject({ store: { status: 'missing' }, storage: { eventCount: 0, vectorCount: 0 } });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ storage: { status: 'missing', totalEvents: 0, vectorCount: 0 } });
    expect(events.status).toBe(200);
    expect(await events.json()).toMatchObject({ events: [], total: 0 });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ storage: { status: 'missing', eventCount: 0, vectorCount: 0 } });
    expect(diffMemoryRootSnapshots(before, snapshotMemoryRoot(memoryRoot))).toEqual([]);
  });
});
