import { describe, expect, it } from 'vitest';
import {
  formatDisclosureExpansion,
  formatDisclosureSearch,
  formatDisclosureSource
} from '../src/cli/retrieval-disclosure-output.js';

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
});
