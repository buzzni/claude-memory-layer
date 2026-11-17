import { describe, expect, it } from 'vitest';

import { evaluateReplayFixture, type ReplayEvaluationFixture } from '../../src/core/replay-evaluator.js';
import { createGrepRunner, grepRank, grepTerms, haystackLengths, maskSessionHeader } from '../../benchmarks/public/grep-baseline.js';

const fixture = (memories: ReplayEvaluationFixture['memories'], queries: ReplayEvaluationFixture['queries']): ReplayEvaluationFixture => ({
  name: 'grep-test',
  ks: [1, 3],
  queries,
  memories
});

const retrieve = async (data: ReplayEvaluationFixture, queryIndex = 0) => {
  const query = data.queries[queryIndex];
  return createGrepRunner(data)(query.query, { fixture: data, query, topK: 3, retrievalOptions: {} });
};

describe('grep baseline', () => {
  it('drops stopwords, one-character words and repeats from the query terms', () => {
    expect(grepTerms('What is the SQLite WAL mode? a sqlite 모드')).toEqual(['sqlite', 'wal', 'mode', '모드']);
  });

  it('ranks memories by how many distinct query terms they contain, case-insensitively, keeping fixture order on ties', async () => {
    const data = fixture(
      [
        { id: 'one-term', content: 'Enabled WAL on the database.' },
        { id: 'none', content: 'Unrelated note about lunch.' },
        { id: 'two-terms', content: 'sqlite now runs in wal mode' },
        { id: 'one-term-later', content: 'The SQLite file moved.' }
      ],
      [{ queryId: 'q', query: 'sqlite wal', expectedIds: ['two-terms'] }]
    );

    expect(await retrieve(data)).toEqual({ retrievedIds: ['two-terms', 'one-term', 'one-term-later'], confidence: 'high' });
  });

  it('matches substrings the way grep does and prefers searchContent over content', async () => {
    const data = fixture(
      [
        { id: 'prefix', content: 'migrations ran' },
        { id: 'search-content', content: 'no match here', searchContent: 'migration plan' }
      ],
      [{ queryId: 'q', query: 'migration', expectedIds: ['prefix'] }]
    );

    expect((await retrieve(data)).retrievedIds).toEqual(['prefix', 'search-content']);
  });

  it('returns nothing with no confidence when no term matches', async () => {
    const data = fixture([{ id: 'm', content: 'database' }], [{ queryId: 'q', query: 'the kubernetes', expectedIds: [] }]);

    expect(await retrieve(data)).toEqual({ retrievedIds: [], confidence: 'none' });
  });

  it("searches only the question's own haystack when memories carry a questionId", async () => {
    const data = fixture(
      [
        { id: 'other', content: 'deploy notes', metadata: { questionId: 'q2' } },
        { id: 'own', content: 'deploy checklist', metadata: { questionId: 'q1' } }
      ],
      [
        { queryId: 'q1', query: 'deploy', expectedIds: ['own'] },
        { queryId: 'q2', query: 'deploy', expectedIds: ['other'] }
      ]
    );

    expect((await retrieve(data, 0)).retrievedIds).toEqual(['own']);
    expect((await retrieve(data, 1)).retrievedIds).toEqual(['other']);
  });

  it('ranks a plain document list the same way, for harnesses that hold their own corpus', () => {
    const docs = [
      { id: 'one', text: 'wal enabled' },
      { id: 'none', text: 'lunch' },
      { id: 'two', text: 'sqlite in wal mode' }
    ];

    expect(grepRank('SQLite WAL', docs, 10)).toEqual(['two', 'one']);
    expect(grepRank('SQLite WAL', docs, 1)).toEqual(['two']);
  });

  it('masks only the session id in a converted LongMemEval header', () => {
    expect(maskSessionHeader('[2023/05/20 (Sat) 02:21] session answer_280352e9\nuser: answer me'))
      .toBe('[2023/05/20 (Sat) 02:21] session #\nuser: answer me');
    expect(maskSessionHeader('session answer_1 turn 3\nuser: hi')).toBe('session # turn 3\nuser: hi');
    expect(maskSessionHeader('user: my session ended')).toBe('user: my session ended');
  });

  it('can score with the session headers masked', async () => {
    const data = fixture(
      [
        { id: 'evidence', content: 'session answer_1\nuser: hello' },
        { id: 'other', content: 'session other_2\nuser: hello' }
      ],
      [{ queryId: 'q', query: 'answer', expectedIds: ['evidence'] }]
    );
    const query = data.queries[0];

    expect((await createGrepRunner(data)(query.query, { fixture: data, query, topK: 3, retrievalOptions: {} })).retrievedIds).toEqual(['evidence']);
    expect((await createGrepRunner(data, { maskSessionHeader: true })(query.query, { fixture: data, query, topK: 3, retrievalOptions: {} })).retrievedIds).toEqual([]);
  });

  it('reports the median scored length of evidence and other memories', () => {
    const data = fixture(
      [
        { id: 'e1', content: 'aaaa' },
        { id: 'e2', content: 'aaaaaa', searchContent: 'aaaaaaaa' },
        { id: 'o1', content: 'aa' },
        { id: 'o2', content: 'aaa' },
        { id: 'o3', content: 'a' }
      ],
      [{ queryId: 'q', query: 'x', expectedIds: ['e1', 'e2'] }]
    );

    expect(haystackLengths(data)).toEqual({ evidence: { count: 2, medianChars: 6 }, other: { count: 3, medianChars: 2 } });
  });

  it('scores through the replay evaluator, so its metrics use the same definitions as the replay runs', async () => {
    const data = fixture(
      [
        { id: 'a', content: 'sqlite wal' },
        { id: 'b', content: 'sqlite' }
      ],
      [{ queryId: 'q', query: 'sqlite wal', expectedIds: ['b'] }]
    );

    const report = await evaluateReplayFixture(data, { retrievalRunner: createGrepRunner(data) });

    expect(report.summary.recallAtK[1]).toBe(0);
    expect(report.summary.recallAtK[3]).toBe(1);
  });
});
