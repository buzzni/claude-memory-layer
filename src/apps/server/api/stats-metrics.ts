/**
 * Pure KPI / usefulness metric helpers extracted from the stats router.
 *
 * These functions are side-effect-free (no Hono context, no DB handle) and were
 * previously buried in the ~2000-line stats.ts, where they could only be tested
 * through the HTTP layer. Keeping them here makes them unit-testable and trims
 * the router down to routing + the heavier compute/aggregation that still
 * depends on request state.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MemoryEvent } from '../../../core/types.js';

export type KpiWindow = '24h' | '7d' | '30d';

export type KpiThresholds = {
  usefulRecallRateMin: number;
  reworkRateMax: number;
  postChangeFailureRateMax: number;
  avgCompletionTurnsMax: number;
  memoryHitRateMin: number;
};

const DEFAULT_KPI_THRESHOLDS: KpiThresholds = {
  usefulRecallRateMin: 0.45,
  reworkRateMax: 0.25,
  postChangeFailureRateMax: 0.2,
  avgCompletionTurnsMax: 12,
  memoryHitRateMin: 0.35
};

export function loadKpiThresholds(): KpiThresholds {
  try {
    const filePath = path.resolve(process.cwd(), 'config', 'kpi-thresholds.json');
    if (!fs.existsSync(filePath)) return DEFAULT_KPI_THRESHOLDS;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<KpiThresholds>;
    return {
      usefulRecallRateMin: Number(parsed.usefulRecallRateMin ?? DEFAULT_KPI_THRESHOLDS.usefulRecallRateMin),
      reworkRateMax: Number(parsed.reworkRateMax ?? DEFAULT_KPI_THRESHOLDS.reworkRateMax),
      postChangeFailureRateMax: Number(parsed.postChangeFailureRateMax ?? DEFAULT_KPI_THRESHOLDS.postChangeFailureRateMax),
      avgCompletionTurnsMax: Number(parsed.avgCompletionTurnsMax ?? DEFAULT_KPI_THRESHOLDS.avgCompletionTurnsMax),
      memoryHitRateMin: Number(parsed.memoryHitRateMin ?? DEFAULT_KPI_THRESHOLDS.memoryHitRateMin)
    };
  } catch {
    return DEFAULT_KPI_THRESHOLDS;
  }
}

export function windowToMs(window: KpiWindow): number {
  if (window === '24h') return 24 * 60 * 60 * 1000;
  if (window === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

export function inWindow(e: MemoryEvent, now: number, window: KpiWindow): boolean {
  return now - e.timestamp.getTime() <= windowToMs(window);
}

export function isEditToolName(name: string): boolean {
  return ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name);
}

export function parseToolPayload(e: MemoryEvent): { toolName?: string; success?: boolean; filePath?: string; command?: string } | null {
  if (e.eventType !== 'tool_observation') return null;
  try {
    const payload = JSON.parse(e.content) as any;
    return {
      toolName: payload?.toolName,
      success: payload?.success,
      filePath: payload?.metadata?.filePath,
      command: payload?.metadata?.command
    };
  } catch {
    return {
      toolName: (e.metadata as any)?.toolName,
      success: (e.metadata as any)?.success,
      filePath: (e.metadata as any)?.filePath,
      command: (e.metadata as any)?.command
    };
  }
}

export function isTestLikeCommand(command?: string): boolean {
  if (!command) return false;
  return /(test|jest|vitest|pytest|go test|cargo test|lint|eslint|build|tsc)/i.test(command);
}

export function safeRatio(num: number, den: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  return num / den;
}

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function computeSessionTurnCount(sessionEvents: MemoryEvent[]): number {
  const turnIds = new Set<string>();
  for (const e of sessionEvents) {
    const turnId = (e.metadata as any)?.turnId;
    if (typeof turnId === 'string' && turnId.length > 0) turnIds.add(turnId);
  }
  if (turnIds.size > 0) return turnIds.size;
  return sessionEvents.filter((e) => e.eventType === 'user_prompt').length;
}
