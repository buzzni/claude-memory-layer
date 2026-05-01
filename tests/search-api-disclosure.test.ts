import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => {
  const service = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    retrieveMemories: vi.fn(),
    searchDisclosure: vi.fn(),
    expandDisclosure: vi.fn(),
    sourceDisclosure: vi.fn()
  };

  return {
    service,
    getServiceFromQuery: vi.fn(() => service)
  };
});

vi.mock('../src/server/api/utils.js', () => ({
  getServiceFromQuery: mocks.getServiceFromQuery
}));

const { searchRouter } = await import('../src/server/api/search.js');

function createApp() {
  const app = new Hono();
  app.route('/api/search', searchRouter);
  return app;
}

describe('search disclosure API', () => {
  beforeEach(() => {
    mocks.service.initialize.mockReset().mockResolvedValue(undefined);
    mocks.service.shutdown.mockReset().mockResolvedValue(undefined);
    mocks.service.retrieveMemories.mockReset();
    mocks.service.searchDisclosure.mockReset();
    mocks.service.expandDisclosure.mockReset();
    mocks.service.sourceDisclosure.mockReset();
    mocks.getServiceFromQuery.mockClear();
  });

  it('POST /api/search/disclosure delegates to MemoryService.searchDisclosure', async () => {
    const responseBody = {
      results: [{ id: 'event:e1', resultType: 'source', snippet: 'checkout fix', score: 0.91, reasons: ['semantic_match'], sourceRef: 'event:e1' }],
      meta: { total: 1, usedVector: true, usedKeyword: true, fallbackApplied: false }
    };
    mocks.service.searchDisclosure.mockResolvedValue(responseBody);

    const res = await createApp().request('/api/search/disclosure?project=abc12345', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'checkout fix', options: { topK: 3, includeShared: true } })
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(responseBody);
    expect(mocks.getServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.service.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.service.searchDisclosure).toHaveBeenCalledWith('checkout fix', { topK: 3, includeShared: true });
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });

  it('POST /api/search/disclosure rejects missing query', async () => {
    const res = await createApp().request('/api/search/disclosure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: { topK: 3 } })
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Query is required' });
    expect(mocks.service.searchDisclosure).not.toHaveBeenCalled();
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });

  it('GET /api/search/disclosure/:resultId/expand expands a disclosure result', async () => {
    const responseBody = {
      target: { id: 'event:e1', resultType: 'source', snippet: 'checkout fix', score: 1, reasons: ['continuity_link'] },
      surroundingFacts: [],
      relatedSources: [{ sourceRef: 'event:e1', sourceType: 'raw_event', eventIds: ['e1'] }]
    };
    mocks.service.expandDisclosure.mockResolvedValue(responseBody);

    const res = await createApp().request('/api/search/disclosure/event:e1/expand?windowSize=2');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(responseBody);
    expect(mocks.service.initialize).not.toHaveBeenCalled();
    expect(mocks.service.expandDisclosure).toHaveBeenCalledWith('event:e1', { windowSize: 2 });
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });

  it('GET /api/search/disclosure/:resultId/source resolves a disclosure result source', async () => {
    const responseBody = {
      sourceRef: 'event:e1',
      sourceType: 'raw_event',
      eventIds: ['e1'],
      rawEvents: [{ id: 'e1', content: 'checkout fix' }]
    };
    mocks.service.sourceDisclosure.mockResolvedValue(responseBody);

    const res = await createApp().request('/api/search/disclosure/event:e1/source');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(responseBody);
    expect(mocks.service.initialize).not.toHaveBeenCalled();
    expect(mocks.service.sourceDisclosure).toHaveBeenCalledWith('event:e1');
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });

  it('GET /api/search/disclosure/:resultId/source returns 404 when source is missing', async () => {
    mocks.service.sourceDisclosure.mockResolvedValue(null);

    const res = await createApp().request('/api/search/disclosure/event:missing/source');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Source not found' });
    expect(mocks.service.initialize).not.toHaveBeenCalled();
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
  });
});
