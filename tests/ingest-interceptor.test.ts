import { describe, it, expect } from 'vitest';
import { IngestInterceptorRegistry, mergeHierarchicalMetadata } from '../src/core/ingest-interceptor.js';

describe('IngestInterceptorRegistry', () => {
  it('runs before/after interceptors in staged order', async () => {
    const registry = new IngestInterceptorRegistry();
    const stages: string[] = [];

    registry.registerBefore((ctx) => stages.push(`before:${ctx.operation}`));
    registry.registerAfter((ctx) => stages.push(`after:${ctx.operation}`));

    const event = {
      eventType: 'user_prompt' as const,
      sessionId: 's1',
      timestamp: new Date(),
      content: 'hello'
    };

    await registry.run('before', { operation: 'user_prompt', sessionId: 's1', event });
    await registry.run('after', { operation: 'user_prompt', sessionId: 's1', event });

    expect(stages).toEqual(['before:user_prompt', 'after:user_prompt']);
  });
});

describe('mergeHierarchicalMetadata', () => {
  it('deep merges nested metadata without clobbering siblings', () => {
    const merged = mergeHierarchicalMetadata(
      { scope: { project: { id: 'alpha', env: 'dev' } }, ingest: { source: 'hook' } },
      { scope: { project: { env: 'prod' }, turn: { id: 't1' } } }
    );

    expect(merged).toEqual({
      scope: { project: { id: 'alpha', env: 'prod' }, turn: { id: 't1' } },
      ingest: { source: 'hook' }
    });
  });
});
