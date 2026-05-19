import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_FACET_DIMENSIONS,
  FacetDimensionSchema,
  FacetTargetTypeSchema,
  MemoryFacetAssignmentInputSchema,
  parseFacetAssignmentInput
} from '../../src/core/operations/facets.js';

describe('memory operation facets', () => {
  it('defines the built-in target types and dimensions from the operations spec', () => {
    expect(FacetTargetTypeSchema.options).toEqual([
      'event',
      'entity',
      'edge',
      'consolidated_memory',
      'lesson',
      'action'
    ]);

    expect(BUILT_IN_FACET_DIMENSIONS).toEqual([
      'kind',
      'workflow',
      'artifact',
      'source',
      'privacy',
      'quality',
      'retention',
      'project'
    ]);
  });

  it('accepts built-in and kebab-case custom dimensions only', () => {
    expect(FacetDimensionSchema.parse('kind')).toBe('kind');
    expect(FacetDimensionSchema.parse('team-workflow')).toBe('team-workflow');

    expect(() => FacetDimensionSchema.parse('TeamWorkflow')).toThrow();
    expect(() => FacetDimensionSchema.parse('team_workflow')).toThrow();
    expect(() => FacetDimensionSchema.parse('a'.repeat(65))).toThrow();
  });

  it('normalizes assignment input with safe defaults', () => {
    const assignment = parseFacetAssignmentInput({
      targetType: 'event',
      targetId: ' event-1 ',
      dimension: ' workflow ',
      value: ' release ',
      evidenceEventIds: [' event-1 ', '', 'event-2'],
      projectHash: ' abc123 ',
      actor: ' hermes '
    });

    expect(assignment).toEqual({
      targetType: 'event',
      targetId: 'event-1',
      dimension: 'workflow',
      value: 'release',
      confidence: 1,
      source: 'manual',
      evidenceEventIds: ['event-1', 'event-2'],
      projectHash: 'abc123',
      actor: 'hermes'
    });
  });

  it('rejects assignments without a compact target and value', () => {
    expect(() => MemoryFacetAssignmentInputSchema.parse({
      targetType: 'event',
      targetId: '',
      dimension: 'kind',
      value: 'debugging'
    })).toThrow();

    expect(() => MemoryFacetAssignmentInputSchema.parse({
      targetType: 'event',
      targetId: 'event-1',
      dimension: 'kind',
      value: ''
    })).toThrow();
  });
});
