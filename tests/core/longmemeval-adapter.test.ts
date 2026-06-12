import { describe, expect, it } from 'vitest';

import { longMemEvalEntriesToReplayFixture } from '../../src/core/longmemeval-adapter.js';

describe('LongMemEval replay adapter', () => {
  it('converts answer-session labels into positive replay qrels without leaking queries into report metadata', () => {
    const fixture = longMemEvalEntriesToReplayFixture([
      {
        question_id: 'q_001',
        question_type: 'multi-session',
        question: 'Which city did the user decide to visit after comparing options?',
        answer: 'Seoul',
        question_date: '2026-01-03',
        haystack_session_ids: ['s_noise', 's_answer'],
        haystack_dates: ['2026-01-01', '2026-01-02'],
        haystack_sessions: [
          [
            { role: 'user', content: 'I like quiet cafes.' },
            { role: 'assistant', content: 'I will remember that preference.' }
          ],
          [
            { role: 'user', content: 'After comparing Tokyo and Seoul, I chose Seoul for spring.' },
            { role: 'assistant', content: 'Seoul is the selected city.' }
          ]
        ],
        answer_session_ids: ['s_answer']
      }
    ], { name: 'longmemeval-unit', maxEntries: 1 });

    expect(fixture).toMatchObject({
      name: 'longmemeval-unit',
      ks: [1, 5, 10],
      metadata: {
        sourceFileCount: 1,
        rawContentIncluded: true
      }
    });
    expect(fixture.queries).toEqual([
      {
        queryId: 'q_001',
        query: 'Which city did the user decide to visit after comparing options?',
        expectedIds: ['q_001::session::s_answer'],
        expectedRelevance: { 'q_001::session::s_answer': 3 },
        expectation: 'match',
        category: 'multi-session',
        knownAnswer: 'Seoul'
      }
    ]);
    expect(fixture.memories).toEqual([
      {
        id: 'q_001::session::s_noise',
        content: '[2026-01-01] session s_noise\nuser: I like quiet cafes.\nassistant: I will remember that preference.',
        sourceSessionId: 's_noise',
        timestamp: '2026-01-01',
        metadata: { questionId: 'q_001', questionType: 'multi-session' }
      },
      {
        id: 'q_001::session::s_answer',
        content: '[2026-01-02] session s_answer\nuser: After comparing Tokyo and Seoul, I chose Seoul for spring.\nassistant: Seoul is the selected city.',
        sourceSessionId: 's_answer',
        timestamp: '2026-01-02',
        metadata: { questionId: 'q_001', questionType: 'multi-session' }
      }
    ]);
  });

  it('converts abstention questions into strict no-match qrels with all sessions forbidden', () => {
    const fixture = longMemEvalEntriesToReplayFixture([
      {
        question_id: 'q_002_abs',
        question_type: 'single-session-user',
        question: 'What unavailable detail was never mentioned?',
        answer: 'The detail is not present.',
        question_date: '2026-01-04',
        haystack_session_ids: ['s1'],
        haystack_dates: ['2026-01-01'],
        haystack_sessions: [
          [{ role: 'user', content: 'I only mentioned my lunch.' }]
        ],
        answer_session_ids: []
      }
    ], { maxEntries: 1 });

    expect(fixture.queries).toEqual([
      {
        queryId: 'q_002_abs',
        query: 'What unavailable detail was never mentioned?',
        expectedIds: [],
        expectedRelevance: {},
        expectation: 'no_match',
        category: 'single-session-user:abstention',
        forbiddenIds: ['q_002_abs::session::s1'],
        knownAnswer: 'The detail is not present.'
      }
    ]);
  });

  it('can build turn-level qrels from has_answer labels when requested', () => {
    const fixture = longMemEvalEntriesToReplayFixture([
      {
        question_id: 'q_003',
        question_type: 'single-session-user',
        question: 'Which meal did the user mention?',
        answer: 'bibimbap',
        question_date: '2026-01-05',
        haystack_session_ids: ['s1'],
        haystack_dates: ['2026-01-01'],
        haystack_sessions: [
          [
            { role: 'user', content: 'Noise turn.' },
            { role: 'user', content: 'I had bibimbap for lunch.', has_answer: true }
          ]
        ],
        answer_session_ids: ['s1']
      }
    ], { granularity: 'turn' });

    expect(fixture.queries[0].expectedIds).toEqual(['q_003::session::s1::turn::1']);
    expect(fixture.memories).toEqual([
      {
        id: 'q_003::session::s1::turn::0',
        content: '[2026-01-01] session s1 turn 0\nuser: Noise turn.',
        sourceSessionId: 's1',
        sourceTurnIndex: 0,
        timestamp: '2026-01-01',
        metadata: { questionId: 'q_003', questionType: 'single-session-user' }
      },
      {
        id: 'q_003::session::s1::turn::1',
        content: '[2026-01-01] session s1 turn 1\nuser: I had bibimbap for lunch.',
        sourceSessionId: 's1',
        sourceTurnIndex: 1,
        timestamp: '2026-01-01',
        metadata: { questionId: 'q_003', questionType: 'single-session-user', hasAnswer: true }
      }
    ]);
  });

  it('adds answer-independent preference/user-fact expansion text when requested', () => {
    const fixture = longMemEvalEntriesToReplayFixture([
      {
        question_id: 'q_004',
        question_type: 'single-session-user',
        question: 'Which beverage does the user prefer?',
        answer: 'jasmine tea',
        haystack_session_ids: ['s1'],
        haystack_dates: ['2026-01-01'],
        haystack_sessions: [
          [
            { role: 'assistant', content: 'What should I keep in mind for afternoons?' },
            { role: 'user', content: 'For my afternoon routine, my go-to drink is jasmine tea.' }
          ]
        ],
        answer_session_ids: ['s1']
      }
    ], { expandUserFacts: true });

    expect(fixture.memories[0].content).toContain('Extracted user facts:');
    expect(fixture.memories[0].content).toContain('user preference');
    expect(fixture.memories[0].content).toContain('go-to drink is jasmine tea');
    expect(fixture.memories[0].metadata).toMatchObject({ userFactExpansion: true });
    expect(fixture.memories[0].content).not.toContain('Which beverage does the user prefer?');
  });
});
