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

  const lightweightService = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    searchDisclosure: vi.fn(),
    expandDisclosure: vi.fn(),
    sourceDisclosure: vi.fn()
  };

  return {
    service,
    lightweightService,
    getServiceFromQuery: vi.fn(() => service),
    getLightweightServiceFromQuery: vi.fn(() => lightweightService)
  };
});

vi.mock('../../src/apps/server/api/utils.js', () => ({
  getServiceFromQuery: mocks.getServiceFromQuery,
  getLightweightServiceFromQuery: mocks.getLightweightServiceFromQuery
}));

const { searchRouter } = await import('../../src/server/api/search.js');

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
    mocks.lightweightService.initialize.mockReset().mockResolvedValue(undefined);
    mocks.lightweightService.shutdown.mockReset().mockResolvedValue(undefined);
    mocks.lightweightService.searchDisclosure.mockReset();
    mocks.lightweightService.expandDisclosure.mockReset();
    mocks.lightweightService.sourceDisclosure.mockReset();
    mocks.getServiceFromQuery.mockClear();
    mocks.getLightweightServiceFromQuery.mockClear();
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


  it('POST /api/search/disclosure uses lightweight service for explicit fast search', async () => {
    const responseBody = {
      results: [{ id: 'event:e1', resultType: 'source', snippet: 'checkout fix', score: 0.91, reasons: ['keyword_match'], sourceRef: 'event:e1' }],
      meta: { total: 1, usedVector: false, usedKeyword: true, fallbackApplied: false }
    };
    mocks.lightweightService.searchDisclosure.mockResolvedValue(responseBody);

    const res = await createApp().request('/api/search/disclosure?project=abc12345', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'checkout fix', options: { topK: 3, strategy: 'fast', includeShared: true } })
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(responseBody);
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.lightweightService.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.lightweightService.searchDisclosure).toHaveBeenCalledWith('checkout fix', { topK: 3, strategy: 'fast', includeShared: true });
    expect(mocks.lightweightService.shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.service.initialize).not.toHaveBeenCalled();
    expect(mocks.service.searchDisclosure).not.toHaveBeenCalled();
  });

  it('POST /api/search/disclosure falls back to lightweight fast search when the embedding backend is unavailable', async () => {
    const fallbackBody = {
      results: [{ id: 'event:e1', resultType: 'source', snippet: 'dashboard legacy stats', score: 0.75, reasons: ['keyword_match'], sourceRef: 'event:e1' }],
      meta: { total: 1, usedVector: false, usedKeyword: true, fallbackApplied: false, fallbackTrace: ['stage:primary:fast'] }
    };
    mocks.service.initialize.mockRejectedValue(new Error('Unable to get model file path or buffer.'));
    mocks.lightweightService.searchDisclosure.mockResolvedValue(fallbackBody);

    const res = await createApp().request('/api/search/disclosure?project=abc12345', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'dashboard legacy stats', options: { topK: 3, strategy: 'auto', includeShared: true } })
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...fallbackBody,
      meta: {
        ...fallbackBody.meta,
        fallbackApplied: true,
        fallbackTrace: ['stage:primary:fast', 'fallback:embedding-backend-unavailable:fast']
      }
    });
    expect(mocks.getServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.service.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.service.searchDisclosure).not.toHaveBeenCalled();
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.lightweightService.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.lightweightService.searchDisclosure).toHaveBeenCalledWith('dashboard legacy stats', {
      topK: 3,
      strategy: 'fast',
      includeShared: true
    });
    expect(mocks.lightweightService.shutdown).toHaveBeenCalledTimes(1);
  });

  it('POST /api/search/disclosure falls back when the full search query hits an embedding backend error', async () => {
    const fallbackBody = {
      results: [{ id: 'event:e2', resultType: 'source', snippet: 'dashboard search fallback', score: 0.71, reasons: ['keyword_match'], sourceRef: 'event:e2' }],
      meta: { total: 1, usedVector: false, usedKeyword: true, fallbackApplied: false }
    };
    mocks.service.searchDisclosure.mockRejectedValue(new Error('onnxruntime failed while querying vectors'));
    mocks.lightweightService.searchDisclosure.mockResolvedValue(fallbackBody);

    const res = await createApp().request('/api/search/disclosure?project=abc12345', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'dashboard search fallback', options: { topK: 4, strategy: 'auto' } })
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...fallbackBody,
      meta: {
        ...fallbackBody.meta,
        fallbackApplied: true,
        fallbackTrace: ['fallback:embedding-backend-unavailable:fast']
      }
    });
    expect(mocks.service.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.service.searchDisclosure).toHaveBeenCalledTimes(1);
    expect(mocks.service.shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.lightweightService.searchDisclosure).toHaveBeenCalledWith('dashboard search fallback', {
      topK: 4,
      strategy: 'fast'
    });
  });

  it('POST /api/search/disclosure rejects missing query', async () => {
    const res = await createApp().request('/api/search/disclosure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: { topK: 3 } })
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Query is required' });
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.getLightweightServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.service.searchDisclosure).not.toHaveBeenCalled();
    expect(mocks.service.shutdown).not.toHaveBeenCalled();
  });

  it('GET /api/search/disclosure/:resultId/expand expands a disclosure result', async () => {
    const responseBody = {
      target: { id: 'event:e1', resultType: 'source', snippet: 'checkout fix', score: 1, reasons: ['continuity_link'] },
      surroundingFacts: [],
      relatedSources: [{ sourceRef: 'event:e1', sourceType: 'raw_event', eventIds: ['e1'] }]
    };
    mocks.lightweightService.expandDisclosure.mockResolvedValue(responseBody);

    const res = await createApp().request('/api/search/disclosure/event:e1/expand?windowSize=2');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(responseBody);
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.lightweightService.initialize).not.toHaveBeenCalled();
    expect(mocks.lightweightService.expandDisclosure).toHaveBeenCalledWith('event:e1', { windowSize: 2 });
    expect(mocks.lightweightService.shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.service.expandDisclosure).not.toHaveBeenCalled();
  });

  it('GET /api/search/disclosure/:resultId/source resolves a disclosure result source', async () => {
    const responseBody = {
      sourceRef: 'event:e1',
      sourceType: 'raw_event',
      eventIds: ['e1'],
      rawEvents: [{ id: 'e1', content: 'checkout fix' }]
    };
    mocks.lightweightService.sourceDisclosure.mockResolvedValue(responseBody);

    const res = await createApp().request('/api/search/disclosure/event:e1/source');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(responseBody);
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.lightweightService.initialize).not.toHaveBeenCalled();
    expect(mocks.lightweightService.sourceDisclosure).toHaveBeenCalledWith('event:e1');
    expect(mocks.lightweightService.shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.service.sourceDisclosure).not.toHaveBeenCalled();
  });

  it('GET /api/search/disclosure/:resultId/source returns 404 when source is missing', async () => {
    mocks.lightweightService.sourceDisclosure.mockResolvedValue(null);

    const res = await createApp().request('/api/search/disclosure/event:missing/source');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Source not found' });
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.lightweightService.initialize).not.toHaveBeenCalled();
    expect(mocks.lightweightService.shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.service.sourceDisclosure).not.toHaveBeenCalled();
  });
});
