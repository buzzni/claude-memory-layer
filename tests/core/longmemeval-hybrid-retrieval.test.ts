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
