import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatMemoryReferenceContext,
  memoryReferenceSummary,
  memoryReferenceTitle
} from '../../src/core/memory-reference-context.js';
import { sessionStartExcerpt } from '../../src/adapters/claude/hooks/session-start.js';
import { formatMemoryContext, selectEvidencePreview } from '../../src/adapters/claude/hooks/user-prompt-submit.js';
import type { EventType, MemoryEvent } from '../../src/core/types.js';

/**
 * Pins every excerpt path to its output from before
 * CLAUDE_MEMORY_IDENTIFIER_EXCERPT_EXPERIMENT existed. The snapshot was
 * recorded on the unchanged code; with the flag off it must never move.
 */
const FLAG = 'CLAUDE_MEMORY_IDENTIFIER_EXCERPT_EXPERIMENT';

const filler = '배포 전에 확인할 항목을 정리했고 세부 맥락을 길게 설명합니다. ';
const CORPUS: Record<string, string> = {
  short: 'Root cause: the outbox lock was never released.',
  koreanWithCodeBlock: [
    filler.repeat(6),
    '```bash',
    'git checkout -b feat/identifier-anchored-excerpts origin/main',
    'git cherry-pick 1faa18a && npm run verify',
    'vi src/core/memory-reference-context.ts',
    '```',
    `PR #116 머지 후 v2.4.17 배포를 확인했다. ${filler.repeat(3)}`
  ].join('\n'),
  identifiersAtEnd: `${'The sync worker pulled every document and the dashboard looked healthy. '.repeat(10)}`
    + 'Fixed in src/core/mongo-sync-worker.ts:117 (commit b107516, PR #116, branch fix/mongo-pull-cursor, v2.4.17).',
  secretsNearIdentifiers: `${filler.repeat(4)}api_key=example-key-value password: hunter2 `
    + `token=example-token-value then edited scripts/guard-release-artifact.cjs at 4424b42. ${filler.repeat(4)}`,
  noIdentifiers: 'This paragraph has no identifiers at all and simply keeps talking about plans. '.repeat(20),
  sessionSummary: [
    '- 결정: 세션 시작 주입은 agent_response 위주로 한다',
    '- 제약: 요약은 1개 슬롯만',
    `- 근거: ${filler.repeat(10)}`,
    '- 다음: tests/adapters/claude-hook-session-start.test.ts 보강, #57 후속'
  ].join('\n'),
  queryAnchored: `${filler.repeat(5)}TARGET_PORT 37803 에서 대시보드를 띄웠다. ${filler.repeat(5)} 끝으로 docs/architecture/mempalace-benchmarking-2026-10-31.md 를 갱신했다.`,
  privateTagged: `${filler.repeat(3)}<private>internal host db.internal:5432</private> 그리고 .github/workflows/publish-npm.yml 를 고쳤다. ${filler.repeat(6)}`
};

const QUERIES = ['', 'TARGET_PORT 대시보드', 'mongo sync 누락', 'PR 167 코드 리뷰 결론', '전혀 관련 없는 질문'];
const SESSION_START_TYPES: EventType[] = ['agent_response', 'session_summary', 'tool_observation'];

function event(eventType: EventType, content: string): MemoryEvent {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    eventType,
    sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
    timestamp: new Date('2026-10-31T03:04:05.000Z'),
    content,
    canonicalKey: 'key',
    dedupeKey: 'dedupe'
  };
}

function renderAll(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, content] of Object.entries(CORPUS)) {
    out[`${name} title`] = memoryReferenceTitle(content);
    for (const query of QUERIES) {
      out[`${name} summary q=${JSON.stringify(query)}`] = memoryReferenceSummary(content, query);
      out[`${name} evidence q=${JSON.stringify(query)}`] = selectEvidencePreview(content, query);
      out[`${name} evidence160 q=${JSON.stringify(query)}`] = selectEvidencePreview(content, query, 160);
    }
    for (const type of SESSION_START_TYPES) {
      out[`${name} session-start ${type}`] = sessionStartExcerpt(event(type, content));
    }
  }
  const items = Object.entries(CORPUS).map(([name, content]) => ({ id: `event-${name}`, type: 'agent_response', content }));
  out['reference context'] = formatMemoryReferenceContext(items, { heading: 'Memory index for this question', query: QUERIES[1] });
  out['evidence context'] = formatMemoryContext([...items, { id: 'lesson-1', type: 'lesson', content: CORPUS.noIdentifiers }], QUERIES[2]);
  return out;
}

describe(`${FLAG} off`, () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('renders every excerpt path exactly as before the experiment', () => {
    vi.stubEnv(FLAG, undefined);
    expect(renderAll()).toMatchSnapshot();
  });

  it.each([['1'], ['false'], ['TRUE'], ['']])('is byte-identical to unset when the flag is %j', (value) => {
    vi.stubEnv(FLAG, undefined);
    const unset = renderAll();
    vi.stubEnv(FLAG, value);
    const rendered = renderAll();
    for (const key of Object.keys(unset)) {
      expect(Buffer.from(rendered[key]).equals(Buffer.from(unset[key])), key).toBe(true);
    }
  });
});
