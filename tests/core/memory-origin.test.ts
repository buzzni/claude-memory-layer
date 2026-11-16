import { describe, expect, it } from 'vitest';

import {
  classifyEventOrigin,
  classifyMemoryOrigin,
  countMemoryOrigins,
  isAutoInjectionExcludableOrigin,
  memoryOriginLabel,
  normalizeMemoryOrigin
} from '../../src/core/memory-origin.js';

describe('classifyMemoryOrigin', () => {
  it('classifies live hook rows by event type', () => {
    expect(classifyMemoryOrigin({ type: 'user_prompt' })).toBe('user');
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata: { turnId: 't1' } })).toBe('assistant');
    expect(classifyMemoryOrigin({ type: 'session_summary' })).toBe('derived');
    expect(classifyMemoryOrigin({ type: 'lesson' })).toBe('derived');
    expect(classifyMemoryOrigin({ type: 'tool_observation' })).toBe('tool');
  });

  it('classifies host session imports (an absolute importedFrom path) by their role, like a live capture', () => {
    const codex = { importedFrom: '/home/u/.codex/sessions/2026/11/a.jsonl', source: 'codex' };
    expect(classifyMemoryOrigin({ type: 'user_prompt', metadata: codex })).toBe('user');
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata: codex })).toBe('assistant');
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata: { importedFrom: '/home/u/.hermes/state.db' } })).toBe('assistant');
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata: { importedFrom: 'C:\\Users\\u\\.claude\\projects\\a.jsonl' } })).toBe('assistant');
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata: { importedFrom: '\\\\host\\share\\a.jsonl' } })).toBe('assistant');
  });

  it('classifies an import it cannot attribute to a host session as imported', () => {
    for (const importedFrom of ['codex', 'relative/a.jsonl', '', true, 3, {}]) {
      expect(classifyMemoryOrigin({ type: 'agent_response', metadata: { importedFrom } })).toBe('imported');
    }
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata: { importedFrom: null } })).toBe('assistant');
  });

  it('classifies a row pulled through Mongo sync as imported, even when it was a host session import there', () => {
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata: { mongoSync: {} } })).toBe('imported');
    expect(classifyMemoryOrigin({
      type: 'user_prompt',
      metadata: { importedFrom: '/home/b/.codex/sessions/a.jsonl', mongoSync: { originHostname: 'machine-b' } }
    })).toBe('imported');
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata: { mongoSync: 'yes' } })).toBe('assistant');
  });

  it('keeps an imported tool row as tool, the class automatic injection can exclude', () => {
    expect(classifyMemoryOrigin({ type: 'tool_observation', metadata: { importedFrom: 'codex' } })).toBe('tool');
    expect(classifyMemoryOrigin({ type: 'tool_observation', metadata: { mongoSync: {} } })).toBe('tool');
  });

  it('classifies a stored event by its eventType and metadata', () => {
    expect(classifyEventOrigin({ eventType: 'agent_response', metadata: { mongoSync: {} } })).toBe('imported');
    expect(classifyEventOrigin({ eventType: 'user_prompt', metadata: { importedFrom: '/x.jsonl' } })).toBe('user');
  });

  it('falls to unknown for a type it does not know, including prototype keys', () => {
    expect(classifyMemoryOrigin({ type: 'shared_troubleshooting' })).toBe('unknown');
    expect(classifyMemoryOrigin({ type: '' })).toBe('unknown');
    expect(classifyMemoryOrigin({ type: 'constructor' })).toBe('unknown');
    expect(classifyMemoryOrigin({ type: 'mystery', metadata: { mongoSync: {} } })).toBe('unknown');
  });
});

describe('memory origin trust', () => {
  it('labels only the low-trust classes', () => {
    expect(memoryOriginLabel('user')).toBeNull();
    expect(memoryOriginLabel('assistant')).toBeNull();
    expect(memoryOriginLabel('derived')).toBeNull();
    expect(memoryOriginLabel('tool')).toBe('low-trust: tool output');
    expect(memoryOriginLabel('imported')).toBe('low-trust: imported');
    expect(memoryOriginLabel('unknown')).toBe('low-trust: unknown origin');
  });

  it('lets automatic injection exclude tool and unknown, never imported', () => {
    expect(isAutoInjectionExcludableOrigin('tool')).toBe(true);
    expect(isAutoInjectionExcludableOrigin('unknown')).toBe(true);
    expect(isAutoInjectionExcludableOrigin('imported')).toBe(false);
    expect(isAutoInjectionExcludableOrigin('derived')).toBe(false);
    expect(isAutoInjectionExcludableOrigin('user')).toBe(false);
  });

  it('normalizes only known class names', () => {
    expect(normalizeMemoryOrigin('tool')).toBe('tool');
    expect(normalizeMemoryOrigin('TOOL')).toBeNull();
    expect(normalizeMemoryOrigin(undefined)).toBeNull();
    expect(normalizeMemoryOrigin(3)).toBeNull();
  });

  it('counts per class without zero entries', () => {
    expect(countMemoryOrigins(['tool', 'assistant', 'tool'])).toEqual({ tool: 2, assistant: 1 });
    expect(countMemoryOrigins([])).toEqual({});
  });
});
