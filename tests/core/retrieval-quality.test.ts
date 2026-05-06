import { describe, expect, it } from 'vitest';
import {
  isGenericContinuationQuery,
  isLowSignalContextContent
} from '../../src/core/retrieval-quality.js';

describe('retrieval quality guards', () => {
  it('recognizes short generic continuation prompts', () => {
    expect(isGenericContinuationQuery('continue')).toBe(true);
    expect(isGenericContinuationQuery('what next?')).toBe(true);
    expect(isGenericContinuationQuery('다음 추천작업은 뭐야?')).toBe(true);
    expect(isGenericContinuationQuery('이어서 진행해줘')).toBe(true);
  });

  it('does not classify topic-specific next/recommendation/debug prompts as generic', () => {
    expect(isGenericContinuationQuery('next task for search UI')).toBe(false);
    expect(isGenericContinuationQuery('recommendation for auth design')).toBe(false);
    expect(isGenericContinuationQuery('이 오류 뭐야?')).toBe(false);
    expect(isGenericContinuationQuery('다음 작업은 retrieval-quality.ts에서 뭐야?')).toBe(false);
  });

  it('detects low-signal context artifacts', () => {
    expect(isLowSignalContextContent('<environment_context><cwd>/repo/app</cwd></environment_context>')).toBe(true);
    expect(isLowSignalContextContent('prefix <environment_context><cwd>/repo/app</cwd></environment_context> suffix')).toBe(true);
    expect(isLowSignalContextContent('<command-name>/model</command-name>\n<local-command-stdout>opus</local-command-stdout>')).toBe(true);
    expect(isLowSignalContextContent('# AGENTS.md instructions for /repo/app <INSTRUCTIONS> ## Skills A skill is local instructions.')).toBe(true);
    expect(isLowSignalContextContent('Understood, stopping here. Let me know when you would like to continue with the design doc review.')).toBe(true);
    expect(isLowSignalContextContent('Implementation note: suppress the stale phrase "Understood, stopping here. Let me know when you would like to continue." from context packs.')).toBe(false);
    expect(isLowSignalContextContent('Merged PR #15 and synced local main.')).toBe(false);
  });
});
