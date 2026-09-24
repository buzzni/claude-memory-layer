import { describe, expect, it } from 'vitest';

import {
  evaluateRetentionPolicy,
  type RetentionPolicyInput
} from '../../src/core/operations/retention-policy.js';

const NOW = new Date('2026-05-19T00:00:00.000Z');

function input(overrides: Partial<RetentionPolicyInput> = {}): RetentionPolicyInput {
  return {
    targetId: 'event-1',
    targetType: 'event',
    projectHash: 'project-a',
    eventType: 'agent_response',
    memoryLevel: 'L2',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    lastAccessedAt: new Date('2026-05-18T00:00:00.000Z'),
    retrievalCount: 3,
    helpfulnessScore: 0.6,
    adherenceScore: 0.6,
    evidenceConfidence: 0.6,
    metadata: {},
    facets: [],
    ...overrides
  };
}

describe('evaluateRetentionPolicy', () => {
  it('keeps high-value memories with explainable score factors in dry-run mode', () => {
    const result = evaluateRetentionPolicy(input({
      targetId: 'high-value-event',
      memoryLevel: 'L4',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      lastAccessedAt: new Date('2026-05-18T00:00:00.000Z'),
      retrievalCount: 21,
      helpfulnessScore: 0.92,
      adherenceScore: 0.84,
      evidenceConfidence: 0.95,
      facets: [
        { dimension: 'quality', value: 'verified', confidence: 0.9 },
        { dimension: 'kind', value: 'debugging', confidence: 0.8 }
      ]
    }), { now: NOW });

    expect(result.policyVersion).toBe('v1');
    expect(result.targetId).toBe('high-value-event');
    expect(result.decision).toBe('keep');
    expect(result.dryRun).toBe(true);
    expect(result.lifecycleScore).toBeGreaterThanOrEqual(0.7);
    expect(result.dryRunDiff).toEqual({ wouldChange: false, action: 'none' });
    expect(result.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      'memory_level',
      'recency',
      'retrieval_count',
      'helpfulness',
      'evidence_confidence',
      'quality_verified'
    ]));
    expect(result.factors).toMatchObject({
      level: expect.any(Number),
      recency: expect.any(Number),
      retrieval: expect.any(Number),
      helpfulness: expect.any(Number),
      evidence: expect.any(Number),
      privacy: expect.any(Number),
      manual: 0
    });
  });

  it('never lets manual keep override active quarantine metadata', () => {
    const result = evaluateRetentionPolicy(input({
      targetId: 'quarantined-event',
      metadata: {
        quarantine: {
          status: 'active',
          reason: 'user requested quarantine'
        }
      },
      facets: [{ dimension: 'retention', value: 'keep', confidence: 1 }],
      retrievalCount: 50,
      helpfulnessScore: 1,
      adherenceScore: 1,
      evidenceConfidence: 1
    }), { now: NOW });

    expect(result.decision).toBe('quarantine');
    expect(result.lifecycleScore).toBeLessThanOrEqual(0.2);
    expect(result.dryRunDiff).toEqual({ wouldChange: false, action: 'already_quarantined' });
    expect(result.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      'active_quarantine',
      'manual_retention_keep'
    ]));
  });

  it('applies manual retention discard as a non-destructive tombstone candidate', () => {
    const result = evaluateRetentionPolicy(input({
      targetId: 'manual-discard-event',
      memoryLevel: 'L3',
      retrievalCount: 14,
      helpfulnessScore: 0.8,
      adherenceScore: 0.8,
      evidenceConfidence: 0.9,
      facets: [{ dimension: 'retention', value: 'discard', confidence: 0.95 }]
    }), { now: NOW });

    expect(result.decision).toBe('tombstone_candidate');
    expect(result.dryRun).toBe(true);
    expect(result.dryRunDiff).toEqual({
      wouldChange: true,
      action: 'mark_tombstone_candidate',
      after: { retentionDecision: 'tombstone_candidate', policyVersion: 'v1' }
    });
    expect(result.reasons.map((reason) => reason.code)).toContain('manual_retention_discard');
    expect(result.reasons.map((reason) => reason.message).join(' ')).not.toMatch(/delete|hard-delete/i);
  });

  it('downgrades or tombstones stale low-signal memories without private metadata', () => {
    const downgrade = evaluateRetentionPolicy(input({
      targetId: 'stale-low-signal-event',
      memoryLevel: 'L1',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      lastAccessedAt: new Date('2025-02-01T00:00:00.000Z'),
      retrievalCount: 1,
      helpfulnessScore: 0.35,
      adherenceScore: 0.45,
      evidenceConfidence: 0.45
    }), { now: NOW });

    const tombstone = evaluateRetentionPolicy(input({
      targetId: 'stale-no-signal-event',
      eventType: 'tool_observation',
      memoryLevel: 'L0',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      lastAccessedAt: null,
      retrievalCount: 0,
      helpfulnessScore: 0,
      adherenceScore: 0,
      evidenceConfidence: 0
    }), { now: NOW });

    expect(downgrade.decision).toBe('downgrade');
    expect(downgrade.dryRunDiff).toEqual({
      wouldChange: true,
      action: 'mark_downgrade_candidate',
      after: { retentionDecision: 'downgrade', policyVersion: 'v1' }
    });
    expect(tombstone.decision).toBe('tombstone_candidate');
    expect(tombstone.dryRunDiff.action).toBe('mark_tombstone_candidate');
    expect(tombstone.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      'stale_created_at',
      'low_retrieval_count',
      'low_helpfulness',
      'low_evidence_confidence'
    ]));
  });

  it('keeps private memories in review instead of tombstone decisions', () => {
    const result = evaluateRetentionPolicy(input({
      targetId: 'private-stale-event',
      memoryLevel: 'L0',
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      lastAccessedAt: null,
      retrievalCount: 0,
      helpfulnessScore: 0,
      adherenceScore: 0,
      evidenceConfidence: 0,
      metadata: { private: true },
      facets: [{ dimension: 'privacy', value: 'private', confidence: 1 }]
    }), { now: NOW });

    expect(result.decision).toBe('review');
    expect(result.dryRunDiff).toEqual({
      wouldChange: true,
      action: 'mark_review_required',
      after: { retentionDecision: 'review', policyVersion: 'v1' }
    });
    expect(result.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      'private_metadata',
      'privacy_private_facet'
    ]));
  });
});
