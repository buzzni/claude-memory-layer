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

  it('can add user-fact expansion only to private searchContent while preserving reader content', () => {
    const fixture = longMemEvalEntriesToReplayFixture([
      {
        question_id: 'q_004_key',
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
    ], { expandUserFactsToSearchContent: true });

    expect(fixture.memories[0].content).toBe(
      '[2026-01-01] session s1\nassistant: What should I keep in mind for afternoons?\nuser: For my afternoon routine, my go-to drink is jasmine tea.'
    );
    expect(fixture.memories[0].content).not.toContain('Extracted user facts:');
    expect(fixture.memories[0].searchContent).toContain('Extracted user facts:');
    expect(fixture.memories[0].searchContent).toContain('user preference: go-to drink is jasmine tea');
    expect(fixture.memories[0].metadata).toMatchObject({ userFactSearchExpansion: true });
    expect(fixture.metadata).toMatchObject({ userFactSearchExpansion: true });
  });

  it('expands only preference-category benchmark queries without leaking known answers', () => {
    const fixture = longMemEvalEntriesToReplayFixture([
      {
        question_id: 'q_pref',
        question_type: 'single-session-preference',
        question: 'Can you suggest accessories that complement my current photography setup?',
        answer: 'Sony-compatible photography accessories',
        haystack_session_ids: ['s1'],
        haystack_dates: ['2026-01-02'],
        haystack_sessions: [[{ role: 'user', content: "I'm looking to upgrade my camera flash." }]],
        answer_session_ids: ['s1']
      },
      {
        question_id: 'q_user',
        question_type: 'single-session-user',
        question: 'Which beverage does the user prefer?',
        answer: 'jasmine tea',
        haystack_session_ids: ['s2'],
        haystack_dates: ['2026-01-03'],
        haystack_sessions: [[{ role: 'user', content: 'I prefer jasmine tea.' }]],
        answer_session_ids: ['s2']
      }
    ], { expandPreferenceQueries: true });

    expect(fixture.queries[0].query).toBe(
      'Can you suggest accessories that complement my current photography setup? user preference personal context interests goals prior details'
    );
    expect(fixture.queries[0].query).not.toContain('Sony-compatible photography accessories');
    expect(fixture.queries[1].query).toBe('Which beverage does the user prefer?');
    expect(fixture.metadata).toMatchObject({ preferenceQueryExpansion: true });
  });

  it('expands temporal benchmark queries with question date and relation hints without leaking answers', () => {
    const fixture = longMemEvalEntriesToReplayFixture([
      {
        question_id: 'q_temporal',
        question_type: 'temporal-reasoning',
        question: 'How many days passed between my visit to the museum and the exhibit at the Met?',
        answer: '12 days',
        question_date: '2023/02/01 (Wed) 10:20',
        haystack_session_ids: ['s1'],
        haystack_dates: ['2023/01/20 (Fri) 09:00'],
        haystack_sessions: [[{ role: 'user', content: 'I visited the museum.' }]],
        answer_session_ids: ['s1']
      },
      {
        question_id: 'q_user',
        question_type: 'single-session-user',
        question: 'Which beverage does the user prefer?',
        answer: 'jasmine tea',
        question_date: '2023/02/01 (Wed) 10:20',
        haystack_session_ids: ['s2'],
        haystack_dates: ['2023/01/22 (Sun) 12:00'],
        haystack_sessions: [[{ role: 'user', content: 'I prefer jasmine tea.' }]],
        answer_session_ids: ['s2']
      }
    ], { expandTemporalQueries: true });

    expect(fixture.queries[0].query).toBe(
      'How many days passed between my visit to the museum and the exhibit at the Met? question date 2023-02-01 temporal order before after earlier later elapsed days weeks months ago latest earliest timeline'
    );
    expect(fixture.queries[0].query).not.toContain('12 days');
    expect(fixture.queries[1].query).toBe('Which beverage does the user prefer?');
    expect(fixture.metadata).toMatchObject({ temporalQueryExpansion: true });
  });

  it('adds temporal date-boost metadata without appending lexical date tokens to the query', () => {
    const fixture = longMemEvalEntriesToReplayFixture([
      {
        question_id: 'q_temporal_boost',
        question_type: 'temporal-reasoning',
        question: 'What did I do 12 days ago at the museum exhibit?',
        answer: 'attended the museum exhibit',
        question_date: '2023/02/01 (Wed) 10:20',
        haystack_session_ids: ['s_noise', 's_answer'],
        haystack_dates: ['2023/01/20 (Fri) 09:00', '2023/01/20 (Fri) 13:00'],
        haystack_sessions: [
          [{ role: 'user', content: 'I renewed my passport and checked my calendar.' }],
          [{ role: 'user', content: 'I attended the museum exhibit with Maya.' }]
        ],
        answer_session_ids: ['s_answer']
      }
    ], { temporalDateBoost: true });

    expect(fixture.queries[0].query).toBe('What did I do 12 days ago at the museum exhibit?');
    expect(fixture.queries[0].query).not.toContain('question date');
    expect(fixture.queries[0].query).not.toContain('2023-02-01');
    expect(fixture.queries[0].temporalDateBoost).toMatchObject({
      referenceDate: '2023-02-01',
      targetDate: '2023-01-20',
      toleranceDays: 1,
      entityTerms: expect.arrayContaining(['museum', 'exhibit'])
    });
    expect(fixture.metadata).toMatchObject({ temporalDateBoost: true });
  });

  it('extracts preference-category user goals and personal context beyond direct like/prefer phrasing', () => {
    const fixture = longMemEvalEntriesToReplayFixture([
      {
        question_id: 'q_005',
        question_type: 'single-session-preference',
        question: 'Can you suggest accessories that complement my current photography setup?',
        answer: 'Sony-compatible photography accessories',
        haystack_session_ids: ['s1'],
        haystack_dates: ['2026-01-02'],
        haystack_sessions: [
          [
            { role: 'user', content: "I'm looking to upgrade my camera flash. Can you recommend good options that are compatible with my Sony A7R IV?" },
            { role: 'user', content: "I'm looking for some help with finding a good resort in Hawaii for a family vacation." },
            { role: 'user', content: 'Besides great views, I also like hotels with unique features, such as a rooftop pool.' },
            { role: 'user', content: "I'm trying to learn advanced settings for video editing with Adobe Premiere Pro, which I enjoy to use." },
            { role: 'user', content: "I've been using basil and mint in my cooking lately and harvested cherry tomatoes from my garden." }
          ]
        ],
        answer_session_ids: ['s1']
      }
    ], { expandUserFacts: true });

    const content = fixture.memories[0].content;
    expect(content).toContain('Extracted user facts:');
    expect(content).toContain('user goal: looking to upgrade my camera flash');
    expect(content).not.toContain('user goal: looking for some help with finding a good resort in Hawaii for a family vacation');
    expect(content).not.toContain('user goal: interested in good options that are compatible with my Sony A7R IV');
    expect(content).toContain('user preference: prefers hotels with unique features, such as a rooftop pool');
    expect(content).toContain('user preference: enjoys using advanced settings for video editing with Adobe Premiere Pro');
    expect(content).not.toContain('user goal: trying to learn advanced settings for video editing with Adobe Premiere Pro, which I enjoy to use');
    expect(content).toContain('user context: has been using basil and mint in my cooking lately and harvested cherry tomatoes from my garden');
    expect(fixture.memories[0].metadata).toMatchObject({ userFactExpansion: true });
    expect(content).not.toContain('Can you suggest accessories that complement my current photography setup?');
  });
});
