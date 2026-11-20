import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';
import { ReadOnlyDiagnosticsService } from '../../src/services/read-only-diagnostics-service.js';

/**
 * GET /api/turns/:turnId over a real SQLite store, read the way the dashboard
 * reads it: a forked or re-imported Codex transcript keeps the host's native
 * turn id under a new session id (#207).
 */

const storagePath = mkdtempSync(path.join(tmpdir(), 'cml-turns-api-'));
const databasePath = path.join(storagePath, 'events.sqlite');

vi.mock('../../src/apps/server/api/utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/apps/server/api/utils.js')>()),
  getDiagnosticsServiceFromQuery: () => new ReadOnlyDiagnosticsService({
    status: 'existing',
    inputKind: 'project-hash',
    storagePath,
    databasePath
  })
}));

const { turnsRouter } = await import('../../src/apps/server/api/turns.js');
const app = new Hono().route('/api/turns', turnsRouter);

beforeAll(async () => {
  const store = new SQLiteEventStore(databasePath);
  await store.initialize();
  const append = (sessionId: string, eventType: 'user_prompt' | 'agent_response', minute: number, content: string) =>
    store.append({ eventType, sessionId, timestamp: new Date(Date.UTC(2026, 10, 1, 0, minute)), content, metadata: { turnId: 'shared' } });
  await append('session-a', 'user_prompt', 0, 'prompt in session a');
  await append('session-a', 'agent_response', 1, 'answer in session a');
  await append('session-b', 'user_prompt', 2, 'prompt in session b');
  await store.close();
});

afterAll(() => {
  rmSync(storagePath, { recursive: true, force: true });
});

describe('GET /api/turns/:turnId session scope', () => {
  it.each([
    ['session-a', 'prompt in session a', ['answer in session a']],
    ['session-b', 'prompt in session b', []]
  ])('returns only %s\'s events for a shared turn id', async (sessionId, prompt, responses) => {
    const res = await app.request(`/api/turns/shared?sessionId=${sessionId}`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sessionId).toBe(sessionId);
    expect(body.prompt.content).toBe(prompt);
    expect(body.responses.map((r: { content: string }) => r.content)).toEqual(responses);
    expect(body.totalEvents).toBe(1 + responses.length);
  });

  it('answers 404 for a session that does not hold the turn', async () => {
    const res = await app.request('/api/turns/shared?sessionId=session-c');

    expect(res.status).toBe(404);
  });

  it('answers 409 with the session ids when sessionId is omitted', async () => {
    const res = await app.request('/api/turns/shared');

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Turn id is shared by more than one session; pass sessionId',
      sessionIds: ['session-a', 'session-b']
    });
  });
});
