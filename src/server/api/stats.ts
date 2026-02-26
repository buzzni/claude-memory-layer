/**
 * Stats API
 * Endpoints for storage statistics
 */

import { Hono } from 'hono';
import { getMemoryServiceForProject } from '../../services/memory-service.js';
import { getServiceFromQuery } from './utils.js';

export const statsRouter = new Hono();

// GET /api/stats/shared - Get shared store statistics
statsRouter.get('/shared', async (c) => {
  const memoryService = getServiceFromQuery(c);
  try {
    await memoryService.initialize();
    const sharedStats = await memoryService.getSharedStoreStats();
    return c.json({
      troubleshooting: sharedStats?.troubleshooting || 0,
      bestPractices: sharedStats?.bestPractices || 0,
      commonErrors: sharedStats?.commonErrors || 0,
      totalUsageCount: sharedStats?.totalUsageCount || 0,
      lastUpdated: sharedStats?.lastUpdated || null
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
        const eventIds = events.map(e => e.id);
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
  const memoryService = getServiceFromQuery(c);
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
