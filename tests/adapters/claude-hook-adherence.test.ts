import { describe, expect, it } from 'vitest';
import {
  shouldRunMemorySearch,
  shouldRunAdherenceCheck,
  type AdherenceState,
} from '../../src/adapters/claude/hooks/user-prompt-submit.js';

function adherenceState(overrides: Partial<AdherenceState> = {}): AdherenceState {
  return {
    sessionId: 'session-test',
    turnCount: 1,
    lastCheckedTurn: 1,
    lastPrompt: '다음 단계 계획을 정리하고 진행 순서를 확인',
    lastReason: 'first-turn',
    updatedAt: '2026-05-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('Claude user prompt adherence trigger heuristics', () => {
  it('runs memory checks for short continuation prompts before the interval', () => {
    expect(
      shouldRunAdherenceCheck(
        2,
        '응 다음 단계 진행',
        adherenceState({ lastPrompt: '다음 단계 계획을 정리하고 진행 순서를 확인' })
      )
    ).toEqual({ run: true, reason: 'continuation-intent' });
  });

  it('runs memory checks for prior decision recall prompts', () => {
    expect(
      shouldRunAdherenceCheck(
        2,
        '전에 결정한 것 다시 알려줘',
        adherenceState({ lastPrompt: '전에 결정한 것을 정리해줘' })
      )
    ).toEqual({ run: true, reason: 'decision-recall' });
  });

  it('runs memory checks for project/code signals even when the prompt has no write verb', () => {
    expect(
      shouldRunAdherenceCheck(
        2,
        'tests/core/retriever.test.ts 실패 로그 다시 봐줘',
        adherenceState({ lastPrompt: 'tests/core/retriever.test.ts 실패 로그를 확인' })
      )
    ).toEqual({ run: true, reason: 'code-signal' });
  });

  it('still skips trivial same-topic prompts before the interval', () => {
    expect(
      shouldRunAdherenceCheck(
        2,
        '상태 확인만 해줘',
        adherenceState({ lastPrompt: '상태 확인만 해줘' })
      )
    ).toEqual({ run: false, reason: 'skip' });
  });

  it('does not treat every Korean "다음" mention as continuation intent', () => {
    expect(
      shouldRunAdherenceCheck(
        2,
        '다음 주 회의 알려줘',
        adherenceState({ lastPrompt: '다음 주 회의 알려줘' })
      )
    ).toEqual({ run: false, reason: 'skip' });
  });

  it('allows very short continuation prompts to search once the trigger fires', () => {
    expect(shouldRunMemorySearch('계속', { run: true, reason: 'continuation-intent' })).toBe(true);
    expect(shouldRunMemorySearch('/help', { run: true, reason: 'continuation-intent' })).toBe(false);
    expect(shouldRunMemorySearch('응', { run: false, reason: 'skip' })).toBe(false);
  });

  it('keeps very short first-turn non-intent prompts behind the length gate', () => {
    expect(shouldRunMemorySearch('응', { run: true, reason: 'first-turn' })).toBe(false);
  });

  it('classifies short first-turn continuation prompts by intent so they can search', () => {
    const decision = shouldRunAdherenceCheck(1, '계속', adherenceState({ turnCount: 0, lastPrompt: '' }));

    expect(decision).toEqual({ run: true, reason: 'continuation-intent' });
    expect(shouldRunMemorySearch('계속', decision)).toBe(true);
  });

  it('does not treat leading absolute project paths as slash commands', () => {
    const prompt = '/Users/example/project/src/core/retriever.ts 테스트 실패';

    expect(
      shouldRunAdherenceCheck(2, prompt, adherenceState({ lastPrompt: '같은 파일 테스트 확인' }))
    ).toEqual({ run: true, reason: 'code-signal' });
    expect(shouldRunMemorySearch(prompt, { run: true, reason: 'code-signal' })).toBe(true);
    expect(shouldRunMemorySearch('/help', { run: true, reason: 'continuation-intent' })).toBe(false);
  });
});
