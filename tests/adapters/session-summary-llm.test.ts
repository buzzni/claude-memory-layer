import { describe, expect, it } from 'vitest';

import {
  NO_DURABLE_CONTENT,
  buildSummaryPrompt,
  classifySummaryFailure,
  getSummaryProviderName,
  isLlmSummaryEnabled,
  normalizeSummaryOutput
} from '../../src/adapters/llm/session-summary-llm.js';

describe('session summary llm provider', () => {
  it('excludes tool observations from the summary input', () => {
    const prompt = buildSummaryPrompt([
      { eventType: 'user_prompt', content: '자동 업데이트가 왜 안 보이지' },
      { eventType: 'tool_observation', content: '{"toolName":"Bash","toolOutput":"npm run build ok"}' },
      { eventType: 'agent_response', content: 'publish 설정 누락이 원인이었다' }
    ]);

    expect(prompt).toContain('자동 업데이트가 왜 안 보이지');
    expect(prompt).toContain('publish 설정 누락이 원인이었다');
    expect(prompt).not.toContain('toolName');
    expect(prompt).not.toContain('npm run build ok');
  });

  it('abstains when a session has too little conversation to summarize', () => {
    expect(buildSummaryPrompt([{ eventType: 'user_prompt', content: '안녕' }])).toBeNull();
    expect(buildSummaryPrompt([
      { eventType: 'tool_observation', content: 'a' },
      { eventType: 'tool_observation', content: 'b' }
    ])).toBeNull();
  });

  it('treats the no-durable-content marker as "store nothing"', () => {
    expect(normalizeSummaryOutput(NO_DURABLE_CONTENT)).toBeNull();
    expect(normalizeSummaryOutput(`  ${NO_DURABLE_CONTENT}\n`)).toBeNull();
    expect(normalizeSummaryOutput('')).toBeNull();
  });

  it('keeps only bullet lines so a chatty preamble cannot become the summary', () => {
    const output = normalizeSummaryOutput([
      '알겠습니다! 요약해 드리겠습니다.',
      '',
      '- 결정: publish 설정을 electron-builder.yml 에 추가하기로 함',
      '* 실패: arm64 전용 빌드는 intel 에서 채널이 비어 있었음',
      '',
      '도움이 되었기를 바랍니다.'
    ].join('\n'));

    expect(output).toBe([
      '- 결정: publish 설정을 electron-builder.yml 에 추가하기로 함',
      '- 실패: arm64 전용 빌드는 intel 에서 채널이 비어 있었음'
    ].join('\n'));
  });

  it('returns null when the model answered without any bullet content', () => {
    expect(normalizeSummaryOutput('이 세션에는 특별한 내용이 없었습니다.')).toBeNull();
  });

  it('caps the summary at five bullets', () => {
    const output = normalizeSummaryOutput(
      Array.from({ length: 9 }, (_, index) => `- 결정 ${index}`).join('\n')
    );
    expect(output?.split('\n')).toHaveLength(5);
  });

  it('classifies provider failures so callers can distinguish retryable causes', () => {
    expect(classifySummaryFailure('ENOENT not found').code).toBe('provider-not-found');
    expect(classifySummaryFailure('timed out').code).toBe('provider-timeout');
    expect(classifySummaryFailure('invalid credential').code).toBe('provider-auth');
    expect(classifySummaryFailure('boom').code).toBe('provider-error');
  });

  it('honours provider and mode configuration', () => {
    expect(getSummaryProviderName({} as NodeJS.ProcessEnv)).toBe('claude');
    expect(getSummaryProviderName({ CLAUDE_MEMORY_SUMMARY_PROVIDER: 'codex' } as NodeJS.ProcessEnv)).toBe('codex');
    expect(isLlmSummaryEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isLlmSummaryEnabled({ CLAUDE_MEMORY_SUMMARY_MODE: 'rule' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isLlmSummaryEnabled({ CLAUDE_MEMORY_SUMMARY_MODE: 'off' } as NodeJS.ProcessEnv)).toBe(false);
  });
});
