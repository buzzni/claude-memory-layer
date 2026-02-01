/**
 * Stats API
 * Endpoints for storage statistics
 */

import { Hono } from 'hono';
import { getDefaultMemoryService } from '../../services/memory-service.js';

export const statsRouter = new Hono();

// GET /api/stats - Get overall statistics
statsRouter.get('/', async (c) => {
  try {
    const memoryService = getDefaultMemoryService();
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
      levelStats: stats.levelStats
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

// GET /api/stats/timeline - Get activity timeline
statsRouter.get('/timeline', async (c) => {
  const days = parseInt(c.req.query('days') || '7', 10);

  try {
    const memoryService = getDefaultMemoryService();
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
  }
});
