import { describe, it, expect } from 'vitest';
import { Retriever } from '../../src/core/retriever.js';
import { Matcher } from '../../src/core/matcher.js';
import type { MemoryEvent } from '../../src/core/types.js';

function ev(id: string, sessionId: string, eventType: MemoryEvent['eventType'], content: string, canonicalKey: string): MemoryEvent {
  return {
    id,
    sessionId,
    eventType,
    content,
    canonicalKey,
    dedupeKey: `${sessionId}:${id}`,
    timestamp: new Date('2026-02-24T00:00:00.000Z'),
    metadata: {}
  };
}

describe('Retriever strategy/scope', () => {
  const e1 = ev('e1', 'agent:main:alpha', 'user_prompt', '아침 브리핑 선호', 'pref/briefing/morning');
  const e2 = ev('e2', 'agent:main:beta', 'agent_response', '점심 이후 요약은 잘 안봄', 'pref/briefing/lunch');

  const fakeEventStore = {
    async keywordSearch() {
      return [
        { event: e1, rank: -0.1 },
        { event: e2, rank: -0.2 }
      ];
    },
    async getRecentEvents() {
      return [e1, e2];
    },
    async getEvent(id: string) {
      return id === 'e1' ? e1 : id === 'e2' ? e2 : null;
    },
    async getSessionEvents(sessionId: string) {
      return [e1, e2].filter((x) => x.sessionId === sessionId);
    }
  };

  const fakeVectorStore = {
    async search() {
      return [
        {
          id: 'v1',
          eventId: 'e2',
          content: e2.content,
          score: 0.92,
          sessionId: e2.sessionId,
          eventType: e2.eventType,
          timestamp: e2.timestamp.toISOString()
        },
        {
          id: 'v2',
          eventId: 'e1',
          content: e1.content,
          score: 0.8,
          sessionId: e1.sessionId,
          eventType: e1.eventType,
          timestamp: e1.timestamp.toISOString()
        }
      ];
    }
  };

  const fakeEmbedder = {
    async embed() {
      return { vector: [0.1, 0.2, 0.3] };
    }
  };

  it('uses fast strategy keyword path', async () => {
    const retriever = new Retriever(fakeEventStore as any, fakeVectorStore as any, fakeEmbedder as any, new Matcher());
    const out = await retriever.retrieve('브리핑', { strategy: 'fast', topK: 2, includeSessionContext: false });

    expect(out.memories.length).toBe(2);
    expect(out.memories[0].event.id).toBe('e1');
  });

  it('applies scoped filters (session prefix + canonical prefix + includes)', async () => {
    const retriever = new Retriever(fakeEventStore as any, fakeVectorStore as any, fakeEmbedder as any, new Matcher());

    const out = await retriever.retrieve('브리핑', {
      strategy: 'deep',
      topK: 5,
      includeSessionContext: false,
      scope: {
        sessionIdPrefix: 'agent:main:alpha',
        canonicalKeyPrefix: 'pref/briefing/morning',
        contentIncludes: ['아침']
      }
    });

    expect(out.memories.length).toBe(1);
    expect(out.memories[0].event.id).toBe('e1');
  });

  it('returns no memories for command-artifact queries instead of semantic false positives', async () => {
    const retriever = new Retriever(fakeEventStore as any, fakeVectorStore as any, fakeEmbedder as any, new Matcher());

    const out = await retriever.retrieve('local-command-stdout command-name opus', {
      strategy: 'deep',
      topK: 5,
      minScore: 0.1,
      includeSessionContext: false
    });

    expect(out.memories).toEqual([]);
    expect(out.fallbackTrace).toContain('guard:command-artifact-query');
  });

  it('filters technical identifier queries when candidates have no exact technical overlap', async () => {
    const retriever = new Retriever(fakeEventStore as any, fakeVectorStore as any, fakeEmbedder as any, new Matcher());

    const out = await retriever.retrieve('DuckDB legacy storage migrate', {
      strategy: 'deep',
      topK: 5,
      minScore: 0.1,
      includeSessionContext: false
    });

    expect(out.memories).toEqual([]);
  });

  it('keeps technical identifier matches when candidate content contains the identifier', async () => {
    const technical = ev(
      'e3',
      'agent:main:alpha',
      'agent_response',
      'SQLite FTS failure no such column T.event_id is fixed with event_id UNINDEXED.',
      'fix/sqlite/fts'
    );
    const eventStore = {
      ...fakeEventStore,
      async getEvent(id: string) {
        if (id === 'e3') return technical;
        return fakeEventStore.getEvent(id);
      }
    };
    const vectorStore = {
      async search() {
        return [{
          id: 'v3',
          eventId: 'e3',
          content: technical.content,
          score: 0.93,
          sessionId: technical.sessionId,
          eventType: technical.eventType,
          timestamp: technical.timestamp.toISOString()
        }];
      }
    };
    const retriever = new Retriever(eventStore as any, vectorStore as any, fakeEmbedder as any, new Matcher());

    const out = await retriever.retrieve('T.event_id FTS rebuild', {
      strategy: 'deep',
      topK: 5,
      minScore: 0.1,
      includeSessionContext: false
    });

    expect(out.memories.map((memory) => memory.event.id)).toEqual(['e3']);
  });

  it('reports intent rewrite metadata when deep retrieval expands a query', async () => {
    const vectorQueries: number[][] = [];
    const vectorStore = {
      async search(vector: number[]) {
        vectorQueries.push(vector);
        return [{
          id: `v${vectorQueries.length}`,
          eventId: 'e1',
          content: e1.content,
          score: 0.92,
          sessionId: e1.sessionId,
          eventType: e1.eventType,
          timestamp: e1.timestamp.toISOString()
        }];
      }
    };
    const retriever = new Retriever(fakeEventStore as any, vectorStore as any, fakeEmbedder as any, new Matcher());
    retriever.setQueryRewriter(async () => 'previous implementation plan');

    const out = await retriever.retrieve('그거 계속', {
      strategy: 'deep',
      topK: 5,
      minScore: 0.1,
      includeSessionContext: false,
      intentRewrite: true
    });

    expect(vectorQueries).toHaveLength(2);
    expect(out.rawQueryText).toBe('그거 계속');
    expect(out.effectiveQueryText).toBe('그거 계속 previous implementation plan');
    expect(out.queryRewriteKind).toBe('intent-rewrite');
  });

  it('retrieves actionable current-plan memories for short Korean follow-up prompts', async () => {
    const currentPlan = ev(
      'e-current-plan',
      'agent:main:current',
      'session_summary',
      'Current next step is golden retrieval replay then rerank and stale suppression.',
      'memory/usefulness/current-plan'
    );
    const noise = ev(
      'e-noise',
      'agent:main:current',
      'session_summary',
      'Lunch calendar and unrelated social reminder.',
      'noise/calendar'
    );
    const eventStore = {
      async keywordSearch(query: string) {
        const tokens = query.toLowerCase().split(/\s+/);
        return [currentPlan, noise]
          .map((event) => ({
            event,
            rank: -tokens.filter((token) => event.content.toLowerCase().includes(token)).length
          }))
          .filter((row) => row.rank < 0);
      },
      async getRecentEvents() {
        return [currentPlan, noise];
      },
      async getEvent(id: string) {
        return id === currentPlan.id ? currentPlan : id === noise.id ? noise : null;
      },
      async getSessionEvents(sessionId: string) {
        return [currentPlan, noise].filter((event) => event.sessionId === sessionId);
      }
    };
    const vectorStore = { async search() { return []; } };
    const retriever = new Retriever(eventStore as any, vectorStore as any, fakeEmbedder as any, new Matcher());

    const out = await retriever.retrieve('응 다음 단계 진행', {
      strategy: 'auto',
      topK: 3,
      minScore: 0.1,
      includeSessionContext: false
    });

    expect(out.memories.map((memory) => memory.event.id)).toContain('e-current-plan');
  });

  it('suppresses stale current-state traps and weak-overlap topic shifts', async () => {
    const stale = ev(
      'e-stale-pr',
      'agent:main:old',
      'session_summary',
      'Obsolete note: an earlier pull request was still open and validation had not completed.',
      'stale/pr-status'
    );
    const currentPlan = ev(
      'e-current-plan',
      'agent:main:current',
      'session_summary',
      'Current next step is golden retrieval replay then rerank and stale suppression.',
      'memory/usefulness/current-plan'
    );
    const eventStore = {
      async keywordSearch() {
        return [
          { event: stale, rank: -0.1 },
          { event: currentPlan, rank: -0.2 }
        ];
      },
      async getRecentEvents() {
        return [stale, currentPlan];
      },
      async getEvent(id: string) {
        return id === stale.id ? stale : id === currentPlan.id ? currentPlan : null;
      },
      async getSessionEvents(sessionId: string) {
        return [stale, currentPlan].filter((event) => event.sessionId === sessionId);
      }
    };
    const vectorStore = {
      async search() {
        return [
          {
            id: 'v-stale',
            eventId: stale.id,
            content: stale.content,
            score: 0.94,
            sessionId: stale.sessionId,
            eventType: stale.eventType,
            timestamp: stale.timestamp.toISOString()
          },
          {
            id: 'v-current',
            eventId: currentPlan.id,
            content: currentPlan.content,
            score: 0.9,
            sessionId: currentPlan.sessionId,
            eventType: currentPlan.eventType,
            timestamp: currentPlan.timestamp.toISOString()
          }
        ];
      }
    };
    const retriever = new Retriever(eventStore as any, vectorStore as any, fakeEmbedder as any, new Matcher());

    const staleOut = await retriever.retrieve('use the old open pull request status as current deployment state', {
      strategy: 'deep',
      topK: 3,
      minScore: 0.1,
      includeSessionContext: false
    });
    expect(staleOut.memories.map((memory) => memory.event.id)).not.toContain('e-stale-pr');

    const topicShiftOut = await retriever.retrieve('what time is the next calendar meeting', {
      strategy: 'deep',
      topK: 3,
      minScore: 0.1,
      includeSessionContext: false
    });
    expect(topicShiftOut.memories.map((memory) => memory.event.id)).not.toContain('e-current-plan');
  });

  it('keeps continuation and repair candidates that do not contain injected quality vocabulary', async () => {
    const nextStep = ev(
      'e-invoice-next',
      'agent:main:current',
      'session_summary',
      'Customer invoice parser rollout is the active handoff for the next turn.',
      'handoff/invoice-parser'
    );
    const repair = ev(
      'e-invoice-repair',
      'agent:main:current',
      'session_summary',
      'Patch the failing invoice parser assertion before release.',
      'fix/invoice-parser'
    );
    const eventStore = {
      async keywordSearch() {
        return [];
      },
      async getRecentEvents() {
        return [nextStep, repair];
      },
      async getEvent(id: string) {
        if (id === nextStep.id) return nextStep;
        if (id === repair.id) return repair;
        return null;
      },
      async getSessionEvents(sessionId: string) {
        return [nextStep, repair].filter((event) => event.sessionId === sessionId);
      }
    };
    const embedder = {
      async embed(text: string) {
        return { vector: [/(?:고쳐|fix|repair|assertion)/i.test(text) ? 2 : 1] };
      }
    };
    const vectorStore = {
      async search(vector: number[]) {
        const event = vector[0] === 2 ? repair : nextStep;
        return [{
          id: `v-${event.id}`,
          eventId: event.id,
          content: event.content,
          score: 0.92,
          sessionId: event.sessionId,
          eventType: event.eventType,
          timestamp: event.timestamp.toISOString()
        }];
      }
    };
    const retriever = new Retriever(eventStore as any, vectorStore as any, embedder as any, new Matcher());

    const continuationOut = await retriever.retrieve('continue', {
      strategy: 'deep',
      topK: 2,
      minScore: 0.1,
      includeSessionContext: false
    });
    expect(continuationOut.memories.map((memory) => memory.event.id)).toContain('e-invoice-next');

    const repairOut = await retriever.retrieve('그거 고쳐줘', {
      strategy: 'deep',
      topK: 2,
      minScore: 0.1,
      includeSessionContext: false
    });
    expect(repairOut.memories.map((memory) => memory.event.id)).toContain('e-invoice-repair');
  });

  it('keeps active current-state memories when stale is the live topic', async () => {
    const active = ev(
      'e-active-stale-topic',
      'agent:main:current',
      'session_summary',
      'Current stale suppression tuning is active work and validated by golden replay.',
      'memory/usefulness/stale-suppression'
    );
    const eventStore = {
      async keywordSearch() {
        return [];
      },
      async getRecentEvents() {
        return [active];
      },
      async getEvent(id: string) {
        return id === active.id ? active : null;
      },
      async getSessionEvents(sessionId: string) {
        return [active].filter((event) => event.sessionId === sessionId);
      }
    };
    const vectorStore = {
      async search() {
        return [{
          id: 'v-active-stale-topic',
          eventId: active.id,
          content: active.content,
          score: 0.94,
          sessionId: active.sessionId,
          eventType: active.eventType,
          timestamp: active.timestamp.toISOString()
        }];
      }
    };
    const retriever = new Retriever(eventStore as any, vectorStore as any, fakeEmbedder as any, new Matcher());

    const out = await retriever.retrieve('current stale suppression implementation status', {
      strategy: 'deep',
      topK: 2,
      minScore: 0.1,
      includeSessionContext: false
    });

    expect(out.memories.map((memory) => memory.event.id)).toContain('e-active-stale-topic');
  });

  it('keeps polite current-state status queries with one substantive domain term', async () => {
    const prStatus = ev(
      'e-pr-status',
      'agent:main:current',
      'session_summary',
      'PR #42 remains open pending deployment validation.',
      'status/pr-42'
    );
    const eventStore = {
      async keywordSearch() {
        return [];
      },
      async getRecentEvents() {
        return [prStatus];
      },
      async getEvent(id: string) {
        return id === prStatus.id ? prStatus : null;
      },
      async getSessionEvents(sessionId: string) {
        return [prStatus].filter((event) => event.sessionId === sessionId);
      }
    };
    const vectorStore = {
      async search() {
        return [{
          id: 'v-pr-status',
          eventId: prStatus.id,
          content: prStatus.content,
          score: 0.95,
          sessionId: prStatus.sessionId,
          eventType: prStatus.eventType,
          timestamp: prStatus.timestamp.toISOString()
        }];
      }
    };
    const retriever = new Retriever(eventStore as any, vectorStore as any, fakeEmbedder as any, new Matcher());

    const out = await retriever.retrieve('Can you show me the current PR status?', {
      strategy: 'deep',
      topK: 2,
      minScore: 0.1,
      includeSessionContext: false
    });

    expect(out.memories.map((memory) => memory.event.id)).toContain('e-pr-status');
  });

  it('keeps resolved or closed facts when they are the current status', async () => {
    const resolvedStatus = ev(
      'e-pr-resolved-status',
      'agent:main:current',
      'session_summary',
      'Current PR #42 is already resolved and closed after validation passed.',
      'status/pr-42-resolved'
    );
    const eventStore = {
      async keywordSearch() {
        return [];
      },
      async getRecentEvents() {
        return [resolvedStatus];
      },
      async getEvent(id: string) {
        return id === resolvedStatus.id ? resolvedStatus : null;
      },
      async getSessionEvents(sessionId: string) {
        return [resolvedStatus].filter((event) => event.sessionId === sessionId);
      }
    };
    const vectorStore = {
      async search() {
        return [{
          id: 'v-pr-resolved-status',
          eventId: resolvedStatus.id,
          content: resolvedStatus.content,
          score: 0.95,
          sessionId: resolvedStatus.sessionId,
          eventType: resolvedStatus.eventType,
          timestamp: resolvedStatus.timestamp.toISOString()
        }];
      }
    };
    const retriever = new Retriever(eventStore as any, vectorStore as any, fakeEmbedder as any, new Matcher());

    const out = await retriever.retrieve('Can you show me the current PR status?', {
      strategy: 'deep',
      topK: 2,
      minScore: 0.1,
      includeSessionContext: false
    });

    expect(out.memories.map((memory) => memory.event.id)).toContain('e-pr-resolved-status');
  });

  it('does not let privacy/dashboard decision expansion hijack unrelated decision recall queries', async () => {
    const telemetryPrivacy = ev(
      'e-telemetry-privacy',
      'agent:main:current',
      'session_summary',
      'Retrieval telemetry public APIs and dashboards must not expose rawQueryText or queryText; use trace id, strategy, rewrite kind, and aggregate counts instead.',
      'memory/privacy/retrieval-telemetry'
    );
    const dashboardTrace = ev(
      'e-dashboard-trace',
      'agent:main:current',
      'session_summary',
      'Dashboard trace panels render safe metadata such as trace id, reason, strategy, rewrite kind, candidate count, and selected count.',
      'memory/privacy/dashboard-trace'
    );
    const apiRetry = ev(
      'e-api-retry',
      'agent:main:current',
      'session_summary',
      'API retry policy decision: retry failed provider calls with exponential backoff.',
      'memory/api/retry-policy'
    );
    const dashboardLayout = ev(
      'e-dashboard-layout',
      'agent:main:current',
      'session_summary',
      'Dashboard layout decision: spacing counts use compact cards with consistent gutters.',
      'memory/dashboard/layout-spacing'
    );
    const dashboardLayoutKo = ev(
      'e-dashboard-layout-ko',
      'agent:main:current',
      'session_summary',
      '대시보드 레이아웃 간격 결정: 카드 간격은 compact gutter를 사용한다.',
      'memory/dashboard/layout-spacing-ko'
    );
    const events = [telemetryPrivacy, dashboardTrace, apiRetry, dashboardLayout, dashboardLayoutKo];
    const eventStore = {
      async keywordSearch() {
        return [];
      },
      async getRecentEvents() {
        return events;
      },
      async getEvent(id: string) {
        return events.find((event) => event.id === id) ?? null;
      },
      async getSessionEvents(sessionId: string) {
        return events.filter((event) => event.sessionId === sessionId);
      }
    };
    let vectorEvents = [telemetryPrivacy, dashboardTrace, apiRetry];
    const vectorStore = {
      async search() {
        return vectorEvents.map((event, index) => ({
          id: `v-${event.id}`,
          eventId: event.id,
          content: event.content,
          score: [0.98, 0.96, 0.8][index] ?? 0.75,
          sessionId: event.sessionId,
          eventType: event.eventType,
          timestamp: event.timestamp.toISOString()
        }));
      }
    };
    const retriever = new Retriever(eventStore as any, vectorStore as any, fakeEmbedder as any, new Matcher());

    const apiOut = await retriever.retrieve('what API policy did we decide for retries', {
      strategy: 'deep',
      topK: 3,
      minScore: 0.1,
      includeSessionContext: false
    });
    expect(apiOut.memories.map((memory) => memory.event.id)).toEqual(['e-api-retry']);

    vectorEvents = [dashboardTrace, telemetryPrivacy, dashboardLayout];
    const layoutOut = await retriever.retrieve('what dashboard layout decision did we make for spacing counts', {
      strategy: 'deep',
      topK: 3,
      minScore: 0.1,
      includeSessionContext: false
    });
    expect(layoutOut.memories.map((memory) => memory.event.id)).toEqual(['e-dashboard-layout']);

    vectorEvents = [dashboardTrace, dashboardLayoutKo];
    const koreanLayoutOut = await retriever.retrieve('대시보드 레이아웃 간격 결정은 뭐였지', {
      strategy: 'deep',
      topK: 3,
      minScore: 0.1,
      includeSessionContext: false
    });
    expect(koreanLayoutOut.memories.map((memory) => memory.event.id)).toEqual(['e-dashboard-layout-ko']);
  });

  it('keeps summary fallback within strict project scope for generic continuation', async () => {
    const foreign = {
      ...ev(
        'e-foreign-plan',
        'agent:foreign:current',
        'session_summary',
        'Current next step plan is foreign project deployment validation.',
        'foreign/current-plan'
      ),
      metadata: { scope: { project: { hash: 'foreign' } } }
    };
    const local = {
      ...ev(
        'e-local-note',
        'agent:local:current',
        'session_summary',
        'Local billing parser note unrelated to invoices.',
        'local/other-note'
      ),
      metadata: { scope: { project: { hash: 'local' } } }
    };
    const eventStore = {
      async keywordSearch() {
        return [];
      },
      async getRecentEvents() {
        return [foreign, local];
      },
      async getEvent(id: string) {
        if (id === foreign.id) return foreign;
        if (id === local.id) return local;
        return null;
      },
      async getSessionEvents(sessionId: string) {
        return [foreign, local].filter((event) => event.sessionId === sessionId);
      }
    };
    const vectorStore = { async search() { return []; } };
    const retriever = new Retriever(eventStore as any, vectorStore as any, fakeEmbedder as any, new Matcher());

    const out = await retriever.retrieve('continue', {
      strategy: 'auto',
      topK: 3,
      minScore: 0.1,
      includeSessionContext: false,
      projectScopeMode: 'strict',
      projectHash: 'local'
    });

    expect(out.fallbackTrace).toContain('fallback:summary');
    expect(out.memories.map((memory) => memory.event.id)).not.toContain('e-foreign-plan');
    expect(out.memories).toEqual([]);
  });
});
