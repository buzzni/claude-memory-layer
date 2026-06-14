import { describe, expect, it } from 'vitest';

import { longMemEvalEntriesToReplayFixture } from '../../src/core/longmemeval-adapter.js';
import {
  combineLongMemEvalHybridSessionResults,
  createLongMemEvalHybridRetrievalRunner
} from '../../src/core/longmemeval-hybrid-retrieval.js';
import type { ReplayRetrievalRunner } from '../../src/core/replay-evaluator.js';

describe('LongMemEval hybrid retrieval', () => {
  it('promotes turn-level evidence back to session qrels and reranks above weak session hits', () => {
    const combined = combineLongMemEvalHybridSessionResults({
      topK: 3,
      sessionResult: {
        retrievedIds: ['q_1::session::s_noise'],
        candidateIds: ['q_1::session::s_noise'],
        confidence: 'suggested',
        fallbackTrace: ['session']
      },
      turnResult: {
        retrievedIds: ['q_1::session::s_answer::turn::2', 'q_1::session::s_answer::turn::4'],
        candidateIds: ['q_1::session::s_answer::turn::2', 'q_1::session::s_answer::turn::4'],
        confidence: 'high',
        fallbackTrace: ['turn']
      }
    });

    expect(combined.retrievedIds).toEqual([
      'q_1::session::s_answer',
      'q_1::session::s_noise'
    ]);
    expect(combined.candidateIds).toEqual([
      'q_1::session::s_answer',
      'q_1::session::s_noise'
    ]);
    expect(combined.confidence).toBe('high');
    expect(combined.fallbackTrace).toEqual(expect.arrayContaining([
      'hybrid:session-turn',
      'hybrid:turn-promoted:1'
    ]));
  });

  it('promotes content-similar candidate siblings for multi-session count completion', () => {
    const sessionFixture = {
      name: 'multi-session-sibling-fixture',
      ks: [1, 5],
      queries: [],
      memories: [
        {
          id: 'q_clothes::session::alpha',
          content: 'user: I need organization tips for my closet after buying black jeans from a clothing store.',
          sourceSessionId: 'alpha'
        },
        {
          id: 'q_clothes::session::bravo',
          content: 'user: Please help declutter my closet and clothes; I still need to pick up a navy blazer.',
          sourceSessionId: 'bravo'
        },
        {
          id: 'q_clothes::session::charlie',
          content: 'user: I need organization tips for my closet because winter clothes are still waiting to be put away.',
          sourceSessionId: 'charlie'
        },
        {
          id: 'q_clothes::session::noise_sewing',
          content: 'user: I need organizing tips for my sewing space after receiving DMC floss.',
          sourceSessionId: 'noise_sewing'
        },
        {
          id: 'q_clothes::session::noise_history',
          content: 'user: Tell me about Anabaptist communities during the Reformation.',
          sourceSessionId: 'noise_history'
        },
        {
          id: 'q_clothes::session::noise_guitar',
          content: 'user: I want to pick up acoustic guitar again and need buying advice.',
          sourceSessionId: 'noise_guitar'
        }
      ]
    };
    const combined = combineLongMemEvalHybridSessionResults({
      topK: 5,
      query: {
        queryId: 'q_clothes',
        query: 'How many items of clothing do I need to pick up or return from a store?',
        expectedIds: [],
        category: 'multi-session'
      },
      sessionFixture,
      sessionResult: {
        retrievedIds: [
          'q_clothes::session::alpha',
          'q_clothes::session::bravo',
          'q_clothes::session::noise_sewing',
          'q_clothes::session::noise_history',
          'q_clothes::session::noise_guitar'
        ],
        candidateIds: [
          'q_clothes::session::alpha',
          'q_clothes::session::bravo',
          'q_clothes::session::noise_sewing',
          'q_clothes::session::noise_history',
          'q_clothes::session::noise_guitar',
          'q_clothes::session::charlie'
        ],
        confidence: 'suggested'
      },
      turnResult: {
        retrievedIds: [],
        candidateIds: [],
        confidence: 'none'
      }
    });

    expect(combined.retrievedIds).toEqual([
      'q_clothes::session::alpha',
      'q_clothes::session::bravo',
      'q_clothes::session::charlie',
      'q_clothes::session::noise_sewing',
      'q_clothes::session::noise_history'
    ]);
    expect(combined.fallbackTrace).toContain('hybrid:multi-session-sibling-completion:1');
  });

  it('creates a runner that searches session and turn fixtures then returns session ids', async () => {
    const entries = [{
      question_id: 'q_2',
      question_type: 'single-session-user',
      question: 'Which tea did the user prefer?',
      answer: 'jasmine tea',
      haystack_session_ids: ['s_noise', 's_answer'],
      haystack_dates: ['2026-01-01', '2026-01-02'],
      haystack_sessions: [
        [{ role: 'user', content: 'I talked about a calendar.' }],
        [
          { role: 'user', content: 'Noise before the preference.' },
          { role: 'user', content: 'I prefer jasmine tea in the afternoon.', has_answer: true }
        ]
      ],
      answer_session_ids: ['s_answer']
    }];
    const sessionFixture = longMemEvalEntriesToReplayFixture(entries, { granularity: 'session' });
    const turnFixture = longMemEvalEntriesToReplayFixture(entries, { granularity: 'turn' });
    const calls: string[] = [];
    const sessionRunner: ReplayRetrievalRunner = async (_query, input) => {
      calls.push(`session:${input.fixture.name}`);
      return {
        retrievedIds: ['q_2::session::s_noise'],
        candidateIds: ['q_2::session::s_noise'],
        confidence: 'suggested'
      };
    };
    const turnRunner: ReplayRetrievalRunner = async (_query, input) => {
      calls.push(`turn:${input.fixture.name}`);
      return {
        retrievedIds: ['q_2::session::s_answer::turn::1'],
        candidateIds: ['q_2::session::s_answer::turn::1'],
        confidence: 'high'
      };
    };

    const runner = createLongMemEvalHybridRetrievalRunner({
      sessionFixture,
      turnFixture,
      sessionRunner,
      turnRunner
    });
    const result = await runner('Which tea did the user prefer?', {
      fixture: sessionFixture,
      query: sessionFixture.queries[0],
      topK: 2,
      retrievalOptions: {}
    });

    expect(calls).toEqual([
      'session:longmemeval-session-retrieval',
      'turn:longmemeval-turn-retrieval'
    ]);
    expect(result.retrievedIds).toEqual([
      'q_2::session::s_answer',
      'q_2::session::s_noise'
    ]);
  });

  it('applies custom session and turn fusion weights in runner results', async () => {
    const entries = [{
      question_id: 'q_weight',
      question_type: 'single-session-user',
      question: 'Which session should win after custom weighting?',
      answer: 'session answer',
      haystack_session_ids: ['s_session', 's_turn'],
      haystack_dates: ['2026-01-01', '2026-01-02'],
      haystack_sessions: [
        [{ role: 'user', content: 'session lane evidence', has_answer: true }],
        [{ role: 'user', content: 'turn lane distractor' }]
      ],
      answer_session_ids: ['s_session']
    }];
    const sessionFixture = longMemEvalEntriesToReplayFixture(entries, { granularity: 'session' });
    const turnFixture = longMemEvalEntriesToReplayFixture(entries, { granularity: 'turn' });
    const sessionRunner: ReplayRetrievalRunner = async () => ({
      retrievedIds: ['q_weight::session::s_session'],
      candidateIds: ['q_weight::session::s_session'],
      confidence: 'suggested'
    });
    const turnRunner: ReplayRetrievalRunner = async () => ({
      retrievedIds: ['q_weight::session::s_turn::turn::0'],
      candidateIds: ['q_weight::session::s_turn::turn::0'],
      confidence: 'high'
    });

    const runner = createLongMemEvalHybridRetrievalRunner({
      sessionFixture,
      turnFixture,
      sessionRunner,
      turnRunner,
      sessionWeight: 2,
      turnWeight: 0.25
    });
    const result = await runner('Which session should win after custom weighting?', {
      fixture: sessionFixture,
      query: sessionFixture.queries[0],
      topK: 2,
      retrievalOptions: {}
    });

    expect(result.retrievedIds).toEqual([
      'q_weight::session::s_session',
      'q_weight::session::s_turn'
    ]);
    expect(result.fallbackTrace).toContain('hybrid:weights:session=2,turn=0.25');
  });
});
