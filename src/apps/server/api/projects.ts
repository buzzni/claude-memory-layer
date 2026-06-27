/**
 * Projects API
 * Endpoints for listing available projects
 */

import { Hono } from 'hono';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  DISABLED_SHARED_STORE_CONFIG,
  loadSessionRegistry,
  MemoryService
} from '../../../services/memory-service.js';
import { resolveProjectStoragePath } from '../../../core/registry/project-path.js';

export const projectsRouter = new Hono();

type ProjectDetailEvent = {
  eventType?: string;
  sessionId?: string;
  timestamp?: Date | string;
  metadata?: Record<string, unknown> | null;
};

type OutboxKindStats = {
  pending?: number;
  processing?: number;
  failed?: number;
  retryableFailed?: number;
  quarantinedFailed?: number;
  stuckProcessing?: number;
};

type ProjectOutboxStats = {
  embedding?: OutboxKindStats;
  vector?: OutboxKindStats;
};

// GET /api/projects/:hash/detail - Aggregate project details for the dashboard.
projectsRouter.get('/:hash/detail', async (c) => {
  const { hash } = c.req.param();
  const registry = loadSessionRegistry();
  const projectPath = getRegisteredProjectPath(registry, hash);
  const storagePath = resolveProjectStoragePath(hash);
  const memoryService = new MemoryService({
    storagePath,
    projectHash: hash,
    ...(projectPath ? { projectPath } : {}),
    readOnly: true,
    lightweightMode: true,
    analyticsEnabled: false,
    sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
  });

  try {
    await memoryService.initialize();
    const [stats, recentEvents, retrieval, outbox] = await Promise.all([
      memoryService.getStats(),
      memoryService.getRecentEvents(1000),
      memoryService.getRetrievalTraceStats(),
      memoryService.getOutboxStats()
    ]);

    const eventSummary = summarizeProjectEvents(recentEvents as ProjectDetailEvent[]);
    return c.json({
      project: {
        hash,
        projectName: projectPath ? path.basename(projectPath) : `unknown (${hash})`,
        registered: Boolean(projectPath)
      },
      storage: {
        eventCount: stats.totalEvents,
        vectorCount: stats.vectorCount,
        levels: stats.levelStats || []
      },
      sessions: eventSummary.sessions,
      eventTypes: eventSummary.eventTypes,
      sources: eventSummary.sources,
      activity: eventSummary.activity,
      retrieval: {
        totalQueries: retrieval.totalQueries,
        avgCandidateCount: retrieval.avgCandidateCount,
        avgSelectedCount: retrieval.avgSelectedCount,
        selectionRate: retrieval.selectionRate
      },
      outbox: summarizeProjectOutbox(outbox as ProjectOutboxStats)
    });
  } catch {
    return c.json({ error: 'Project detail unavailable' }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

// GET /api/projects - List available projects
projectsRouter.get('/', async (c) => {
  try {
    const projectsDir = path.join(os.homedir(), '.claude-code', 'memory', 'projects');

    if (!fs.existsSync(projectsDir)) {
      return c.json({ projects: [] });
    }

    // Read project directories
    const projectHashes = fs.readdirSync(projectsDir)
      .filter(name => {
        const fullPath = path.join(projectsDir, name);
        return fs.statSync(fullPath).isDirectory();
      });

    // Load session registry to map hashes to project paths
    const registry = loadSessionRegistry();
    const hashToPath = new Map<string, string>();
    for (const entry of Object.values(registry.sessions)) {
      if (!hashToPath.has(entry.projectHash)) {
        hashToPath.set(entry.projectHash, entry.projectPath);
      }
    }

    // Build project list
    const projects = projectHashes.map(hash => {
      const dirPath = path.join(projectsDir, hash);
      const dbPath = path.join(dirPath, 'events.sqlite');
      let dbSize = 0;
      if (fs.existsSync(dbPath)) {
        dbSize = fs.statSync(dbPath).size;
      }

      const projectPath = hashToPath.get(hash) || `unknown (${hash})`;

      return {
        hash,
        projectPath,
        projectName: path.basename(projectPath),
        dbSize,
        dbSizeHuman: formatBytes(dbSize)
      };
    });

    // Sort by project name
    projects.sort((a, b) => a.projectName.localeCompare(b.projectName));

    return c.json({ projects });
  } catch (error) {
    return c.json({ projects: [], error: (error as Error).message }, 500);
  }
});

function getRegisteredProjectPath(registry: ReturnType<typeof loadSessionRegistry>, hash: string): string | undefined {
  for (const entry of Object.values(registry.sessions)) {
    if (entry.projectHash === hash) {
      return entry.projectPath;
    }
  }
  return undefined;
}

function summarizeProjectEvents(events: ProjectDetailEvent[]) {
  const sessions = new Set<string>();
  const eventTypes: Record<string, number> = {};
  const sources: Record<string, number> = {};
  let firstEventAt: string | null = null;
  let lastEventAt: string | null = null;

  for (const event of events) {
    if (event.sessionId) sessions.add(event.sessionId);
    incrementBucket(eventTypes, event.eventType || 'unknown');
    const source = typeof event.metadata?.source === 'string' ? event.metadata.source : 'unknown';
    incrementBucket(sources, source || 'unknown');
    const timestamp = normalizeIsoTimestamp(event.timestamp);
    if (!timestamp) continue;
    if (!firstEventAt || timestamp < firstEventAt) firstEventAt = timestamp;
    if (!lastEventAt || timestamp > lastEventAt) lastEventAt = timestamp;
  }

  return {
    sessions: { total: sessions.size },
    eventTypes,
    sources,
    activity: { firstEventAt, lastEventAt }
  };
}

function summarizeProjectOutbox(outbox: ProjectOutboxStats) {
  const embedding = outbox.embedding || {};
  const vector = outbox.vector || {};
  return {
    pending: (embedding.pending || 0) + (vector.pending || 0),
    processing: (embedding.processing || 0) + (vector.processing || 0),
    failed: (embedding.failed || 0) + (vector.failed || 0),
    retryableFailed: (embedding.retryableFailed || 0) + (vector.retryableFailed || 0),
    quarantinedFailed: (embedding.quarantinedFailed || 0) + (vector.quarantinedFailed || 0),
    stuckProcessing: (embedding.stuckProcessing || 0) + (vector.stuckProcessing || 0)
  };
}

function incrementBucket(bucket: Record<string, number>, rawLabel: string): void {
  const label = rawLabel.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80) || 'unknown';
  bucket[label] = (bucket[label] || 0) + 1;
}

function normalizeIsoTimestamp(value: Date | string | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
