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

  it('classifies importer rows as imported', () => {
    const metadata = { importedFrom: '/home/u/.codex/sessions/a.jsonl', source: 'codex' };
    expect(classifyMemoryOrigin({ type: 'user_prompt', metadata })).toBe('imported');
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata })).toBe('imported');
  });

  it('classifies a row pulled from another machine through Mongo sync as imported', () => {
    const metadata = { mongoSync: { originHostname: 'machine-a' } };
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata })).toBe('imported');
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata: { mongoSync: 'yes' } })).toBe('assistant');
  });

  it('keeps an imported tool row as tool, the class automatic injection can exclude', () => {
    expect(classifyMemoryOrigin({ type: 'tool_observation', metadata: { importedFrom: '/x.jsonl' } })).toBe('tool');
  });

  it('ignores an importedFrom that is not a string', () => {
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata: { importedFrom: true } })).toBe('assistant');
  });

  it('classifies a stored event by its eventType and metadata', () => {
    expect(classifyEventOrigin({ eventType: 'agent_response', metadata: { importedFrom: '/x.jsonl' } })).toBe('imported');
    expect(classifyEventOrigin({ eventType: 'user_prompt' })).toBe('user');
  });

  it('falls to unknown for a type it does not know, including prototype keys', () => {
    expect(classifyMemoryOrigin({ type: 'shared_troubleshooting' })).toBe('unknown');
    expect(classifyMemoryOrigin({ type: '' })).toBe('unknown');
    expect(classifyMemoryOrigin({ type: 'constructor' })).toBe('unknown');
    expect(classifyMemoryOrigin({ type: 'mystery', metadata: { importedFrom: '/x.jsonl' } })).toBe('unknown');
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
