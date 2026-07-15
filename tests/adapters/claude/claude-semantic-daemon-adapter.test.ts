import { describe, expect, it } from 'vitest';
import {
  handleSemanticDaemonRequest,
  isValidSemanticDaemonRequest,
  isVectorSessionFilterError,
  makeSemanticDaemonErrorResponse,
  parseSemanticDaemonRequest
} from '../../../src/adapters/claude/hooks/semantic-daemon.js';

describe('Claude semantic daemon adapter', () => {
  it('parses JSON requests and treats malformed payloads as empty requests', () => {
    expect(parseSemanticDaemonRequest('{"type":"retrieve","sessionId":"s1"}')).toEqual({
      type: 'retrieve',
      sessionId: 's1'
    });
    expect(parseSemanticDaemonRequest('{not-json')).toEqual({});
  });

  it('validates retrieve requests before touching MemoryService', () => {
    expect(isValidSemanticDaemonRequest({
      type: 'retrieve',
      sessionId: 'session-1',
      prompt: 'find checkout fix',
      topK: 5,
      minScore: 0.2
    })).toBe(true);

    expect(isValidSemanticDaemonRequest({
      type: 'retrieve',
      sessionId: 'session-1',
      prompt: 'find checkout fix',
      topK: Number.NaN,
      minScore: 0.2
    })).toBe(false);

    expect(isValidSemanticDaemonRequest({
      type: 'graduate',
      sessionId: 'session-1'
    })).toBe(true);
    expect(isValidSemanticDaemonRequest({
      type: 'graduate',
      sessionId: ''
    })).toBe(false);
  });

  it('returns a deterministic invalid request response without initializing retrieval', async () => {
    await expect(handleSemanticDaemonRequest('{"type":"retrieve"}')).resolves.toEqual({
      ok: false,
      error: 'invalid request'
    });
  });

  it('detects LanceDB sessionId field-case filter failures', () => {
    expect(isVectorSessionFilterError(new Error('No field named sessionId in schema'))).toBe(true);
    expect(isVectorSessionFilterError(new Error('connection refused'))).toBe(false);
    expect(isVectorSessionFilterError('no field named sessionId')).toBe(false);
  });

  it('formats daemon errors without leaking non-Error values', () => {
    expect(makeSemanticDaemonErrorResponse(new Error('boom'))).toEqual({ ok: false, error: 'boom' });
    expect(makeSemanticDaemonErrorResponse('boom')).toEqual({ ok: false, error: 'unknown daemon error' });
  });
});
