import { describe, expect, it } from 'vitest';

import { tools } from '../../src/extensions/mcp/tools.js';

function toolByName(name: string) {
  return tools.find((tool) => tool.name === name);
}

function propertiesFor(name: string): Record<string, unknown> {
  const tool = toolByName(name);
  expect(tool, `${name} should be registered`).toBeDefined();
  expect(tool?.inputSchema).toMatchObject({ type: 'object' });
  return tool?.inputSchema.properties as Record<string, unknown>;
}

function requiredFor(name: string): string[] {
  return (toolByName(name)?.inputSchema.required as string[] | undefined) ?? [];
}

describe('MCP memory operation tool definitions', () => {
  const operationToolNames = [
    'mem-facet-query',
    'mem-facet-tag',
    'mem-action-list',
    'mem-action-update',
    'mem-frontier',
    'mem-checkpoint-create',
    'mem-checkpoint-list',
    'mem-retention-audit',
    'mem-graph-query',
    'mem-lesson-list'
  ];

  it('registers the curated memory operations tool surface exactly once', () => {
    const registered = tools.map((tool) => tool.name);

    for (const name of operationToolNames) {
      expect(registered.filter((registeredName) => registeredName === name)).toHaveLength(1);
    }
  });

  it('requires projectPath on all operation tools to avoid cross-project leakage', () => {
    for (const name of operationToolNames) {
      const properties = propertiesFor(name);
      expect(properties.projectPath).toMatchObject({
        type: 'string',
        description: expect.stringContaining('project')
      });
      expect(requiredFor(name)).toContain('projectPath');
    }
  });

  it('marks mutating tools with actor and explicit write-boundary fields', () => {
    const facetTag = propertiesFor('mem-facet-tag');
    expect(requiredFor('mem-facet-tag')).toEqual(expect.arrayContaining([
      'projectPath', 'targetType', 'targetId', 'dimension', 'value', 'actor'
    ]));
    expect(facetTag.actor).toMatchObject({ type: 'string' });
    expect(facetTag.sourceEventIds).toMatchObject({ type: 'array' });

    const actionUpdate = propertiesFor('mem-action-update');
    expect(requiredFor('mem-action-update')).toEqual(expect.arrayContaining([
      'projectPath', 'actionId', 'status', 'actor'
    ]));
    expect(actionUpdate.status).toMatchObject({
      type: 'string',
      enum: expect.arrayContaining(['pending', 'in_progress', 'done', 'blocked', 'cancelled'])
    });
    expect(actionUpdate.sourceEventIds).toMatchObject({ type: 'array' });

    const checkpointCreate = propertiesFor('mem-checkpoint-create');
    expect(requiredFor('mem-checkpoint-create')).toEqual(expect.arrayContaining([
      'projectPath', 'targetType', 'targetId', 'label', 'actor'
    ]));
    expect(checkpointCreate.state).toMatchObject({ type: 'object' });
    expect(checkpointCreate.sourceEventIds).toMatchObject({ type: 'array' });
  });

  it('uses per-tool target type schemas that match operation models', () => {
    for (const name of ['mem-facet-query', 'mem-facet-tag', 'mem-retention-audit']) {
      const targetType = propertiesFor(name).targetType as { enum?: string[] };
      expect(targetType.enum).toEqual(['event', 'entity', 'edge', 'consolidated_memory', 'lesson', 'action']);
      expect(targetType.enum).not.toContain('session');
    }

    const checkpointTargetType = propertiesFor('mem-checkpoint-create').targetType as { enum?: string[] };
    expect(checkpointTargetType.enum).toEqual(['action', 'session']);
    expect(checkpointTargetType.enum).not.toContain('edge');
  });

  it('exposes bounded, dry-run/read-only schemas for governance, graph, and lessons', () => {
    const retentionAudit = propertiesFor('mem-retention-audit');
    expect(retentionAudit.dryRun).toMatchObject({
      type: 'boolean',
      const: true,
      description: expect.stringContaining('dry-run')
    });
    expect(retentionAudit.hardDelete).toBeUndefined();

    const graphQuery = propertiesFor('mem-graph-query');
    expect(graphQuery.maxHops).toMatchObject({
      type: 'number',
      maximum: 2,
      description: expect.stringContaining('bounded')
    });
    expect(requiredFor('mem-graph-query')).toContain('query');

    const lessonList = propertiesFor('mem-lesson-list');
    expect(lessonList.minConfidence).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
    expect(lessonList.limit).toMatchObject({ type: 'number', maximum: 100 });
  });
});
