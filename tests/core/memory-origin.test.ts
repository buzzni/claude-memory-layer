import { describe, expect, it } from 'vitest';

import {
  classifyEventOrigin,
  classifyMemoryOrigin,
  countMemoryOrigins,
  isAutoInjectionExcludableOrigin,
  memoryOriginLabel,
  memoryOriginLabelSuffix,
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
    for (const importedFrom of ['codex', 'relative/a.jsonl', '']) {
      expect(classifyMemoryOrigin({ type: 'agent_response', metadata: { importedFrom } })).toBe('imported');
    }
  });

  it('classifies a row pulled through Mongo sync as imported, even when it was a host session import there', () => {
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata: { mongoSync: {} } })).toBe('imported');
    expect(classifyMemoryOrigin({
      type: 'user_prompt',
      metadata: { importedFrom: '/home/b/.codex/sessions/a.jsonl', mongoSync: { originHostname: 'machine-b' } }
    })).toBe('imported');
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

// Metadata may only lower trust; anything it does not let us read is unknown.
describe('classifyMemoryOrigin with metadata it cannot read', () => {
  it('distinguishes a row without metadata from one whose metadata is not an object', () => {
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata: undefined })).toBe('assistant');
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata: null })).toBe('assistant');
    for (const metadata of ['{"mongoSync":{}}', '{}', 3, true, ['mongoSync']]) {
      expect(classifyMemoryOrigin({ type: 'agent_response', metadata })).toBe('unknown');
    }
  });

  it('classifies a provenance marker of the wrong shape as unknown, not as the trusted role', () => {
    for (const mongoSync of ['yes', true, 1, null, ['machine-b']]) {
      expect(classifyMemoryOrigin({ type: 'agent_response', metadata: { mongoSync } })).toBe('unknown');
    }
    for (const importedFrom of [true, 3, {}, null, ['/a.jsonl']]) {
      expect(classifyMemoryOrigin({ type: 'user_prompt', metadata: { importedFrom } })).toBe('unknown');
    }
    expect(classifyMemoryOrigin({ type: 'tool_observation', metadata: { mongoSync: 'yes' } })).toBe('unknown');
  });

  it('never takes the type from metadata: a forged eventType cannot raise a tool row', () => {
    expect(classifyEventOrigin({ eventType: 'tool_observation', metadata: { eventType: 'agent_response', type: 'user_prompt' } })).toBe('tool');
    expect(classifyEventOrigin({ eventType: 'mystery', metadata: { eventType: 'agent_response' } })).toBe('unknown');
  });

  it('ignores inherited keys, reading only the row\'s own markers', () => {
    const metadata = Object.create({ mongoSync: {} }) as Record<string, unknown>;
    expect(classifyMemoryOrigin({ type: 'agent_response', metadata })).toBe('assistant');
  });
});

describe('memory origin trust', () => {
  it('renders the label as a suffix outside the memory text', () => {
    expect(memoryOriginLabelSuffix('tool')).toBe(' [low-trust: tool output]');
    expect(memoryOriginLabelSuffix('assistant')).toBe('');
  });

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
