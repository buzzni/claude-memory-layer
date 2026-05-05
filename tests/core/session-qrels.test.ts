import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  buildSessionQrelsFixtureFromJsonl,
  collectClaudeSessionJsonlFiles,
  summarizeSessionQrelsFixture
} from '../../src/core/session-qrels.js';

describe('session qrels fixture generation', () => {
  it('turns Claude-style user/assistant session turns into replay qrels', () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        sessionId: 's1',
        message: { role: 'user', content: 'retrieval benchmark should report nDCG and precision together' },
        timestamp: '2026-05-05T00:00:00.000Z'
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Use graded relevance qrels and report nDCG@k beside Precision@k and Recall@k.' }] },
        timestamp: '2026-05-05T00:01:00.000Z'
      }),
      JSON.stringify({
        type: 'user',
        sessionId: 's1',
        message: { role: 'user', content: '<command-name>/model</command-name>\n<local-command-stdout>opus</local-command-stdout>' }
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        message: { role: 'assistant', content: 'This local command result must not become a benchmark qrel.' }
      }),
      JSON.stringify({
        type: 'user',
        sessionId: 's1',
        message: { role: 'user', content: [{ type: 'text', text: 'fast search CLI should avoid embedding startup for qrels smoke tests' }] }
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        message: { role: 'assistant', content: 'Fast search benchmark fixtures should stay lightweight and deterministic.' }
      })
    ].join('\n');

    const fixture = buildSessionQrelsFixtureFromJsonl(jsonl, {
      name: 'session-qrels-test',
      ks: [1, 3]
    });

    expect(fixture.name).toBe('session-qrels-test');
    expect(fixture.ks).toEqual([1, 3]);
    expect(fixture.queries).toHaveLength(2);
    expect(fixture.memories).toHaveLength(2);
    expect(fixture.queries[0]).toMatchObject({
      queryId: 'q-s1-1',
      query: 'retrieval benchmark should report nDCG and precision together',
      expectedIds: ['m-s1-1'],
      expectedRelevance: { 'm-s1-1': 2 }
    });
    expect(fixture.memories[0]).toMatchObject({
      id: 'm-s1-1',
      content: 'Use graded relevance qrels and report nDCG@k beside Precision@k and Recall@k.',
      sourceSessionId: 's1'
    });
    expect(fixture.queries.map((query) => query.query)).not.toContain('opus');
  });

  it('pairs pending prompts independently per session id', () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        sessionId: 's1',
        message: { role: 'user', content: 'session one asks about retrieval replay metrics' }
      }),
      JSON.stringify({
        type: 'user',
        sessionId: 's2',
        message: { role: 'user', content: 'session two asks about qrels generation safety' }
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        message: { role: 'assistant', content: 'Session one answer explains nDCG replay metrics.' }
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 's2',
        message: { role: 'assistant', content: 'Session two answer explains qrels generation safety.' }
      })
    ].join('\n');

    const fixture = buildSessionQrelsFixtureFromJsonl(jsonl);

    expect(fixture.queries.map((query) => [query.queryId, query.query])).toEqual([
      ['q-s1-1', 'session one asks about retrieval replay metrics'],
      ['q-s2-1', 'session two asks about qrels generation safety']
    ]);
    expect(fixture.memories.map((memory) => [memory.id, memory.content])).toEqual([
      ['m-s1-1', 'Session one answer explains nDCG replay metrics.'],
      ['m-s2-1', 'Session two answer explains qrels generation safety.']
    ]);
  });

  it('adds known-answer labels and explicit no-match qrels', () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        sessionId: 's-known',
        message: { role: 'user', content: 'how should replay qrels record known answer fixtures' }
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 's-known',
        message: { role: 'assistant', content: 'Known-answer qrels should keep the expected assistant answer tied to the expected memory id.' }
      })
    ].join('\n');

    const fixture = buildSessionQrelsFixtureFromJsonl(jsonl, {
      noMatchQueries: [
        {
          queryId: 'q-negative-empty-result',
          query: 'unanswered moon cheese deployment question',
          forbiddenIds: ['m-s-known-1'],
          sourceSessionId: 's-known'
        }
      ]
    });

    expect(fixture.queries).toHaveLength(2);
    expect(fixture.queries[0]).toMatchObject({
      queryId: 'q-s-known-1',
      expectation: 'match',
      expectedIds: ['m-s-known-1'],
      knownAnswer: 'Known-answer qrels should keep the expected assistant answer tied to the expected memory id.'
    });
    expect(fixture.queries[1]).toMatchObject({
      queryId: 'q-negative-empty-result',
      query: 'unanswered moon cheese deployment question',
      expectation: 'no_match',
      expectedIds: [],
      expectedRelevance: {},
      forbiddenIds: ['m-s-known-1'],
      sourceSessionId: 's-known'
    });

    const summary = summarizeSessionQrelsFixture(fixture);
    expect(summary).toMatchObject({
      queryCount: 2,
      positiveQueryCount: 1,
      noMatchQueryCount: 1,
      knownAnswerCount: 1
    });
  });

  it('can redact raw session text when generating shareable qrels metadata', () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        sessionId: 'sensitive',
        message: { role: 'user', content: 'SECRET customer project prompt should not leak' }
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sensitive',
        message: { role: 'assistant', content: 'SECRET implementation answer should not leak' }
      })
    ].join('\n');

    const fixture = buildSessionQrelsFixtureFromJsonl(jsonl, { redactContent: true });
    const serialized = JSON.stringify(fixture);

    expect(serialized).not.toContain('SECRET');
    expect(fixture.queries[0]).toMatchObject({
      queryId: 'q-sensitive-1',
      query: '[redacted query q-sensitive-1]',
      expectedIds: ['m-sensitive-1']
    });
    expect(fixture.memories[0]).toMatchObject({
      id: 'm-sensitive-1',
      content: '[redacted memory m-sensitive-1]'
    });
  });

  it('summarizes generated qrels without leaking raw prompt or memory content', () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        sessionId: 'sensitive',
        message: { role: 'user', content: 'SECRET customer retrieval question with enough words' }
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sensitive',
        message: { role: 'assistant', content: 'SECRET assistant answer that should stay out of reports' }
      })
    ].join('\n');
    const fixture = buildSessionQrelsFixtureFromJsonl(jsonl, {
      name: 'private-real-session-qrels',
      ks: [1, 3, 10],
      sourceFileCount: 2,
      rawContentIncluded: true
    });

    const summary = summarizeSessionQrelsFixture(fixture);
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      name: 'private-real-session-qrels',
      queryCount: 1,
      memoryCount: 1,
      sourceSessionCount: 1,
      sourceFileCount: 2,
      rawContentIncluded: true,
      ks: [1, 3, 10]
    });
    expect(summary.perSession).toEqual([
      {
        sourceSessionId: 'sensitive',
        queryCount: 1,
        memoryCount: 1,
        firstTurnIndex: 1,
        lastTurnIndex: 1
      }
    ]);
    expect(serialized).not.toContain('SECRET');
  });

  it('collects Claude JSONL sessions recursively while excluding subagents by default', async () => {
    const root = path.join(tmpdir(), `session-qrels-${process.pid}-${Date.now()}`);
    const projectDir = path.join(root, 'project-a');
    const subagentDir = path.join(projectDir, 'subagents');
    await mkdir(subagentDir, { recursive: true });
    await writeFile(path.join(projectDir, 'top.jsonl'), '{}\n', 'utf8');
    await writeFile(path.join(subagentDir, 'agent.jsonl'), '{}\n', 'utf8');
    await writeFile(path.join(projectDir, 'notes.txt'), 'ignore', 'utf8');

    await expect(collectClaudeSessionJsonlFiles(root)).resolves.toEqual([
      path.join(projectDir, 'top.jsonl')
    ]);
    await expect(collectClaudeSessionJsonlFiles(root, { includeSubagents: true })).resolves.toEqual([
      path.join(subagentDir, 'agent.jsonl'),
      path.join(projectDir, 'top.jsonl')
    ]);
  });
});
