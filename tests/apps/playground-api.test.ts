import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => {
  const service = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    searchDisclosure: vi.fn(),
    expandDisclosure: vi.fn(),
    sourceDisclosure: vi.fn(),
  };

  const lightweightService = {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    searchDisclosure: vi.fn(),
    expandDisclosure: vi.fn(),
    sourceDisclosure: vi.fn(),
  };

  return {
    service,
    lightweightService,
    getServiceFromQuery: vi.fn(() => service),
    getLightweightServiceFromQuery: vi.fn(() => lightweightService),
  };
});

vi.mock('../../src/apps/server/api/utils.js', () => ({
  getServiceFromQuery: mocks.getServiceFromQuery,
  getLightweightServiceFromQuery: mocks.getLightweightServiceFromQuery,
}));

const { playgroundRouter } = await import('../../src/apps/server/api/playground.js');

function createApp() {
  const app = new Hono();
  app.route('/api/playground', playgroundRouter);
  return app;
}

describe('playground dry-run replay API', () => {
  beforeEach(() => {
    mocks.service.initialize.mockReset().mockResolvedValue(undefined);
    mocks.service.shutdown.mockReset().mockResolvedValue(undefined);
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

  it('runs a fast dry-run replay without initializing the full vector service', async () => {
    mocks.lightweightService.searchDisclosure.mockResolvedValue({
      results: [
        { id: 'event:e1', resultType: 'source', snippet: 'playground search hit', score: 0.88, reasons: ['keyword_match'], sourceRef: 'event:e1' },
      ],
      meta: { total: 1, usedVector: false, usedKeyword: true },
    });
    mocks.lightweightService.expandDisclosure.mockResolvedValue({
      target: { id: 'event:e1' },
      surroundingFacts: [{ id: 'fact-1', snippet: 'expanded fact' }],
      relatedSources: [{ sourceRef: 'event:e1', eventIds: ['e1'] }],
    });
    mocks.lightweightService.sourceDisclosure.mockResolvedValue({
      sourceRef: 'event:e1',
      sourceType: 'raw_event',
      eventIds: ['e1'],
      rawEvents: [{ id: 'e1', sessionId: 's1', content: 'playground source' }],
    });

    const res = await createApp().request('/api/playground/dry-run?project=abc12345', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'playground search hit', options: { strategy: 'fast', topK: 3, includeShared: false, windowSize: 2 } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      dryRun: true,
      mutated: false,
      query: 'playground search hit',
      replayTrace: ['search', 'expand:event:e1', 'source:event:e1'],
      selectedResultId: 'event:e1',
      search: { meta: { total: 1, usedVector: false, usedKeyword: true } },
      expansion: { target: { id: 'event:e1' } },
      source: { sourceRef: 'event:e1', sourceType: 'raw_event' },
    });
    expect(body.source.rawEvents[0]).toMatchObject({
      id: 'e1',
      sessionId: 's1',
      preview: 'playground source',
      contentLength: 17,
    });
    expect(body.source.rawEvents[0]).not.toHaveProperty('content');
    expect(mocks.getLightweightServiceFromQuery).toHaveBeenCalledTimes(1);
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.lightweightService.initialize).toHaveBeenCalledTimes(1);
    expect(mocks.lightweightService.searchDisclosure).toHaveBeenCalledWith('playground search hit', {
      strategy: 'fast',
      topK: 3,
      includeShared: false,
    });
    expect(mocks.lightweightService.expandDisclosure).toHaveBeenCalledWith('event:e1', { windowSize: 2 });
    expect(mocks.lightweightService.sourceDisclosure).toHaveBeenCalledWith('event:e1');
    expect(mocks.lightweightService.shutdown).toHaveBeenCalledTimes(1);
  });

  it('returns bounded sanitized previews instead of raw dry-run payload content', async () => {
    const apiKeyName = 'api_key';
    const sensitiveContent = `${apiKeyName}=fixturevalue123 /Users/example/private ${'x'.repeat(800)}`;
    mocks.lightweightService.searchDisclosure.mockResolvedValue({
      results: [
        {
          id: 'event:e1',
          resultType: 'source',
          snippet: sensitiveContent,
          preview: sensitiveContent,
          score: 0.88,
          reasons: ['keyword_match', sensitiveContent],
          sourceRef: 'event:e1',
          content: sensitiveContent,
          metadata: { ['token']: 'fixturevalue-search' },
        },
      ],
      meta: { total: 1, usedVector: false, usedKeyword: true, debugRawPath: '/Users/example/debug' },
    });
    mocks.lightweightService.expandDisclosure.mockResolvedValue({
      target: { id: 'event:e1', content: sensitiveContent, metadata: { ['token']: 'fixturevalue-target' } },
      surroundingFacts: [
        { id: 'fact-1', snippet: sensitiveContent, content: sensitiveContent, metadata: { ['token']: 'fixturevalue-fact' } },
      ],
      relatedSources: [{ sourceRef: 'event:e1', eventIds: ['e1'], rawEvents: [{ content: sensitiveContent }] }],
      expandedContext: sensitiveContent,
    });
    mocks.lightweightService.sourceDisclosure.mockResolvedValue({
      sourceRef: 'event:e1',
      sourceType: 'raw_event',
      eventIds: ['e1'],
      rawEvents: [
        { id: 'e1', sessionId: 's1', eventType: 'tool_observation', content: sensitiveContent, metadata: { ['token']: 'fixturevalue-source' } },
      ],
    });

    const res = await createApp().request('/api/playground/dry-run?project=abc12345', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'sensitive hit', options: { strategy: 'fast' } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const event = body.source.rawEvents[0];
    const serialized = JSON.stringify(body);
    expect(body.search.results[0]).not.toHaveProperty('content');
    expect(body.search.results[0]).not.toHaveProperty('metadata');
    expect(body.expansion).not.toHaveProperty('expandedContext');
    expect(body.expansion.target).not.toHaveProperty('content');
    expect(body.expansion.target).not.toHaveProperty('metadata');
    expect(body.expansion.surroundingFacts[0]).not.toHaveProperty('content');
    expect(body.expansion.surroundingFacts[0]).not.toHaveProperty('metadata');
    expect(body.expansion.relatedSources[0]).not.toHaveProperty('rawEvents');
    expect(event).not.toHaveProperty('content');
    expect(event).not.toHaveProperty('metadata');
    expect(event.preview).toContain('api_key=[REDACTED]');
    expect(event.preview).toContain('[REDACTED]');
    expect(event.preview.length).toBeLessThanOrEqual(503);
    expect(body.search.results[0].snippet.length).toBeLessThanOrEqual(503);
    expect(body.expansion.surroundingFacts[0].snippet.length).toBeLessThanOrEqual(503);
    for (const forbidden of [
      'fixturevalue123',
      'fixturevalue-search',
      'fixturevalue-target',
      'fixturevalue-fact',
      'fixturevalue-source',
      '/Users/example',
      'x'.repeat(600),
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('returns a privacy-safe empty replay when search has no results', async () => {
    mocks.lightweightService.searchDisclosure.mockResolvedValue({
      results: [],
      meta: { total: 0, usedVector: false, usedKeyword: true },
    });

    const res = await createApp().request('/api/playground/dry-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'no match', options: { strategy: 'fast' } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      dryRun: true,
      mutated: false,
      selectedResultId: null,
      expansion: null,
      source: null,
      replayTrace: ['search', 'no-results'],
    });
    expect(mocks.lightweightService.expandDisclosure).not.toHaveBeenCalled();
    expect(mocks.lightweightService.sourceDisclosure).not.toHaveBeenCalled();
  });

  it('rejects missing dry-run query before initializing any service', async () => {
    const res = await createApp().request('/api/playground/dry-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: { strategy: 'fast' } }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Query is required' });
    expect(mocks.getServiceFromQuery).not.toHaveBeenCalled();
    expect(mocks.getLightweightServiceFromQuery).not.toHaveBeenCalled();
  });
});
