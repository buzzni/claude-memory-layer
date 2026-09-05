import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MCP_TOOL_PROFILES,
  dispatchRegisteredToolCall,
  getMcpToolRegistration,
  getToolsForProfile,
  mcpToolRegistry,
  resolveMcpToolProfile,
  tools,
  willMcpToolMutate
} from '../../src/extensions/mcp/registry.js';
import { tools as compatibilityTools } from '../../src/extensions/mcp/tools.js';

// Baseline re-pinned 2026-08-19 after folding main's post-branch tools.ts
// drift into the registry: telemetry notes on mem-details/mem-source-ref
// descriptions and the read_only mutation _meta on mem-stats (#71/#74).
const ALL_BASELINE = {
  count: 45,
  bytes: 48_829,
  sha256: '77da78c5f43116bea2c59b1795909b8e373aedf4a19c43f479213fcdb8083fd8',
  names: [
    'external-market-context',
    'mem-search',
    'mem-timeline',
    'mem-details',
    'mem-stats',
    'mem-context-pack',
    'mem-import-latest',
    'mem-project-timeline',
    'mem-source-ref',
    'mem-facet-query',
    'mem-facet-tag',
    'mem-action-list',
    'mem-action-update',
    'mem-frontier',
    'mem-checkpoint-create',
    'mem-checkpoint-list',
    'mem-retention-audit',
    'mem-graph-query',
    'mem-lesson-list',
    'mem-lesson-get',
    'mem-lesson-candidates',
    'mem-lesson-save',
    'mem-asset-create',
    'mem-asset-get',
    'mem-asset-list',
    'mem-asset-catalog-sync',
    'mem-asset-update',
    'mem-asset-bind',
    'mem-asset-grant-set',
    'mem-asset-check',
    'mem-shared-actor-link',
    'mem-shared-actor-status',
    'mem-shared-actor-unlink',
    'mem-shared-search',
    'mem-shared-asset-get',
    'mem-actor-list',
    'mem-actor-card-get',
    'mem-actor-card-upsert',
    'mem-entity-supersede',
    'mem-core-block-get',
    'mem-core-block-update',
    'mem-perspective-query',
    'mem-perspective-context',
    'mem-perspective-observation-create',
    'mem-perspective-observation-delete'
  ]
} as const;

function serializedStats(value: unknown) {
  const json = JSON.stringify(value);
  return {
    bytes: Buffer.byteLength(json),
    sha256: createHash('sha256').update(json).digest('hex')
  };
}

describe('MCP tool registry and profiles', () => {
  it('preserves the exact pre-profile all schema baseline', () => {
    expect(compatibilityTools).toBe(tools);
    expect(tools.map((tool) => tool.name)).toEqual(ALL_BASELINE.names);
    expect(tools).toHaveLength(ALL_BASELINE.count);
    expect(serializedStats(tools)).toEqual({
      bytes: ALL_BASELINE.bytes,
      sha256: ALL_BASELINE.sha256
    });
    expect(getToolsForProfile('all')).toEqual(tools);
  });

  it('owns every definition with one bounded handler and no duplicate names', () => {
    const names = mcpToolRegistry.map((entry) => entry.tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(ALL_BASELINE.names);
    for (const entry of mcpToolRegistry) {
      expect(entry.profiles).toContain('all');
      expect(entry.handler).toBeTypeOf('function');
      expect(getMcpToolRegistration(entry.tool.name)).toBe(entry);
    }
  });

  it('rejects cross-domain dispatch before reaching compatibility logic', async () => {
    const contextHandler = getMcpToolRegistration('mem-search')?.handler;
    await expect(contextHandler?.('mem-import-latest', {})).rejects.toThrow(
      'MCP context-search handler cannot dispatch unowned tool: mem-import-latest'
    );
  });

  it('defaults to all and rejects unknown profiles clearly', () => {
    expect(resolveMcpToolProfile(undefined)).toBe('all');
    expect(resolveMcpToolProfile('')).toBe('all');
    expect(resolveMcpToolProfile(' CORE ')).toBe('core');
    expect(() => resolveMcpToolProfile('tiny')).toThrow(
      'Unknown MCP tool profile "tiny". Expected one of: core, operations, governance, experimental, all.'
    );
  });

  it('keeps core within the 10-tool and 20 KB schema budgets', () => {
    const core = getToolsForProfile('core');
    expect(core.map((tool) => tool.name)).toEqual([
      'mem-search',
      'mem-timeline',
      'mem-details',
      'mem-stats',
      'mem-context-pack',
      'mem-project-timeline',
      'mem-source-ref'
    ]);
    expect(core.length).toBeLessThanOrEqual(10);
    expect(serializedStats(core).bytes).toBeLessThanOrEqual(20_000);
    expect(core.some((tool) => tool.name === 'mem-import-latest')).toBe(false);
  });

  it('makes every supported profile selectable and includes core navigation', () => {
    const coreNames = getToolsForProfile('core').map((tool) => tool.name);
    for (const profile of MCP_TOOL_PROFILES) {
      const names = getToolsForProfile(profile).map((tool) => tool.name);
      expect(names.length).toBeGreaterThan(0);
      if (profile !== 'all') expect(names).toEqual(expect.arrayContaining(coreNames));
    }
  });

  it('evaluates both branches and the opt-out for context-pack mutation', () => {
    expect(willMcpToolMutate('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'continue',
      refreshLatest: false
    })).toBe(false);
    expect(willMcpToolMutate('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'release checklist',
      refreshLatest: true
    })).toBe(true);
    expect(willMcpToolMutate('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'continue'
    })).toBe(true);
    expect(willMcpToolMutate('mem-context-pack', {
      projectPath: '/repo/app',
      query: '   '
    })).toBe(false);
    expect(willMcpToolMutate('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'release checklist'
    })).toBe(false);
    expect(willMcpToolMutate('mem-context-pack', {
      projectPath: '/repo/app',
      query: 'continue',
      sessionId: 'source-session'
    })).toBe(false);
    expect(willMcpToolMutate('mem-context-pack', {
      projectPath: 'relative/project',
      refreshLatest: true
    })).toBe(false);
  });

  it('evaluates preview/apply mutation and exposes machine-readable defaults', () => {
    expect(willMcpToolMutate('mem-asset-catalog-sync', {})).toBe(false);
    expect(willMcpToolMutate('mem-asset-catalog-sync', { apply: false })).toBe(false);
    expect(willMcpToolMutate('mem-asset-catalog-sync', { apply: true })).toBe(true);

    const conditional = mcpToolRegistry.filter((entry) => entry.mutation.kind === 'conditional');
    expect(conditional.map((entry) => entry.tool.name)).toEqual([
      'mem-context-pack',
      'mem-asset-catalog-sync'
    ]);
    for (const entry of conditional) {
      expect(entry.mutation).toMatchObject({
        kind: 'conditional',
        writeWhen: expect.any(Object),
        readOnlyOptOut: expect.any(Object)
      });
    }
  });

  it('classifies always-mutating and read-only tools explicitly', () => {
    expect(willMcpToolMutate('mem-import-latest', {})).toBe(true);
    expect(willMcpToolMutate('mem-action-update', {})).toBe(true);
    expect(willMcpToolMutate('mem-source-ref', {})).toBe(false);
    expect(willMcpToolMutate('mem-frontier', {})).toBe(false);
    expect(willMcpToolMutate('missing-tool', {})).toBeUndefined();
  });

  it('does not dispatch tools hidden by the active profile', async () => {
    const hidden = await dispatchRegisteredToolCall('mem-import-latest', {}, 'core');
    expect(hidden).toMatchObject({ isError: true });
    expect(hidden.content[0]).toMatchObject({ type: 'text', text: 'Unknown tool: mem-import-latest' });
  });
});
