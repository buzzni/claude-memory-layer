import { describe, expect, it } from 'vitest';

import {
  classifyReaskOutcome,
  deriveTaskOutcome,
  parseToolOutcome
} from '../../src/core/usefulness-outcome-v2.js';

describe('usefulness outcome v2', () => {
  it('parses only explicit known tool success/failure schemas', () => {
    expect(parseToolOutcome('{"success":true}')).toBe('success');
    expect(parseToolOutcome({ ok: false })).toBe('failure');
    expect(parseToolOutcome({ isError: true })).toBe('failure');
    expect(parseToolOutcome({ status: 'completed' })).toBe('success');
    expect(parseToolOutcome('command printed some text')).toBe('unknown');
    expect(parseToolOutcome({ output: 'looks fine' })).toBe('unknown');
  });

  it('does not attribute tool success when memory adoption was not observed', () => {
    expect(deriveTaskOutcome('not_observed', ['success'])).toBe('unknown');
    expect(deriveTaskOutcome('grounded', ['unknown'])).toBe('unknown');
    expect(deriveTaskOutcome('grounded', ['success'])).toBe('success');
    expect(deriveTaskOutcome('navigated', ['success', 'failure'])).toBe('mixed');
  });

  it('separates clarification, repeated failure, and normal continuation', () => {
    expect(classifyReaskOutcome('deploy the service', ['Can you clarify which environment?'])).toBe('clarification');
    expect(classifyReaskOutcome('deploy the service', ['It still does not work; same error.'])).toBe('repeat_failure');
    expect(classifyReaskOutcome('deploy the service', ['Now deploy the service to staging'])).toBe('topic_continuation');
    expect(classifyReaskOutcome('deploy the service', [])).toBe('none');
    expect(classifyReaskOutcome(undefined, ['next'])).toBe('unknown');
  });
});
