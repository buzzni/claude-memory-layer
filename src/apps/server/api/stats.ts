/**
 * Stats API
 * Endpoints for storage statistics
 */

import { Hono } from 'hono';
import * as fs from 'fs';
import * as path from 'path';
import { getMemoryServiceForProject } from '../../../services/memory-service.js';
import { getLightweightServiceFromQuery, getServiceFromQuery } from './utils.js';
import type { MemoryEvent } from '../../../core/types.js';

export const statsRouter = new Hono();

type KpiWindow = '24h' | '7d' | '30d';

type KpiThresholds = {
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

function loadKpiThresholds(): KpiThresholds {
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

function windowToMs(window: KpiWindow): number {
  if (window === '24h') return 24 * 60 * 60 * 1000;
  if (window === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function inWindow(e: MemoryEvent, now: number, window: KpiWindow): boolean {
  return now - e.timestamp.getTime() <= windowToMs(window);
}

function isEditToolName(name: string): boolean {
  return ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name);
}

function parseToolPayload(e: MemoryEvent): { toolName?: string; success?: boolean; filePath?: string; command?: string } | null {
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

function isTestLikeCommand(command?: string): boolean {
  if (!command) return false;
  return /(test|jest|vitest|pytest|go test|cargo test|lint|eslint|build|tsc)/i.test(command);
}

function safeRatio(num: number, den: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  return num / den;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function computeSessionTurnCount(sessionEvents: MemoryEvent[]): number {
  const turnIds = new Set<string>();
  for (const e of sessionEvents) {
    const turnId = (e.metadata as any)?.turnId;
    if (typeof turnId === 'string' && turnId.length > 0) turnIds.add(turnId);
  }
  if (turnIds.size > 0) return turnIds.size;
  return sessionEvents.filter((e) => e.eventType === 'user_prompt').length;
}

type KpiMetrics = {
  memoryHitRate: number;
  usefulRecallRate: number;
  avgCompletionTurns: number;
  timeToFirstValidEditMinutes: number;
  reworkRate: number;
  postChangeFailureRate: number;
};

type MemoryUsefulnessComponentKey =
  | 'avgHelpfulnessScore'
  | 'usefulRecallRate'
  | 'memoryHitRate'
  | 'retrievalUsageRate'
  | 'queryYieldRate';

type MemoryUsefulnessComponent = {
  key: MemoryUsefulnessComponentKey;
  label: string;
  value: number;
  weight: number;
  available: boolean;
  contribution: number;
};

type MemoryUsefulnessDiagnostic = {
  key: string;
  severity: 'info' | 'warn';
  metric: string;
  value: number;
  target: number;
  title: string;
  detail: string;
  action: string;
};

type HelpfulnessStatsLike = {
  avgScore?: number;
  totalEvaluated?: number;
  totalRetrievals?: number;
  helpful?: number;
  neutral?: number;
  unhelpful?: number;
};

type RetrievalTraceLike = {
  candidateCount?: number;
  selectedCount?: number;
  candidateEventIds?: string[];
  selectedEventIds?: string[];
  createdAt?: Date | string;
};

function normalizeMetric(value: unknown): number {
  const numberValue = Number(value || 0);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.min(1, numberValue));
}

function getTimestampMs(value: Date | string | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function usefulnessScoreLabel(score: number, confidence: number): 'excellent' | 'good' | 'watch' | 'low' | 'unknown' {
  if (confidence <= 0) return 'unknown';
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'watch';
  return 'low';
}

function buildMemoryUsefulnessDiagnostics(input: {
  metrics: {
    avgHelpfulnessScore: number;
    memoryHitRate: number;
    queryYieldRate: number;
    evaluationCoverage: number;
    selectionRate: number;
  };
  counts: {
    promptCount: number;
    memoryCheckedPrompts: number;
    retrievalQueries: number;
    queriesWithSelected: number;
    selectedMemories: number;
    candidateMemories: number;
    totalEvaluated: number;
    totalRetrievals: number;
  };
}): MemoryUsefulnessDiagnostic[] {
  const { metrics, counts } = input;
  const diagnostics: MemoryUsefulnessDiagnostic[] = [];

  if (counts.promptCount > 0 && counts.retrievalQueries === 0) {
    diagnostics.push({
      key: 'no-retrieval-traces',
      severity: 'warn',
      metric: 'retrievalUsageRate',
      value: 0,
      target: 0.5,
      title: 'No retrieval traces were recorded',
      detail: `${counts.promptCount} prompts were seen, but none produced a retrieval trace in this window.`,
      action: 'Confirm the prompt hook is enabled and broaden adherence triggers for continuation, write-intent, and project-specific prompts.'
    });
  }

  if (counts.promptCount > 0 && metrics.memoryHitRate < 0.5) {
    diagnostics.push({
      key: 'low-memory-hit-rate',
      severity: 'warn',
      metric: 'memoryHitRate',
      value: metrics.memoryHitRate,
      target: 0.5,
      title: 'Memory checks are missing many prompts',
      detail: `Only ${counts.memoryCheckedPrompts} of ${counts.promptCount} prompts had an adherence check in this window.`,
      action: 'Broaden adherence triggers for continuation, write-intent, topic-shift, and project-specific prompts.'
    });
  }

  if (counts.retrievalQueries > 0 && metrics.queryYieldRate < 0.6) {
    diagnostics.push({
      key: 'low-query-yield-rate',
      severity: 'warn',
      metric: 'queryYieldRate',
      value: metrics.queryYieldRate,
      target: 0.6,
      title: 'Searches often select no memory',
      detail: `${counts.queriesWithSelected} of ${counts.retrievalQueries} retrieval queries injected at least one memory.`,
      action: 'Overfetch candidates, then filter/rerank before applying the final injection threshold.'
    });
  }

  if (counts.totalEvaluated > 0 && metrics.avgHelpfulnessScore < 0.7) {
    diagnostics.push({
      key: 'low-helpfulness-score',
      severity: 'warn',
      metric: 'avgHelpfulnessScore',
      value: metrics.avgHelpfulnessScore,
      target: 0.7,
      title: 'Injected memories are not translating into outcomes',
      detail: `${counts.totalEvaluated} evaluated retrievals averaged ${(metrics.avgHelpfulnessScore * 100).toFixed(1)}% helpfulness.`,
      action: 'Review low-scoring retrieval samples for stale decisions, cross-project noise, or raw transcript snippets.'
    });
  }

  if (counts.totalRetrievals > 0 && metrics.evaluationCoverage < 0.8) {
    diagnostics.push({
      key: 'low-evaluation-coverage',
      severity: 'info',
      metric: 'evaluationCoverage',
      value: metrics.evaluationCoverage,
      target: 0.8,
      title: 'Many retrievals are still unevaluated',
      detail: `${counts.totalEvaluated} of ${counts.totalRetrievals} retrievals have measured helpfulness.`,
      action: 'Ensure Stop/session-end hooks or pending-session backfill are running so usefulness reflects real outcomes.'
    });
  }

  if (counts.candidateMemories > 0 && counts.selectedMemories === 0) {
    diagnostics.push({
      key: 'candidates-without-selection',
      severity: 'warn',
      metric: 'selectionRate',
      value: metrics.selectionRate,
      target: 0.2,
      title: 'Candidates are found but none are injected',
      detail: `${counts.candidateMemories} candidates were retrieved, but no memories passed the injection policy.`,
      action: 'Inspect threshold settings and prompt-injection policy before lowering filters globally.'
    });
  }

  return diagnostics.slice(0, 3);
}

function computeMemoryUsefulnessSummary(
  events: MemoryEvent[],
  helpfulness: HelpfulnessStatsLike,
  traces: RetrievalTraceLike[],
  now: number,
  window: KpiWindow,
  limits: { eventsLimit?: number; tracesLimit?: number } = {}
) {
  const windowEvents = events.filter((event) => inWindow(event, now, window));
  const prompts = windowEvents.filter((event) => event.eventType === 'user_prompt');
  const promptCount = prompts.length;
  const memoryCheckedPrompts = prompts.filter((prompt) => (prompt.metadata as any)?.adherence?.checked).length;

  const windowMs = windowToMs(window);
  const windowStart = now - windowMs;
  const windowTraces = traces.filter((trace) => {
    const ts = getTimestampMs(trace.createdAt);
    return ts > 0 && ts >= windowStart;
  });
  const oldestEventTimestamp = events.reduce((oldest, event) => {
    const timestamp = event.timestamp?.getTime?.() || 0;
    return timestamp > 0 ? Math.min(oldest, timestamp) : oldest;
  }, Number.POSITIVE_INFINITY);
  const oldestTraceTimestamp = traces.reduce((oldest, trace) => {
    const timestamp = getTimestampMs(trace.createdAt);
    return timestamp > 0 ? Math.min(oldest, timestamp) : oldest;
  }, Number.POSITIVE_INFINITY);
  const eventWindowTruncated = Boolean(
    limits.eventsLimit &&
    events.length >= limits.eventsLimit &&
    Number.isFinite(oldestEventTimestamp) &&
    oldestEventTimestamp >= windowStart
  );
  const traceWindowTruncated = Boolean(
    limits.tracesLimit &&
    traces.length >= limits.tracesLimit &&
    Number.isFinite(oldestTraceTimestamp) &&
    oldestTraceTimestamp >= windowStart
  );

  const retrievalQueries = windowTraces.length;
  const candidateCounts = windowTraces.map((trace) => Number(trace.candidateCount ?? trace.candidateEventIds?.length ?? 0));
  const selectedCounts = windowTraces.map((trace) => Number(trace.selectedCount ?? trace.selectedEventIds?.length ?? 0));
  const totalCandidateCount = candidateCounts.reduce((sum, count) => sum + (Number.isFinite(count) ? count : 0), 0);
  const totalSelectedCount = selectedCounts.reduce((sum, count) => sum + (Number.isFinite(count) ? count : 0), 0);
  const queriesWithSelected = selectedCounts.filter((count) => Number.isFinite(count) && count > 0).length;

  const totalEvaluated = Number(helpfulness.totalEvaluated || 0);
  const totalRetrievals = Number(helpfulness.totalRetrievals || 0);
  const helpful = Number(helpfulness.helpful || 0);
  const neutral = Number(helpfulness.neutral || 0);
  const unhelpful = Number(helpfulness.unhelpful || 0);

  const retrievalsPerPrompt = safeRatio(retrievalQueries, promptCount);
  const metrics = {
    avgHelpfulnessScore: round(normalizeMetric(helpfulness.avgScore)),
    usefulRecallRate: round(safeRatio(helpful, totalEvaluated)),
    memoryHitRate: round(safeRatio(memoryCheckedPrompts, promptCount)),
    retrievalUsageRate: round(Math.min(1, retrievalsPerPrompt)),
    queryYieldRate: round(safeRatio(queriesWithSelected, retrievalQueries)),
    evaluationCoverage: round(safeRatio(totalEvaluated, totalRetrievals)),
    retrievalsPerPrompt: round(retrievalsPerPrompt),
    avgCandidatesPerQuery: round(safeRatio(totalCandidateCount, retrievalQueries), 2),
    avgSelectedPerQuery: round(safeRatio(totalSelectedCount, retrievalQueries), 2),
    selectionRate: round(safeRatio(totalSelectedCount, totalCandidateCount))
  };
  const counts = {
    promptCount,
    memoryCheckedPrompts,
    retrievalQueries,
    queriesWithSelected,
    selectedMemories: totalSelectedCount,
    candidateMemories: totalCandidateCount,
    totalEvaluated,
    totalRetrievals,
    helpful,
    neutral,
    unhelpful
  };

  const componentSpecs: Omit<MemoryUsefulnessComponent, 'contribution'>[] = [
    { key: 'avgHelpfulnessScore', label: 'Average helpfulness score', value: metrics.avgHelpfulnessScore, weight: 0.3, available: totalEvaluated > 0 },
    { key: 'usefulRecallRate', label: 'Useful recall rate', value: metrics.usefulRecallRate, weight: 0.25, available: totalEvaluated > 0 },
    { key: 'memoryHitRate', label: 'Memory hit rate', value: metrics.memoryHitRate, weight: 0.2, available: promptCount > 0 },
    { key: 'retrievalUsageRate', label: 'Retrieval usage rate', value: metrics.retrievalUsageRate, weight: 0.15, available: promptCount > 0 },
    { key: 'queryYieldRate', label: 'Query yield rate', value: metrics.queryYieldRate, weight: 0.1, available: retrievalQueries > 0 }
  ];
  const totalWeight = componentSpecs.reduce((sum, component) => sum + component.weight, 0);
  const availableWeight = componentSpecs
    .filter((component) => component.available)
    .reduce((sum, component) => sum + component.weight, 0);
  const weightedScore = availableWeight > 0
    ? componentSpecs.reduce((sum, component) => sum + (component.available ? component.value * component.weight : 0), 0) / availableWeight
    : 0;
  const scoreValue = round(weightedScore * 100, 1);
  const confidence = round(safeRatio(availableWeight, totalWeight), 2);
  const components = componentSpecs.map((component) => ({
    ...component,
    contribution: component.available ? round(component.value * component.weight * 100, 2) : 0
  }));

  return {
    window,
    score: {
      value: scoreValue,
      label: usefulnessScoreLabel(scoreValue, confidence),
      confidence
    },
    metrics,
    counts,
    components,
    diagnostics: buildMemoryUsefulnessDiagnostics({ metrics, counts }),
    limits: {
      eventsLimit: limits.eventsLimit || events.length,
      tracesLimit: limits.tracesLimit || traces.length,
      eventWindowTruncated,
      traceWindowTruncated
    },
    generatedAt: new Date(now).toISOString()
  };
}

function computeKpiMetrics(events: MemoryEvent[], usefulRecallRate: number): KpiMetrics {
  const prompts = events.filter((e) => e.eventType === 'user_prompt');
  const promptCount = prompts.length;
  const memoryHitPrompts = prompts.filter((p) => (p.metadata as any)?.adherence?.checked).length;
  const memoryHitRate = round(safeRatio(memoryHitPrompts, promptCount));

  const sessions = new Map<string, MemoryEvent[]>();
  for (const e of events) {
    const arr = sessions.get(e.sessionId) || [];
    arr.push(e);
    sessions.set(e.sessionId, arr);
  }

  let sessionTurnTotal = 0;
  let sessionTurnSamples = 0;
  let firstValidEditMinutesTotal = 0;
  let firstValidEditSamples = 0;

  for (const sessionEvents of sessions.values()) {
    sessionEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const turns = computeSessionTurnCount(sessionEvents);
    if (turns > 0) {
      sessionTurnTotal += turns;
      sessionTurnSamples++;
    }

    const firstPrompt = sessionEvents.find((e) => e.eventType === 'user_prompt');
    const firstEdit = sessionEvents.find((e) => {
      const payload = parseToolPayload(e);
      return payload?.toolName && isEditToolName(payload.toolName) && payload.success === true;
    });
    if (firstPrompt && firstEdit) {
      const minutes = (firstEdit.timestamp.getTime() - firstPrompt.timestamp.getTime()) / 60000;
      if (minutes >= 0) {
        firstValidEditMinutesTotal += minutes;
        firstValidEditSamples++;
      }
    }
  }

  const avgCompletionTurns = round(safeRatio(sessionTurnTotal, sessionTurnSamples), 2);
  const timeToFirstValidEditMinutes = round(safeRatio(firstValidEditMinutesTotal, firstValidEditSamples), 2);

  const editActions: Array<{ sessionId: string; timestamp: number; filePath?: string }> = [];
  let testRunsAfterEdit = 0;
  let failedTestRunsAfterEdit = 0;

  for (const [sessionId, sessionEvents] of sessions.entries()) {
    const sorted = [...sessionEvents].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    let seenEdit = false;

    for (const e of sorted) {
      const payload = parseToolPayload(e);
      if (!payload?.toolName) continue;

      if (isEditToolName(payload.toolName) && payload.success === true) {
        editActions.push({ sessionId, timestamp: e.timestamp.getTime(), filePath: payload.filePath });
        seenEdit = true;
        continue;
      }

      if (seenEdit && isTestLikeCommand(payload.command)) {
        testRunsAfterEdit++;
        if (payload.success === false) failedTestRunsAfterEdit++;
      }
    }
  }

  const THIRTY_MIN_MS = 30 * 60 * 1000;
  let reworkCount = 0;
  const bySessionFile = new Map<string, number>();
  const sortedEdits = [...editActions].sort((a, b) => a.timestamp - b.timestamp);
  for (const edit of sortedEdits) {
    if (!edit.filePath) continue;
    const key = `${edit.sessionId}::${edit.filePath}`;
    const prev = bySessionFile.get(key);
    if (typeof prev === 'number' && edit.timestamp - prev <= THIRTY_MIN_MS) {
      reworkCount++;
    }
    bySessionFile.set(key, edit.timestamp);
  }

  const reworkRate = round(safeRatio(reworkCount, editActions.length));
  const postChangeFailureRate = round(safeRatio(failedTestRunsAfterEdit, testRunsAfterEdit));

  return {
    memoryHitRate,
    usefulRecallRate,
    avgCompletionTurns,
    timeToFirstValidEditMinutes,
    reworkRate,
    postChangeFailureRate
  };
}


// GET /api/stats/shared - Get shared store statistics
statsRouter.get('/shared', async (c) => {
  const memoryService = getServiceFromQuery(c);
  try {
    await memoryService.initialize();
    const sharedStats = await memoryService.getSharedStoreStats();
    return c.json({
      troubleshooting: sharedStats?.total || 0,
      bestPractices: 0,
      commonErrors: 0,
      totalUsageCount: sharedStats?.totalUsageCount || 0,
      lastUpdated: null
    });
  } catch (error) {
    return c.json({
      troubleshooting: 0,
      bestPractices: 0,
      commonErrors: 0,
      totalUsageCount: 0,
      lastUpdated: null
    });
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/endless - Get endless mode status
statsRouter.get('/endless', async (c) => {
  const projectPath = c.req.query('project') || process.cwd();
  const memoryService = getMemoryServiceForProject(projectPath);
  try {
    await memoryService.initialize();
    const status = await memoryService.getEndlessModeStatus();
    return c.json({
      mode: status.mode,
      continuityScore: status.continuityScore,
      workingSetSize: status.workingSetSize,
      consolidatedCount: status.consolidatedCount,
      lastConsolidation: status.lastConsolidation?.toISOString() || null
    });
  } catch (error) {
    return c.json({
      mode: 'session',
      continuityScore: 0,
      workingSetSize: 0,
      consolidatedCount: 0,
      lastConsolidation: null
    });
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/levels/:level - Get events by memory level
statsRouter.get('/levels/:level', async (c) => {
  const { level } = c.req.param();
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const sort = c.req.query('sort') || 'recent';

  // Validate level
  const validLevels = ['L0', 'L1', 'L2', 'L3', 'L4'];
  if (!validLevels.includes(level)) {
    return c.json({ error: `Invalid level. Must be one of: ${validLevels.join(', ')}` }, 400);
  }

  const memoryService = getServiceFromQuery(c);
  try {
    await memoryService.initialize();
    let events = await memoryService.getEventsByLevel(level, { limit: limit * 2, offset });
    const stats = await memoryService.getStats();
    const levelStat = stats.levelStats.find(s => s.level === level);

    // Apply sorting
    if (sort === 'accessed') {
      // Sort by access count (will need to get from SQLite)
      // For now, add access count from SQLite if available
      const sqliteStore = (memoryService as any).sqliteEventStore;
      if (sqliteStore) {
        const accessedEvents = await sqliteStore.getMostAccessed(1000);
        const accessMap = new Map(accessedEvents.map((e: any) => [e.id, e.access_count || 0]));
        events = events.map((e: any) => ({
          ...e,
          accessCount: accessMap.get(e.id) || 0
        }));
        events.sort((a: any, b: any) => b.accessCount - a.accessCount);
      }
    } else if (sort === 'oldest') {
      events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    } else {
      // 'recent' - default sorting (newest first)
      events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    }

    // Apply limit after sorting
    events = events.slice(0, limit);

    return c.json({
      level,
      events: events.map((e: any) => ({
        id: e.id,
        eventType: e.eventType,
        sessionId: e.sessionId,
        timestamp: e.timestamp.toISOString(),
        content: e.content.slice(0, 500) + (e.content.length > 500 ? '...' : ''),
        metadata: e.metadata,
        accessCount: e.accessCount || 0
      })),
      total: levelStat?.count || 0,
      limit,
      offset,
      hasMore: events.length === limit
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats - Get overall statistics
statsRouter.get('/', async (c) => {
  const memoryService = getLightweightServiceFromQuery(c);
  try {
    await memoryService.initialize();
    const stats = await memoryService.getStats();
    const recentEvents = await memoryService.getRecentEvents(10000);

    // Calculate event types
    const eventsByType = recentEvents.reduce((acc, e) => {
      acc[e.eventType] = (acc[e.eventType] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Calculate unique sessions
    const uniqueSessions = new Set(recentEvents.map(e => e.sessionId));

    // Calculate events by day (last 7 days)
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const eventsByDay = recentEvents
      .filter(e => e.timestamp >= sevenDaysAgo)
      .reduce((acc, e) => {
        const day = e.timestamp.toISOString().split('T')[0];
        acc[day] = (acc[day] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

    const retrievalTrace = await memoryService.getRetrievalTraceStats();

    return c.json({
      storage: {
        eventCount: stats.totalEvents,
        vectorCount: stats.vectorCount
      },
      sessions: {
        total: uniqueSessions.size
      },
      eventsByType,
      activity: {
        daily: eventsByDay,
        total7Days: recentEvents.filter(e => e.timestamp >= sevenDaysAgo).length
      },
      memory: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      },
      levelStats: stats.levelStats,
      retrievalTrace
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/most-accessed - Get most accessed memories
statsRouter.get('/most-accessed', async (c) => {
  const limit = parseInt(c.req.query('limit') || '10', 10);
  // Use the same read-only service that other stats endpoints use
  const memoryService = getServiceFromQuery(c);

  try {
    await memoryService.initialize();
    console.log('[most-accessed] Fetching most accessed memories, limit:', limit);
    const memories = await memoryService.getMostAccessedMemories(limit);
    console.log('[most-accessed] Got memories:', memories.length);

    return c.json({
      memories: memories.map(m => ({
        memoryId: m.memoryId,
        summary: m.summary,
        topics: m.topics,
        accessCount: m.accessCount,
        lastAccessed: m.lastAccessed || null,
        confidence: m.confidence,
        createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt
      })),
      total: memories.length
    });
  } catch (error) {
    console.error('[most-accessed] Error:', error);
    return c.json({
      memories: [],
      total: 0,
      error: (error as Error).message
    });
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/timeline - Get activity timeline
statsRouter.get('/timeline', async (c) => {
  const days = parseInt(c.req.query('days') || '7', 10);
  const memoryService = getServiceFromQuery(c);

  try {
    await memoryService.initialize();
    const recentEvents = await memoryService.getRecentEvents(10000);

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const filteredEvents = recentEvents.filter(e => e.timestamp >= cutoff);

    // Group by day
    const daily = filteredEvents.reduce((acc, e) => {
      const day = e.timestamp.toISOString().split('T')[0];
      if (!acc[day]) {
        acc[day] = { date: day, total: 0, prompts: 0, responses: 0, tools: 0 };
      }
      acc[day].total++;
      if (e.eventType === 'user_prompt') acc[day].prompts++;
      if (e.eventType === 'agent_response') acc[day].responses++;
      if (e.eventType === 'tool_observation') acc[day].tools++;
      return acc;
    }, {} as Record<string, { date: string; total: number; prompts: number; responses: number; tools: number }>);

    return c.json({
      days,
      daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date))
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/helpfulness - Get helpfulness statistics and top helpful memories
statsRouter.get('/helpfulness', async (c) => {
  const limit = parseInt(c.req.query('limit') || '10', 10);
  const memoryService = getServiceFromQuery(c);

  try {
    await memoryService.initialize();
    const stats = await memoryService.getHelpfulnessStats();
    const topMemories = await memoryService.getHelpfulMemories(limit);

    return c.json({
      ...stats,
      topMemories: topMemories.map(m => ({
        eventId: m.eventId,
        summary: m.summary,
        helpfulnessScore: m.helpfulnessScore,
        accessCount: m.accessCount,
        evaluationCount: m.evaluationCount
      }))
    });
  } catch (error) {
    return c.json({
      avgScore: 0,
      totalEvaluated: 0,
      totalRetrievals: 0,
      helpful: 0,
      neutral: 0,
      unhelpful: 0,
      topMemories: []
    });
  } finally {
    await memoryService.shutdown();
  }
});
// GET /api/stats/usefulness - Get a dashboard-ready memory usefulness score
statsRouter.get('/usefulness', async (c) => {
  const rawWindow = (c.req.query('window') || '7d') as KpiWindow;
  const window: KpiWindow = rawWindow === '24h' || rawWindow === '30d' ? rawWindow : '7d';
  const memoryService = getLightweightServiceFromQuery(c);

  try {
    await memoryService.initialize();
    const now = Date.now();
    const eventLimit = 20000;
    const traceLimit = 5000;
    const windowStart = new Date(now - windowToMs(window));
    const [events, helpfulness, traces] = await Promise.all([
      memoryService.getRecentEvents(eventLimit),
      memoryService.getHelpfulnessStats(windowStart),
      memoryService.getRecentRetrievalTraces(traceLimit)
    ]);

    return c.json(computeMemoryUsefulnessSummary(events, helpfulness, traces, now, window, {
      eventsLimit: eventLimit,
      tracesLimit: traceLimit
    }));
  } catch (error) {
    console.error('[stats/usefulness] failed to calculate dashboard metrics', error);
    return c.json({ error: 'Unable to calculate memory usefulness statistics' }, 500);
  } finally {
    await memoryService.shutdown();
  }
});



// GET /api/stats/retrieval-traces - Get recent retrieval traces (query -> selected context)
statsRouter.get('/retrieval-traces', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const memoryService = getServiceFromQuery(c);

  try {
    await memoryService.initialize();
    const traces = await memoryService.getRecentRetrievalTraces(limit);
    const traceStats = await memoryService.getRetrievalTraceStats();

    return c.json({
      stats: traceStats,
      traces: traces.map((t) => ({
        traceId: t.traceId,
        sessionId: t.sessionId || null,
        projectHash: t.projectHash || null,
        queryText: t.queryText,
        strategy: t.strategy || null,
        candidateEventIds: t.candidateEventIds,
        selectedEventIds: t.selectedEventIds,
        candidateDetails: t.candidateDetails || [],
        selectedDetails: t.selectedDetails || [],
        candidateCount: t.candidateCount,
        selectedCount: t.selectedCount,
        confidence: t.confidence || null,
        fallbackTrace: t.fallbackTrace,
        createdAt: t.createdAt.toISOString()
      }))
    });
  } catch (error) {
    return c.json({
      stats: { totalQueries: 0, avgCandidateCount: 0, avgSelectedCount: 0, selectionRate: 0 },
      traces: [],
      error: (error as Error).message
    }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/kpi - Productivity KPI summary + trend
statsRouter.get('/kpi', async (c) => {
  const rawWindow = (c.req.query('window') || '7d') as KpiWindow;
  const window: KpiWindow = rawWindow === '24h' || rawWindow === '30d' ? rawWindow : '7d';
  const memoryService = getServiceFromQuery(c);

  try {
    await memoryService.initialize();
    const now = Date.now();
    const thresholds = loadKpiThresholds();
    const allEvents = await memoryService.getRecentEvents(20000);
    const events = allEvents.filter((e) => inWindow(e, now, window));

    const helpfulness = await memoryService.getHelpfulnessStats();
    const usefulRecallRate = helpfulness.totalEvaluated > 0
      ? round(safeRatio(helpfulness.helpful, helpfulness.totalEvaluated))
      : 0;

    const metrics = computeKpiMetrics(events, usefulRecallRate);

    const windowMs = windowToMs(window);
    const prevEvents = allEvents.filter((e) => {
      const age = now - e.timestamp.getTime();
      return age > windowMs && age <= windowMs * 2;
    });
    const previousMetrics = computeKpiMetrics(prevEvents, usefulRecallRate);
    const deltas = {
      memoryHitRate: round(metrics.memoryHitRate - previousMetrics.memoryHitRate),
      usefulRecallRate: round(metrics.usefulRecallRate - previousMetrics.usefulRecallRate),
      avgCompletionTurns: round(metrics.avgCompletionTurns - previousMetrics.avgCompletionTurns, 2),
      timeToFirstValidEditMinutes: round(metrics.timeToFirstValidEditMinutes - previousMetrics.timeToFirstValidEditMinutes, 2),
      reworkRate: round(metrics.reworkRate - previousMetrics.reworkRate),
      postChangeFailureRate: round(metrics.postChangeFailureRate - previousMetrics.postChangeFailureRate)
    };

    const THIRTY_MIN_MS = 30 * 60 * 1000;

    // Trend (daily buckets for last 30 days)
    const trendWindowMs = 30 * 24 * 60 * 60 * 1000;
    const trendEvents = allEvents.filter((e) => now - e.timestamp.getTime() <= trendWindowMs);
    const buckets = new Map<string, MemoryEvent[]>();
    for (const e of trendEvents) {
      const day = e.timestamp.toISOString().split('T')[0];
      const arr = buckets.get(day) || [];
      arr.push(e);
      buckets.set(day, arr);
    }

    const trendDaily = Array.from(buckets.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, dayEvents]) => {
        const dayPrompts = dayEvents.filter((e) => e.eventType === 'user_prompt');
        const dayPromptCount = dayPrompts.length;
        const dayMemoryHit = dayPrompts.filter((p) => (p.metadata as any)?.adherence?.checked).length;

        // lightweight day rework/failure approximation
        const dayEdits = dayEvents.filter((e) => {
          const p = parseToolPayload(e);
          return Boolean(p?.toolName && isEditToolName(p.toolName) && p.success === true);
        });
        const dayEditActions = dayEdits
          .map((e) => {
            const p = parseToolPayload(e);
            return { sessionId: e.sessionId, timestamp: e.timestamp.getTime(), filePath: p?.filePath };
          })
          .filter((x) => Boolean(x.filePath));
        let dayReworkCount = 0;
        const dayBySessionFile = new Map<string, number>();
        for (const edit of dayEditActions) {
          const key = `${edit.sessionId}::${edit.filePath}`;
          const prev = dayBySessionFile.get(key);
          if (typeof prev === 'number' && edit.timestamp - prev <= THIRTY_MIN_MS) dayReworkCount++;
          dayBySessionFile.set(key, edit.timestamp);
        }
        const dayTests = dayEvents.filter((e) => {
          const p = parseToolPayload(e);
          return Boolean(p?.toolName && isTestLikeCommand(p.command));
        });
        const dayFailedTests = dayEvents.filter((e) => {
          const p = parseToolPayload(e);
          return Boolean(p?.toolName && isTestLikeCommand(p.command) && p.success === false);
        });

        const turnsBySession = new Map<string, MemoryEvent[]>();
        for (const e of dayEvents) {
          const arr = turnsBySession.get(e.sessionId) || [];
          arr.push(e);
          turnsBySession.set(e.sessionId, arr);
        }
        let dayTurnsTotal = 0;
        let dayTurnsSamples = 0;
        for (const sessionEvents of turnsBySession.values()) {
          const turns = computeSessionTurnCount(sessionEvents);
          if (turns > 0) {
            dayTurnsTotal += turns;
            dayTurnsSamples++;
          }
        }

        return {
          date,
          memoryHitRate: round(safeRatio(dayMemoryHit, dayPromptCount)),
          usefulRecallRate,
          reworkRate: round(safeRatio(dayReworkCount, dayEditActions.length)),
          postChangeFailureRate: round(safeRatio(dayFailedTests.length, dayTests.length)),
          avgCompletionTurns: round(safeRatio(dayTurnsTotal, dayTurnsSamples), 2)
        };
      });

    const alerts: Array<{ metric: string; level: 'warn'; message: string; value: number; threshold: number }> = [];
    if (metrics.usefulRecallRate < thresholds.usefulRecallRateMin) {
      alerts.push({ metric: 'usefulRecallRate', level: 'warn', message: 'Useful recall rate is below threshold', value: metrics.usefulRecallRate, threshold: thresholds.usefulRecallRateMin });
    }
    if (metrics.reworkRate > thresholds.reworkRateMax) {
      alerts.push({ metric: 'reworkRate', level: 'warn', message: 'Rework rate is above threshold', value: metrics.reworkRate, threshold: thresholds.reworkRateMax });
    }
    if (metrics.postChangeFailureRate > thresholds.postChangeFailureRateMax) {
      alerts.push({ metric: 'postChangeFailureRate', level: 'warn', message: 'Post-change failure rate is above threshold', value: metrics.postChangeFailureRate, threshold: thresholds.postChangeFailureRateMax });
    }
    if (metrics.avgCompletionTurns > thresholds.avgCompletionTurnsMax) {
      alerts.push({ metric: 'avgCompletionTurns', level: 'warn', message: 'Average completion turns is above threshold', value: metrics.avgCompletionTurns, threshold: thresholds.avgCompletionTurnsMax });
    }
    if (metrics.memoryHitRate < thresholds.memoryHitRateMin) {
      alerts.push({ metric: 'memoryHitRate', level: 'warn', message: 'Memory hit rate is below threshold', value: metrics.memoryHitRate, threshold: thresholds.memoryHitRateMin });
    }

    return c.json({
      window,
      metrics,
      previousMetrics,
      deltas,
      trend: {
        daily: trendDaily
      },
      thresholds,
      alerts
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// POST /api/stats/graduation/run - Force graduation evaluation
statsRouter.post('/graduation/run', async (c) => {
  const memoryService = getServiceFromQuery(c);
  try {
    await memoryService.initialize();
    const result = await memoryService.forceGraduation();

    return c.json({
      success: true,
      evaluated: result.evaluated,
      graduated: result.graduated,
      byLevel: result.byLevel
    });
  } catch (error) {
    return c.json({
      success: false,
      error: (error as Error).message
    }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/stats/graduation - Get graduation criteria info
statsRouter.get('/graduation', async (c) => {
  return c.json({
    criteria: {
      L0toL1: { minAccessCount: 1, minConfidence: 0.5, minCrossSessionRefs: 0, maxAgeDays: 30 },
      L1toL2: { minAccessCount: 3, minConfidence: 0.7, minCrossSessionRefs: 1, maxAgeDays: 60 },
      L2toL3: { minAccessCount: 5, minConfidence: 0.85, minCrossSessionRefs: 2, maxAgeDays: 90 },
      L3toL4: { minAccessCount: 10, minConfidence: 0.92, minCrossSessionRefs: 3, maxAgeDays: 180 }
    },
    description: {
      accessCount: 'Number of times the memory was retrieved/referenced',
      confidence: 'Match confidence score when retrieved (0.0-1.0)',
      crossSessionRefs: 'Number of different sessions that referenced this memory',
      maxAgeDays: 'Maximum days since last access (prevents stale promotion)'
    }
  });
});
