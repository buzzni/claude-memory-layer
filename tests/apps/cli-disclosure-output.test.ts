import { describe, expect, it } from 'vitest';
import {
  formatDisclosureExpansion,
  formatDisclosureSearch,
  formatDisclosureSource,
  formatPlainSearchResults
} from '../../src/apps/cli/retrieval-disclosure-output.js';

describe('retrieval disclosure CLI output', () => {
  it('formats compact search envelopes with type badges, reasons, and source refs', () => {
    const out = formatDisclosureSearch({
      results: [
        {
          id: 'event:e1',
          resultType: 'tool_evidence',
          title: 'Tool evidence',
          snippet: 'Applied checkout fix in src/cart.ts',
          score: 0.91,
          reasons: ['semantic_match', 'tool_followup'],
          sourceRef: 'event:e1',
          sessionId: 'session-1234567890'
        }
      ],
      meta: {
        total: 1,
        usedVector: true,
        usedKeyword: true,
        fallbackApplied: false
      }
    });

    expect(out).toContain('🔎 Progressive Search Results');
    expect(out).toContain('Meta: total=1 vector=yes keyword=yes fallback=no');
    expect(out).toContain('[tool_evidence] Tool evidence');
    expect(out).toContain('event:e1');
    expect(out).toContain('semantic_match, tool_followup');
    expect(out).toContain('session-');
  });

  it('formats expand output with target, surrounding results, sources, and expanded context', () => {
    const out = formatDisclosureExpansion({
      target: {
        id: 'event:e2',
        resultType: 'source',
        title: 'Agent response',
        snippet: 'Use the disclosure API',
        score: 1,
        reasons: ['continuity_link'],
        sourceRef: 'event:e2'
      },
      surroundingFacts: [
        {
          id: 'event:e1',
          resultType: 'source',
          snippet: 'Earlier user prompt',
          score: 1,
          reasons: ['continuity_link'],
          sourceRef: 'event:e1'
        }
      ],
      relatedSources: [{ sourceRef: 'event:e2', sourceType: 'raw_event', eventIds: ['e2'] }],
      expandedContext: '[agent_response] Use the disclosure API'
    });

    expect(out).toContain('🧩 Expanded Retrieval Result');
    expect(out).toContain('Target');
    expect(out).toContain('Surrounding');
    expect(out).toContain('Sources');
    expect(out).toContain('[agent_response] Use the disclosure API');
  });

  it('formats shared disclosure provenance explicitly in expansion and source output', () => {
    const expansionOut = formatDisclosureExpansion({
      target: {
        id: 'shared:shared-1',
        resultType: 'rule',
        title: 'Shared checkout troubleshooting',
        snippet: 'clear cache and retry',
        score: 0.88,
        reasons: ['semantic_match'],
        sourceRef: 'shared:shared-1',
        metadata: {
          sourceProjectHash: 'project-a',
          sourceEntryId: 'e-shared',
          topics: ['checkout']
        }
      },
      relatedSources: [
        {
          sourceRef: 'shared:shared-1',
          sourceType: 'shared_troubleshooting',
          eventIds: [],
          metadata: {
            sourceProjectHash: 'project-a',
            sourceEntryId: 'e-shared',
            topics: ['checkout']
          }
        }
      ],
      expandedContext: '[shared_troubleshooting] Shared checkout troubleshooting\nRoot cause: stale cache'
    });

    const sourceOut = formatDisclosureSource({
      sourceRef: 'shared:shared-1',
      sourceType: 'shared_troubleshooting',
      eventIds: [],
      rawEvents: [],
      metadata: {
        sourceProjectHash: 'project-a',
        sourceEntryId: 'e-shared',
        topics: ['checkout'],
        rootCause: 'stale cache',
        solution: 'clear cache and retry'
      }
    });

    expect(expansionOut).toContain('shared_troubleshooting');
    expect(expansionOut).toContain('sourceProjectHash: project-a');
    expect(expansionOut).toContain('topics: checkout');
    expect(sourceOut).toContain('Shared Metadata');
    expect(sourceOut).toContain('rootCause: stale cache');
    expect(sourceOut).toContain('No local raw events for this shared source.');
  });

  it('formats source output with source type, event ids, and raw event previews', () => {
    const out = formatDisclosureSource({
      sourceRef: 'event:e3',
      sourceType: 'raw_event',
      eventIds: ['e3'],
      rawEvents: [
        {
          id: 'e3',
          sessionId: 'session-1',
          eventType: 'user_prompt',
          content: 'Show source details',
          canonicalKey: 'canonical/e3',
          dedupeKey: 'session-1:e3',
          timestamp: new Date('2026-02-24T00:00:00.000Z'),
          metadata: {}
        }
      ]
    });

    expect(out).toContain('📎 Retrieval Source');
    expect(out).toContain('sourceType: raw_event');
    expect(out).toContain('eventIds: e3');
    expect(out).toContain('[user_prompt] Show source details');
  });

  it('formats plain search output with shared memories when includeShared is used', () => {
    const out = formatPlainSearchResults({
      memories: [
        {
          event: {
            id: 'e1',
            sessionId: 'session-1234567890',
            eventType: 'agent_response',
            content: 'Local checkout fix details',
            canonicalKey: 'canonical/e1',
            dedupeKey: 'session-1234567890:e1',
            timestamp: new Date('2026-02-24T00:00:00.000Z'),
            metadata: {}
          },
          score: 0.91
        }
      ],
      matchResult: {
        match: {
          event: {
            id: 'e1',
            sessionId: 'session-1234567890',
            eventType: 'agent_response',
            content: 'Local checkout fix details',
            canonicalKey: 'canonical/e1',
            dedupeKey: 'session-1234567890:e1',
            timestamp: new Date('2026-02-24T00:00:00.000Z'),
            metadata: {}
          },
          score: 0.91
        },
        confidence: 'high'
      },
      totalTokens: 10,
      context: 'Local checkout fix details',
      sharedMemories: [
        {
          entryId: 'shared-1',
          sourceProjectHash: 'project-a',
          sourceEntryId: 'e-shared',
          title: 'Shared checkout troubleshooting',
          symptoms: ['checkout fails'],
          rootCause: 'stale cache',
          solution: 'clear cache and retry',
          topics: ['checkout'],
          confidence: 0.88,
          usageCount: 3,
          promotedAt: new Date('2026-02-23T00:00:00.000Z'),
          createdAt: new Date('2026-02-23T00:00:00.000Z')
        }
      ]
    });

    expect(out).toContain('📚 Search Results');
    expect(out).toContain('Total local memories found: 1');
    expect(out).toContain('Shared memories found: 1');
    expect(out).toContain('🌐 Shared Memories');
    expect(out).toContain('Shared checkout troubleshooting');
    expect(out).toContain('Source: shared:shared-1');
    expect(out).toContain('Project: project-a');
    expect(out).toContain('Solution: clear cache and retry');
  });
});
