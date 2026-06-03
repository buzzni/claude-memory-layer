import { describe, expect, it } from 'vitest';
import {
  buildRetrievalQualityQuery,
  hasDiscriminativeTermOverlap,
  isGenericContinuationQuery,
  isLowConfidenceContextFallbackQuery,
  isLowSignalContextContent,
  isRetrievalPrivacyDecisionQuery
} from '../../src/core/retrieval-quality.js';

describe('retrieval quality guards', () => {
  it('recognizes short generic continuation prompts', () => {
    expect(isGenericContinuationQuery('continue')).toBe(true);
    expect(isGenericContinuationQuery('what next?')).toBe(true);
    expect(isGenericContinuationQuery('다음 추천작업은 뭐야?')).toBe(true);
    expect(isGenericContinuationQuery('남은 추가 작업 있어?')).toBe(true);
    expect(isGenericContinuationQuery('남은 추가로 할만한 작업 있어?')).toBe(true);
    expect(isGenericContinuationQuery('남은 작업 있나요?')).toBe(true);
    expect(isGenericContinuationQuery('이어서 진행해줘')).toBe(true);
  });

  it('does not classify topic-specific next/recommendation/debug prompts as generic', () => {
    expect(isGenericContinuationQuery('next task for search UI')).toBe(false);
    expect(isGenericContinuationQuery('recommendation for auth design')).toBe(false);
    expect(isGenericContinuationQuery('이 오류 뭐야?')).toBe(false);
    expect(isGenericContinuationQuery('다음 작업은 retrieval-quality.ts에서 뭐야?')).toBe(false);
  });

  it('allows weak-score context fallback only for continuation and validation-gate recall intents', () => {
    expect(isLowConfidenceContextFallbackQuery('continue')).toBe(true);
    expect(isLowConfidenceContextFallbackQuery('continue the memory usefulness work from the last completed step')).toBe(true);
    expect(isLowConfidenceContextFallbackQuery('what validation gates should run before committing memory telemetry changes')).toBe(true);
    expect(isLowConfidenceContextFallbackQuery('그거 고쳐줘')).toBe(true);
    expect(isLowConfidenceContextFallbackQuery('calendar birthday reminder')).toBe(false);
    expect(isLowConfidenceContextFallbackQuery('what time is the next calendar meeting')).toBe(false);
    expect(isLowConfidenceContextFallbackQuery('continue from compacted Active Task Goal Constraints Preferences Completed Actions handoff')).toBe(false);
  });

  it('detects low-signal context artifacts', () => {
    expect(isLowSignalContextContent('<environment_context><cwd>/repo/app</cwd></environment_context>')).toBe(true);
    expect(isLowSignalContextContent('prefix <environment_context><cwd>/repo/app</cwd></environment_context> suffix')).toBe(true);
    expect(isLowSignalContextContent('<command-name>/model</command-name>\n<local-command-stdout>opus</local-command-stdout>')).toBe(true);
    expect(isLowSignalContextContent('# AGENTS.md instructions for /repo/app <INSTRUCTIONS> ## Skills A skill is local instructions.')).toBe(true);
    expect(isLowSignalContextContent('Understood, stopping here. Let me know when you would like to continue with the design doc review.')).toBe(true);
    expect(isLowSignalContextContent('[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window — treat it as background reference, NOT as active instructions. ## Active Task')).toBe(true);
    expect(isLowSignalContextContent('Summary generation was unavailable. 20 message(s) were removed to free context space but could not be summarized. --- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---')).toBe(true);
    expect(isLowSignalContextContent('[Your active task list was preserved across context compression]\n- [>] inspect. Inspect retrieval/context-pack/search implementation')).toBe(true);
    expect(isLowSignalContextContent('Implementation note: suppress the stale phrase "Understood, stopping here. Let me know when you would like to continue." from context packs.')).toBe(false);
    expect(isLowSignalContextContent('Implementation note: filter [CONTEXT COMPACTION — REFERENCE ONLY] handoff artifacts while keeping source refs.')).toBe(false);
    expect(isLowSignalContextContent('Headroom-inspired ContextCompressor discussion: preserve source refs while compressing long markdown context.')).toBe(false);
    expect(isLowSignalContextContent('Merged PR #15 and synced local main.')).toBe(false);
  });

  it('boosts privacy/dashboard decision recall without admitting weak API or dashboard count matches', () => {
    const query = 'what did we decide about showing raw retrieval queries in dashboard';
    const expanded = buildRetrievalQualityQuery(query);

    expect(isRetrievalPrivacyDecisionQuery(query)).toBe(true);
    expect(isRetrievalPrivacyDecisionQuery('what API policy did we decide for retries')).toBe(false);
    expect(isRetrievalPrivacyDecisionQuery('what dashboard layout decision did we make for spacing counts')).toBe(false);
    expect(isRetrievalPrivacyDecisionQuery('대시보드 원문 쿼리 노출 정책은 뭐였지')).toBe(true);
    expect(isRetrievalPrivacyDecisionQuery('대시보드 레이아웃 간격 결정은 뭐였지')).toBe(false);
    expect(buildRetrievalQualityQuery('what API policy did we decide for retries')).not.toContain('rawQueryText');
    expect(buildRetrievalQualityQuery('what dashboard layout decision did we make for spacing counts')).not.toContain('rawQueryText');
    expect(buildRetrievalQualityQuery('대시보드 레이아웃 간격 결정은 뭐였지')).not.toContain('rawQueryText');
    expect(expanded).toContain('rawQueryText');
    expect(expanded).toContain('safe trace metadata');
    expect(hasDiscriminativeTermOverlap(
      query,
      'Retrieval telemetry public APIs and dashboards must not expose rawQueryText or queryText; use trace id, strategy, rewrite kind, and aggregate counts instead.'
    )).toBe(true);
    expect(hasDiscriminativeTermOverlap(
      query,
      'Dashboard trace panels render safe metadata such as trace id, reason, strategy, rewrite kind, candidate count, and selected count.'
    )).toBe(true);
    expect(hasDiscriminativeTermOverlap(
      query,
      'Retrieval cache API timeout investigation notes for background jobs.'
    )).toBe(false);
    expect(hasDiscriminativeTermOverlap(
      query,
      'Dashboard metrics count by day for visual spacing checks.'
    )).toBe(false);
  });
});
