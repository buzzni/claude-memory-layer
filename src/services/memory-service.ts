/**
 * Memory Service - Main entry point for memory operations
 * Coordinates EventStore, VectorStore, Retriever, and Graduation
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';

import { EventStore } from '../core/event-store.js';
import { SQLiteEventStore } from '../core/sqlite-event-store.js';
import { SyncWorker } from '../core/sync-worker.js';
import { VectorStore } from '../core/vector-store.js';
import { Embedder, getDefaultEmbedder } from '../core/embedder.js';
import { VectorWorker, createVectorWorker } from '../core/vector-worker.js';
import { Matcher, getDefaultMatcher } from '../core/matcher.js';
import { Retriever, createRetriever, RetrievalResult, UnifiedRetrievalResult } from '../core/retriever.js';
import { GraduationPipeline, createGraduationPipeline } from '../core/graduation.js';
import { SharedEventStore, createSharedEventStore } from '../core/shared-event-store.js';
import { SharedStore, createSharedStore } from '../core/shared-store.js';
import { SharedVectorStore, createSharedVectorStore } from '../core/shared-vector-store.js';
import { SharedPromoter, createSharedPromoter, PromotionResult } from '../core/shared-promoter.js';
import type {
  MemoryEventInput,
  AppendResult,
  MemoryEvent,
  Config,
  ConfigSchema,
  ToolObservationPayload,
  MemoryMode,
  EndlessModeConfig,
  EndlessModeConfigSchema,
  WorkingSet,
  ConsolidatedMemory,
  EndlessModeStatus,
  ContextSnapshot,
  ContinuityScore,
  SharedStoreConfig,
  Entry
} from '../core/types.js';
import { createToolObservationEmbedding } from '../core/metadata-extractor.js';
import { WorkingSetStore, createWorkingSetStore } from '../core/working-set-store.js';
import { ConsolidatedStore, createConsolidatedStore } from '../core/consolidated-store.js';
import { ConsolidationWorker, createConsolidationWorker } from '../core/consolidation-worker.js';
import { ContinuityManager, createContinuityManager } from '../core/continuity-manager.js';
import { GraduationWorker, createGraduationWorker, GraduationRunResult } from '../core/graduation-worker.js';
import { MarkdownMirror } from '../core/md-mirror.js';
import {
  IngestInterceptor,
  IngestInterceptorRegistry,
  mergeHierarchicalMetadata
} from '../core/ingest-interceptor.js';
import { normalizeTags } from '../core/tag-taxonomy.js';

export interface MemoryServiceConfig {
  storagePath: string;
  embeddingModel?: string;
  readOnly?: boolean;
  /** Enable DuckDB analytics store (default: true for server, false for hooks) */
  analyticsEnabled?: boolean;
  /** Lightweight mode for hooks - skip heavy initialization (default: false) */
  lightweightMode?: boolean;
}

// ============================================================
// Project Path Utilities
// ============================================================

/**
 * Normalize and resolve a project path, handling symlinks
 */
function normalizePath(projectPath: string): string {
  const expanded = projectPath.startsWith('~')
    ? path.join(os.homedir(), projectPath.slice(1))
    : projectPath;

  try {
    // Resolve symlinks for consistent paths
    return fs.realpathSync(expanded);
  } catch {
    // Path doesn't exist yet, just resolve it
    return path.resolve(expanded);
  }
}

/**
 * Generate a stable 8-character hash from a project path
 */
export function hashProjectPath(projectPath: string): string {
  const normalizedPath = normalizePath(projectPath);
  return crypto.createHash('sha256')
    .update(normalizedPath)
    .digest('hex')
    .slice(0, 8);
}

/**
 * Get the storage path for a specific project
 */
export function getProjectStoragePath(projectPath: string): string {
  const hash = hashProjectPath(projectPath);
  return path.join(os.homedir(), '.claude-code', 'memory', 'projects', hash);
}

// ============================================================
// Session Registry
// ============================================================

const REGISTRY_PATH = path.join(os.homedir(), '.claude-code', 'memory', 'session-registry.json');
const SHARED_STORAGE_PATH = path.join(os.homedir(), '.claude-code', 'memory', 'shared');

export interface SessionRegistryEntry {
  projectPath: string;
  projectHash: string;
  registeredAt: string;
}

export interface SessionRegistry {
  version: number;
  sessions: Record<string, SessionRegistryEntry>;
}

export function loadSessionRegistry(): SessionRegistry {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const data = fs.readFileSync(REGISTRY_PATH, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Failed to load session registry:', error);
  }
  return { version: 1, sessions: {} };
}

function saveSessionRegistry(registry: SessionRegistry): void {
  const dir = path.dirname(REGISTRY_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Atomic write using temp file
  const tempPath = REGISTRY_PATH + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2));
  fs.renameSync(tempPath, REGISTRY_PATH);
}

/**
 * Register a session with its project path
 */
export function registerSession(sessionId: string, projectPath: string): void {
  const registry = loadSessionRegistry();

  registry.sessions[sessionId] = {
    projectPath: normalizePath(projectPath),
    projectHash: hashProjectPath(projectPath),
    registeredAt: new Date().toISOString()
  };

  // Clean up old sessions (keep last 1000)
  const entries = Object.entries(registry.sessions);
  if (entries.length > 1000) {
    const sorted = entries.sort((a, b) =>
      new Date(b[1].registeredAt).getTime() - new Date(a[1].registeredAt).getTime()
    );
    registry.sessions = Object.fromEntries(sorted.slice(0, 1000));
  }

  saveSessionRegistry(registry);
}

/**
 * Get the project path for a session
 */
export function getSessionProject(sessionId: string): SessionRegistryEntry | null {
  const registry = loadSessionRegistry();
  return registry.sessions[sessionId] || null;
}

export class MemoryService {
  // Primary store: SQLite (WAL mode) - for hooks, always available
  private readonly sqliteStore: SQLiteEventStore;
  // Analytics store: DuckDB - for server reads (optional, synced from SQLite)
  private readonly analyticsStore: EventStore | null;
  private syncWorker: SyncWorker | null = null;

  private readonly vectorStore: VectorStore;
  private readonly embedder: Embedder;
  private readonly matcher: Matcher;
  private readonly retriever: Retriever;
  private readonly graduation: GraduationPipeline;
  private vectorWorker: VectorWorker | null = null;
  private graduationWorker: GraduationWorker | null = null;
  private initialized = false;
  private readonly ingestInterceptors = new IngestInterceptorRegistry();

  // Endless Mode components
  private workingSetStore: WorkingSetStore | null = null;
  private consolidatedStore: ConsolidatedStore | null = null;
  private consolidationWorker: ConsolidationWorker | null = null;
  private continuityManager: ContinuityManager | null = null;
  private endlessMode: MemoryMode = 'session';

  // Shared Store components (cross-project knowledge)
  private sharedEventStore: SharedEventStore | null = null;
  private sharedStore: SharedStore | null = null;
  private sharedVectorStore: SharedVectorStore | null = null;
  private sharedPromoter: SharedPromoter | null = null;
  private sharedStoreConfig: SharedStoreConfig | null = null;
  private projectHash: string | null = null;
  private projectPath: string | null = null;

  private readonly readOnly: boolean;
  private readonly lightweightMode: boolean;
  private readonly mdMirror: MarkdownMirror;

  constructor(config: MemoryServiceConfig & { projectHash?: string; projectPath?: string; sharedStoreConfig?: SharedStoreConfig }) {
    const storagePath = this.expandPath(config.storagePath);
    this.readOnly = config.readOnly ?? false;
    this.lightweightMode = config.lightweightMode ?? false;
    this.mdMirror = new MarkdownMirror(process.cwd());

    // Ensure storage directory exists (only if not read-only)
    if (!this.readOnly && !fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }

    // Store project hash for shared store operations
    this.projectHash = config.projectHash || null;
    this.projectPath = config.projectPath || null;
    // Default: shared store enabled
    this.sharedStoreConfig = config.sharedStoreConfig ?? { enabled: true };

    // Initialize PRIMARY store: SQLite (WAL mode)
    // This is always used for writes and is the source of truth
    this.sqliteStore = new SQLiteEventStore(
      path.join(storagePath, 'events.sqlite'),
      {
        readonly: this.readOnly,
        markdownMirrorRoot: storagePath
      }
    );

    // Initialize ANALYTICS store: DuckDB (optional, for server reads)
    // Hooks set analyticsEnabled=false to avoid DuckDB lock conflicts
    const analyticsEnabled = config.analyticsEnabled ?? this.readOnly; // Default: enabled only for read-only (server)

    if (!analyticsEnabled) {
      // Hook mode: skip DuckDB entirely to avoid lock conflicts
      this.analyticsStore = null;
    } else if (this.readOnly) {
      // Server mode: try to use DuckDB for analytics, will fallback to SQLite
      try {
        this.analyticsStore = new EventStore(
          path.join(storagePath, 'analytics.duckdb'),
          { readOnly: true }
        );
      } catch {
        // DuckDB not available, will use SQLite for reads
        this.analyticsStore = null;
      }
    } else {
      // Writer mode with analytics: create DuckDB for sync target
      this.analyticsStore = new EventStore(
        path.join(storagePath, 'analytics.duckdb'),
        { readOnly: false }
      );
    }

    this.vectorStore = new VectorStore(path.join(storagePath, 'vectors'));
    this.embedder = config.embeddingModel
      ? new Embedder(config.embeddingModel)
      : getDefaultEmbedder();
    this.matcher = getDefaultMatcher();
    // Retriever uses SQLite as primary (always available)
    this.retriever = createRetriever(
      this.sqliteStore as unknown as EventStore, // Interface compatible
      this.vectorStore,
      this.embedder,
      this.matcher
    );
    this.retriever.setQueryRewriter((q) => this.rewriteQueryIntent(q));
    this.graduation = createGraduationPipeline(this.sqliteStore as unknown as EventStore);
  }

  /**
   * Initialize all components
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize PRIMARY store: SQLite (always)
    await this.sqliteStore.initialize();

    // Lightweight mode: only SQLite, no embedder/vector/workers
    // Used for hooks that just need to store data quickly
    if (this.lightweightMode) {
      this.initialized = true;
      return;
    }

    // Initialize analytics store if available (DuckDB)
    if (this.analyticsStore) {
      try {
        await this.analyticsStore.initialize();
      } catch (error) {
        console.warn('[MemoryService] Analytics store (DuckDB) initialization failed, using SQLite for reads:', error);
        // Continue without analytics - SQLite will be used for reads
      }
    }

    await this.vectorStore.initialize();
    await this.embedder.initialize();

    // Skip write-related workers in read-only mode
    if (!this.readOnly) {
      // Start vector worker (uses SQLite as source)
      this.vectorWorker = createVectorWorker(
        this.sqliteStore as unknown as EventStore,
        this.vectorStore,
        this.embedder
      );
      this.vectorWorker.start();

      // Connect graduation pipeline to retriever for access tracking
      this.retriever.setGraduationPipeline(this.graduation);

      // Start graduation worker for automatic level promotion
      this.graduationWorker = createGraduationWorker(
        this.sqliteStore as unknown as EventStore,
        this.graduation
      );
      this.graduationWorker.start();

      // Start sync worker (SQLite -> DuckDB) if analytics store is available
      if (this.analyticsStore) {
        this.syncWorker = new SyncWorker(
          this.sqliteStore,
          this.analyticsStore,
          { intervalMs: 30000, batchSize: 500 }
        );
        this.syncWorker.start();
      }

      // Load endless mode setting
      const savedMode = await this.sqliteStore.getEndlessConfig('mode') as MemoryMode | null;
      if (savedMode === 'endless') {
        this.endlessMode = 'endless';
        await this.initializeEndlessMode();
      }

      // Initialize shared store (enabled by default)
      if (this.sharedStoreConfig?.enabled !== false) {
        await this.initializeSharedStore();
      }
    }

    this.initialized = true;
  }

  /**
   * Initialize Shared Store components
   */
  private async initializeSharedStore(): Promise<void> {
    const sharedPath = this.sharedStoreConfig?.sharedStoragePath
      ? this.expandPath(this.sharedStoreConfig.sharedStoragePath)
      : SHARED_STORAGE_PATH;

    // Ensure shared directory exists
    if (!fs.existsSync(sharedPath)) {
      fs.mkdirSync(sharedPath, { recursive: true });
    }

    this.sharedEventStore = createSharedEventStore(
      path.join(sharedPath, 'shared.duckdb')
    );
    await this.sharedEventStore.initialize();

    this.sharedStore = createSharedStore(this.sharedEventStore);
    this.sharedVectorStore = createSharedVectorStore(
      path.join(sharedPath, 'vectors')
    );
    await this.sharedVectorStore.initialize();

    this.sharedPromoter = createSharedPromoter(
      this.sharedStore,
      this.sharedVectorStore,
      this.embedder,
      this.sharedStoreConfig || undefined
    );

    // Connect shared stores to retriever
    this.retriever.setSharedStores(this.sharedStore, this.sharedVectorStore);
  }

  registerIngestBefore(interceptor: IngestInterceptor): () => void {
    return this.ingestInterceptors.registerBefore(interceptor);
  }

  registerIngestAfter(interceptor: IngestInterceptor): () => void {
    return this.ingestInterceptors.registerAfter(interceptor);
  }

  registerIngestOnError(interceptor: IngestInterceptor): () => void {
    return this.ingestInterceptors.registerOnError(interceptor);
  }

  private async ingestWithInterceptors(
    operation: 'user_prompt' | 'agent_response' | 'session_summary' | 'tool_observation',
    input: MemoryEventInput,
    onSuccess?: (eventId: string) => Promise<void>
  ): Promise<AppendResult> {
    const normalizedInput: MemoryEventInput = {
      ...input,
      metadata: mergeHierarchicalMetadata(
        {
          ingest: {
            operation,
            pipeline: 'default',
            ts: new Date().toISOString()
          },
          ...(this.projectHash
            ? {
                scope: {
                  project: {
                    hash: this.projectHash,
                    ...(this.projectPath ? { path: this.projectPath } : {})
                  }
                },
                tags: [`proj:${this.projectHash}`]
              }
            : {})
        },
        input.metadata
      )
    };

    if (this.projectHash && normalizedInput.metadata) {
      const meta = normalizedInput.metadata as Record<string, unknown>;
      const currentTags = Array.isArray(meta.tags)
        ? meta.tags.filter((x): x is string => typeof x === 'string')
        : [];
      const projectTag = `proj:${this.projectHash}`;
      if (!currentTags.includes(projectTag)) {
        meta.tags = [...currentTags, projectTag];
      }
    }

    if (normalizedInput.metadata) {
      const meta = normalizedInput.metadata as Record<string, unknown>;
      const normalizedTags = normalizeTags(meta.tags);
      if (normalizedTags.length > 0) {
        meta.tags = normalizedTags;
      }
    }

    await this.ingestInterceptors.run('before', {
      operation,
      sessionId: normalizedInput.sessionId,
      event: normalizedInput
    });

    try {
      const result = await this.sqliteStore.append(normalizedInput);
      if (result.success && !result.isDuplicate) {
        if (onSuccess) {
          await onSuccess(result.eventId);
        }
        try {
          await this.mdMirror.append(normalizedInput, result.eventId);
        } catch {
          // non-breaking markdown mirror write
        }
      }

      await this.ingestInterceptors.run('after', {
        operation,
        sessionId: normalizedInput.sessionId,
        event: normalizedInput
      });

      return result;
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      await this.ingestInterceptors.run('error', {
        operation,
        sessionId: normalizedInput.sessionId,
        event: normalizedInput,
        error: normalizedError
      });
      throw error;
    }
  }

  /**
   * Start a new session
   */
  async startSession(sessionId: string, projectPath?: string): Promise<void> {
    await this.initialize();

    await this.sqliteStore.upsertSession({
      id: sessionId,
      startedAt: new Date(),
      projectPath
    });
  }

  /**
   * End a session
   */
  async endSession(sessionId: string, summary?: string): Promise<void> {
    await this.initialize();

    await this.sqliteStore.upsertSession({
      id: sessionId,
      endedAt: new Date(),
      summary
    });
  }

  /**
   * Store a user prompt
   */
  async storeUserPrompt(
    sessionId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<AppendResult> {
    await this.initialize();

    return this.ingestWithInterceptors(
      'user_prompt',
      {
        eventType: 'user_prompt',
        sessionId,
        timestamp: new Date(),
        content,
        metadata
      },
      async (eventId) => {
        await this.sqliteStore.enqueueForEmbedding(eventId, content);
      }
    );
  }

  /**
   * Store an agent response
   */
  async storeAgentResponse(
    sessionId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<AppendResult> {
    await this.initialize();

    return this.ingestWithInterceptors(
      'agent_response',
      {
        eventType: 'agent_response',
        sessionId,
        timestamp: new Date(),
        content,
        metadata
      },
      async (eventId) => {
        await this.sqliteStore.enqueueForEmbedding(eventId, content);
      }
    );
  }

  /**
   * Store a session summary
   */
  async storeSessionSummary(
    sessionId: string,
    summary: string,
    metadata?: Record<string, unknown>
  ): Promise<AppendResult> {
    await this.initialize();

    return this.ingestWithInterceptors(
      'session_summary',
      {
        eventType: 'session_summary',
        sessionId,
        timestamp: new Date(),
        content: summary,
        metadata
      },
      async (eventId) => {
        await this.sqliteStore.enqueueForEmbedding(eventId, summary);
      }
    );
  }

  /**
   * Store a tool observation
   */
  async storeToolObservation(
    sessionId: string,
    payload: ToolObservationPayload
  ): Promise<AppendResult> {
    await this.initialize();

    // Create content for storage (JSON stringified payload)
    const content = JSON.stringify(payload);

    // Extract turnId from payload metadata if present (set by PostToolUse hook)
    const turnId = payload.metadata?.turnId;

    return this.ingestWithInterceptors(
      'tool_observation',
      {
        eventType: 'tool_observation',
        sessionId,
        timestamp: new Date(),
        content,
        metadata: {
          toolName: payload.toolName,
          success: payload.success,
          ...(turnId ? { turnId } : {})
        }
      },
      async (eventId) => {
        const embeddingContent = createToolObservationEmbedding(
          payload.toolName,
          payload.metadata || {},
          payload.success
        );
        await this.sqliteStore.enqueueForEmbedding(eventId, embeddingContent);
      }
    );
  }

  /**
   * Retrieve relevant memories for a query
   */
  async retrieveMemories(
    query: string,
    options?: {
      topK?: number;
      minScore?: number;
      sessionId?: string;
      includeShared?: boolean;
      adaptiveRerank?: boolean;
      intentRewrite?: boolean;
      projectScopeMode?: 'strict' | 'prefer' | 'global';
      allowedProjectHashes?: string[];
    }
  ): Promise<UnifiedRetrievalResult> {
    await this.initialize();

    // Note: Pending embeddings are processed by the background worker
    // Don't block retrieval - search with whatever vectors are available

    const rerankWeights = await this.getRerankWeights(options?.adaptiveRerank === true);

    // Use unified retrieval if shared search is requested
    if (options?.includeShared && this.sharedStore) {
      return this.retriever.retrieveUnified(query, {
        ...options,
        intentRewrite: options?.intentRewrite === true,
        rerankWeights,
        includeShared: true,
        projectHash: this.projectHash || undefined,
        projectScopeMode: options?.projectScopeMode ?? (this.projectHash ? 'strict' : 'global'),
        allowedProjectHashes: options?.allowedProjectHashes
      });
    }

    return this.retriever.retrieve(query, {
      ...options,
      intentRewrite: options?.intentRewrite === true,
      rerankWeights,
      projectHash: this.projectHash || undefined,
      projectScopeMode: options?.projectScopeMode ?? (this.projectHash ? 'strict' : 'global'),
      allowedProjectHashes: options?.allowedProjectHashes
    });
  }

  private getConfiguredRerankWeights(): { semantic: number; lexical: number; recency: number } | undefined {
    const semantic = Number(process.env.MEMORY_RERANK_WEIGHT_SEMANTIC ?? '');
    const lexical = Number(process.env.MEMORY_RERANK_WEIGHT_LEXICAL ?? '');
    const recency = Number(process.env.MEMORY_RERANK_WEIGHT_RECENCY ?? '');

    const allFinite = [semantic, lexical, recency].every((v) => Number.isFinite(v));
    if (!allFinite) return undefined;

    const nonNegative = [semantic, lexical, recency].every((v) => v >= 0);
    const total = semantic + lexical + recency;
    if (!nonNegative || total <= 0) return undefined;

    return {
      semantic: semantic / total,
      lexical: lexical / total,
      recency: recency / total,
    };
  }

  private async getRerankWeights(adaptive: boolean): Promise<{ semantic: number; lexical: number; recency: number } | undefined> {
    const configured = this.getConfiguredRerankWeights();
    if (configured) return configured;
    if (adaptive) return this.getAdaptiveRerankWeights();
    return undefined;
  }

  private async rewriteQueryIntent(query: string): Promise<string | null> {
    if (process.env.MEMORY_INTENT_REWRITE_ENABLED !== '1') return null;

    const apiUrl = process.env.COMPANY_STOCK_API_URL || process.env.COMPANY_INT_API_URL;
    if (!apiUrl) return null;

    const controller = new AbortController();
    const timeoutMs = Number(process.env.MEMORY_INTENT_REWRITE_TIMEOUT_MS || 5000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const prompt = [
        'Rewrite user query for memory retrieval intent expansion.',
        'Return plain text only, one line, no markdown.',
        `Query: ${query}`,
      ].join('\n');

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: '*/*',
          Origin: process.env.COMPANY_INT_ORIGIN || 'http://company-int.aplusai.ai',
          Referer: process.env.COMPANY_INT_REFERER || 'http://company-int.aplusai.ai/',
        },
        body: JSON.stringify({
          question: prompt,
          company_name: null,
          conversation_id: null,
        }),
        signal: controller.signal,
      });

      const text = (await res.text()).trim();
      if (!text) return null;

      const oneLine = text
        .replace(/^data:\s*/gm, '')
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 240);

      if (!oneLine || oneLine.toLowerCase() === query.toLowerCase()) return null;
      return oneLine;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getAdaptiveRerankWeights(): Promise<{ semantic: number; lexical: number; recency: number } | undefined> {
    try {
      const s = await this.sqliteStore.getHelpfulnessStats();
      if (s.totalEvaluated < 20) return undefined;

      // base weights
      let semantic = 0.7;
      let lexical = 0.2;
      let recency = 0.1;

      if (s.avgScore < 0.45) {
        semantic -= 0.1;
        lexical += 0.1;
      } else if (s.avgScore > 0.75) {
        semantic += 0.05;
        lexical -= 0.05;
      }

      if (s.unhelpful > s.helpful) {
        recency += 0.05;
        semantic -= 0.03;
        lexical -= 0.02;
      }

      return { semantic, lexical, recency };
    } catch {
      return undefined;
    }
  }

  /**
   * Fast keyword search using SQLite FTS5
   * Much faster than vector search - no embedding model needed
   */
  async keywordSearch(
    query: string,
    options?: { topK?: number; minScore?: number }
  ): Promise<Array<{event: MemoryEvent; score: number}>> {
    await this.initialize();

    const results = await this.sqliteStore.keywordSearch(query, options?.topK ?? 10);

    // Normalize FTS5 rank to a score (0-1 range)
    // FTS5 rank is negative (higher is worse), so we convert it
    const maxRank = Math.min(...results.map(r => r.rank), -0.001);
    const minRank = Math.max(...results.map(r => r.rank), -1000);
    const rankRange = maxRank - minRank || 1;

    return results.map(r => ({
      event: r.event,
      score: 1 - (r.rank - minRank) / rankRange  // Normalize to 0-1
    })).filter(r => !options?.minScore || r.score >= options.minScore);
  }

  /**
   * Rebuild FTS index (call after database upgrade)
   */
  async rebuildFtsIndex(): Promise<number> {
    await this.initialize();
    return this.sqliteStore.rebuildFtsIndex();
  }

  /**
   * Get session history
   */
  async getSessionHistory(sessionId: string): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.sqliteStore.getSessionEvents(sessionId);
  }

  /**
   * Get recent events
   */
  async getRecentEvents(limit: number = 100): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.sqliteStore.getRecentEvents(limit);
  }

  /**
   * Get memory statistics
   */
  async getStats(): Promise<{
    totalEvents: number;
    vectorCount: number;
    levelStats: Array<{ level: string; count: number }>;
  }> {
    await this.initialize();

    const recentEvents = await this.sqliteStore.getRecentEvents(10000);
    const vectorCount = await this.vectorStore.count();
    const levelStats = await this.graduation.getStats();

    return {
      totalEvents: recentEvents.length,
      vectorCount,
      levelStats
    };
  }

  /**
   * Process pending embeddings
   */
  async processPendingEmbeddings(): Promise<number> {
    if (this.vectorWorker) {
      return this.vectorWorker.processAll();
    }
    return 0;
  }

  /**
   * Get events by memory level
   */
  async getEventsByLevel(level: string, options?: { limit?: number; offset?: number }): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.sqliteStore.getEventsByLevel(level, options);
  }

  /**
   * Get memory level for a specific event
   */
  async getEventLevel(eventId: string): Promise<string | null> {
    await this.initialize();
    return this.sqliteStore.getEventLevel(eventId);
  }

  /**
   * Format retrieval results as context for Claude
   */
  formatAsContext(result: RetrievalResult): string {
    if (!result.context) {
      return '';
    }

    const confidence = result.matchResult.confidence;
    let header = '';

    if (confidence === 'high') {
      header = '🎯 **High-confidence memory match found:**\n\n';
    } else if (confidence === 'suggested') {
      header = '💡 **Suggested memories (may be relevant):**\n\n';
    }

    return header + result.context;
  }

  // ============================================================
  // Shared Store Methods (Cross-Project Knowledge)
  // ============================================================

  /**
   * Check if shared store is enabled and initialized
   */
  isSharedStoreEnabled(): boolean {
    return this.sharedStore !== null;
  }

  /**
   * Promote an entry to shared storage
   */
  async promoteToShared(entry: Entry): Promise<PromotionResult> {
    if (!this.sharedPromoter || !this.projectHash) {
      return {
        success: false,
        error: 'Shared store not initialized or project hash not set'
      };
    }

    return this.sharedPromoter.promoteEntry(entry, this.projectHash);
  }

  /**
   * Get shared store statistics
   */
  async getSharedStoreStats(): Promise<{
    total: number;
    averageConfidence: number;
    topTopics: Array<{ topic: string; count: number }>;
    totalUsageCount: number;
  } | null> {
    if (!this.sharedStore) return null;
    return this.sharedStore.getStats();
  }

  /**
   * Search shared troubleshooting entries
   */
  async searchShared(
    query: string,
    options?: { topK?: number; minConfidence?: number }
  ) {
    if (!this.sharedStore) return [];
    return this.sharedStore.search(query, options);
  }

  /**
   * Get project hash for this service
   */
  getProjectHash(): string | null {
    return this.projectHash;
  }

  // ============================================================
  // Endless Mode Methods
  // ============================================================

  /**
   * Get the default endless mode config
   */
  private getDefaultEndlessConfig(): EndlessModeConfig {
    return {
      enabled: true,
      workingSet: {
        maxEvents: 100,
        timeWindowHours: 24,
        minRelevanceScore: 0.5
      },
      consolidation: {
        triggerIntervalMs: 3600000, // 1 hour
        triggerEventCount: 100,
        triggerIdleMs: 1800000, // 30 minutes
        useLLMSummarization: false
      },
      continuity: {
        minScoreForSeamless: 0.7,
        topicDecayHours: 48
      }
    };
  }

  /**
   * Initialize Endless Mode components
   */
  async initializeEndlessMode(): Promise<void> {
    const config = await this.getEndlessConfig();

    this.workingSetStore = createWorkingSetStore(this.sqliteStore, config);
    this.consolidatedStore = createConsolidatedStore(this.sqliteStore);
    this.consolidationWorker = createConsolidationWorker(
      this.workingSetStore,
      this.consolidatedStore,
      config
    );
    this.continuityManager = createContinuityManager(this.sqliteStore, config);

    // Start consolidation worker
    this.consolidationWorker.start();
  }

  /**
   * Get Endless Mode configuration
   */
  async getEndlessConfig(): Promise<EndlessModeConfig> {
    const savedConfig = await this.sqliteStore.getEndlessConfig('config') as EndlessModeConfig | null;
    return savedConfig || this.getDefaultEndlessConfig();
  }

  /**
   * Set Endless Mode configuration
   */
  async setEndlessConfig(config: Partial<EndlessModeConfig>): Promise<void> {
    const current = await this.getEndlessConfig();
    const merged = { ...current, ...config };
    await this.sqliteStore.setEndlessConfig('config', merged);
  }

  /**
   * Set memory mode (session or endless)
   */
  async setMode(mode: MemoryMode): Promise<void> {
    await this.initialize();

    if (mode === this.endlessMode) return;

    this.endlessMode = mode;
    await this.sqliteStore.setEndlessConfig('mode', mode);

    if (mode === 'endless') {
      await this.initializeEndlessMode();
    } else {
      // Stop endless mode components
      if (this.consolidationWorker) {
        this.consolidationWorker.stop();
        this.consolidationWorker = null;
      }
      this.workingSetStore = null;
      this.consolidatedStore = null;
      this.continuityManager = null;
    }
  }

  /**
   * Get current memory mode
   */
  getMode(): MemoryMode {
    return this.endlessMode;
  }

  /**
   * Check if endless mode is active
   */
  isEndlessModeActive(): boolean {
    return this.endlessMode === 'endless';
  }

  /**
   * Add event to Working Set (Endless Mode)
   */
  async addToWorkingSet(eventId: string, relevanceScore?: number): Promise<void> {
    if (!this.workingSetStore) return;
    await this.workingSetStore.add(eventId, relevanceScore);
  }

  /**
   * Get the current Working Set
   */
  async getWorkingSet(): Promise<WorkingSet | null> {
    if (!this.workingSetStore) return null;
    return this.workingSetStore.get();
  }

  /**
   * Search consolidated memories
   */
  async searchConsolidated(
    query: string,
    options?: { topK?: number }
  ): Promise<ConsolidatedMemory[]> {
    if (!this.consolidatedStore) return [];
    return this.consolidatedStore.search(query, options);
  }

  /**
   * Get all consolidated memories
   */
  async getConsolidatedMemories(limit?: number): Promise<ConsolidatedMemory[]> {
    if (!this.consolidatedStore) return [];
    return this.consolidatedStore.getAll({ limit });
  }

  /**
   * Extract topic keywords from event content (markdown headings and key terms)
   */
  private extractTopicsFromContent(content: string): string[] {
    const topics: Set<string> = new Set();

    // Extract markdown headings (## heading)
    const headings = content.match(/^#{1,3}\s+(.+)$/gm);
    if (headings) {
      for (const h of headings.slice(0, 5)) {
        const text = h.replace(/^#+\s+/, '').replace(/[*_`#]/g, '').trim();
        if (text.length > 2 && text.length < 50) {
          topics.add(text);
        }
      }
    }

    // Extract bold terms (**term**)
    const boldTerms = content.match(/\*\*([^*]+)\*\*/g);
    if (boldTerms) {
      for (const b of boldTerms.slice(0, 5)) {
        const text = b.replace(/\*\*/g, '').trim();
        if (text.length > 2 && text.length < 30) {
          topics.add(text);
        }
      }
    }

    return Array.from(topics).slice(0, 5);
  }

  /**
   * Increment access count for memories that were used in prompts
   */
  async incrementMemoryAccess(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;

    // Use SQLite event store if available
    if (this.sqliteStore) {
      await this.sqliteStore.incrementAccessCount(eventIds);
    } else if (this.eventStore) {
      // Fallback to regular event store (which has a stub implementation)
      await this.eventStore.incrementAccessCount(eventIds);
    }
  }

  /**
   * Get most accessed memories from events
   */
  async getMostAccessedMemories(limit: number = 10): Promise<any[]> {
    console.log('[getMostAccessedMemories] sqliteStore available:', !!this.sqliteStore);

    // Try to get from SQLite event store if available
    if (this.sqliteStore) {
      const events = await this.sqliteStore.getMostAccessed(limit);
      console.log('[getMostAccessedMemories] Got events from SQLite:', events.length);
      return events.map(event => ({
        memoryId: event.id,
        summary: event.content.substring(0, 200) + (event.content.length > 200 ? '...' : ''),
        topics: this.extractTopicsFromContent(event.content),
        accessCount: (event as any).access_count || 0,
        lastAccessed: (event as any).last_accessed_at || null,
        confidence: 1.0,
        createdAt: event.timestamp
      }));
    }

    // Fallback to consolidated store if available
    if (this.consolidatedStore) {
      const consolidated = await this.consolidatedStore.getMostAccessed(limit);
      return consolidated.map(m => ({
        memoryId: m.memoryId,
        summary: m.summary,
        topics: m.topics,
        accessCount: m.accessCount,
        lastAccessed: m.accessedAt,
        confidence: m.confidence,
        createdAt: m.createdAt
      }));
    }

    return [];
  }

  /**
   * Record a memory retrieval for helpfulness tracking
   */
  async recordRetrieval(eventId: string, sessionId: string, score: number, query: string): Promise<void> {
    await this.initialize();
    await this.sqliteStore.recordRetrieval(eventId, sessionId, score, query);
  }

  /**
   * Evaluate helpfulness of retrievals in a session (called at session end)
   */
  async evaluateSessionHelpfulness(sessionId: string): Promise<void> {
    await this.initialize();
    await this.sqliteStore.evaluateSessionHelpfulness(sessionId);
  }

  /**
   * Get most helpful memories ranked by helpfulness score
   */
  async getHelpfulMemories(limit: number = 10): Promise<Array<{
    eventId: string;
    summary: string;
    helpfulnessScore: number;
    accessCount: number;
    evaluationCount: number;
  }>> {
    await this.initialize();
    return this.sqliteStore.getHelpfulMemories(limit);
  }

  /**
   * Get helpfulness statistics for dashboard
   */
  async getHelpfulnessStats(): Promise<{
    avgScore: number;
    totalEvaluated: number;
    totalRetrievals: number;
    helpful: number;
    neutral: number;
    unhelpful: number;
  }> {
    await this.initialize();
    return this.sqliteStore.getHelpfulnessStats();
  }

  /**
   * Mark a consolidated memory as accessed
   */
  async markMemoryAccessed(memoryId: string): Promise<void> {
    if (!this.consolidatedStore) return;
    await this.consolidatedStore.markAccessed(memoryId);
  }

  /**
   * Calculate continuity score for current context
   */
  async calculateContinuity(
    content: string,
    metadata?: { files?: string[]; entities?: string[] }
  ): Promise<ContinuityScore | null> {
    if (!this.continuityManager) return null;

    const snapshot = this.continuityManager.createSnapshot(
      crypto.randomUUID(),
      content,
      metadata
    );

    return this.continuityManager.calculateScore(snapshot);
  }

  /**
   * Record activity (for consolidation idle trigger)
   */
  recordActivity(): void {
    if (this.consolidationWorker) {
      this.consolidationWorker.recordActivity();
    }
  }

  /**
   * Force a consolidation run
   */
  async forceConsolidation(): Promise<number> {
    if (!this.consolidationWorker) return 0;
    return this.consolidationWorker.forceRun();
  }

  /**
   * Get Endless Mode status
   */
  async getEndlessModeStatus(): Promise<EndlessModeStatus> {
    await this.initialize();

    let workingSetSize = 0;
    let continuityScore = 0.5;
    let consolidatedCount = 0;
    let lastConsolidation: Date | null = null;

    if (this.workingSetStore) {
      workingSetSize = await this.workingSetStore.count();
      const workingSet = await this.workingSetStore.get();
      continuityScore = workingSet.continuityScore;
    }

    if (this.consolidatedStore) {
      consolidatedCount = await this.consolidatedStore.count();
      lastConsolidation = await this.consolidatedStore.getLastConsolidationTime();
    }

    return {
      mode: this.endlessMode,
      workingSetSize,
      continuityScore,
      consolidatedCount,
      lastConsolidation
    };
  }

  // ============================================================
  // Turn Grouping Methods
  // ============================================================

  /**
   * Get events grouped by turn for a session
   */
  async getSessionTurns(sessionId: string, options?: { limit?: number; offset?: number }): Promise<Array<{
    turnId: string;
    events: MemoryEvent[];
    startedAt: Date;
    promptPreview: string;
    eventCount: number;
    toolCount: number;
    hasResponse: boolean;
  }>> {
    await this.initialize();
    return this.sqliteStore.getSessionTurns(sessionId, options);
  }

  /**
   * Get all events for a specific turn
   */
  async getEventsByTurn(turnId: string): Promise<MemoryEvent[]> {
    await this.initialize();
    return this.sqliteStore.getEventsByTurn(turnId);
  }

  /**
   * Count total turns for a session
   */
  async countSessionTurns(sessionId: string): Promise<number> {
    await this.initialize();
    return this.sqliteStore.countSessionTurns(sessionId);
  }

  /**
   * Backfill turn_ids from metadata for events stored before the migration
   */
  async backfillTurnIds(): Promise<number> {
    await this.initialize();
    return this.sqliteStore.backfillTurnIds();
  }

  /**
   * Delete all events for a session (for force reimport)
   */
  async deleteSessionEvents(sessionId: string): Promise<number> {
    await this.initialize();
    return this.sqliteStore.deleteSessionEvents(sessionId);
  }

  /**
   * Format Endless Mode context for Claude
   */
  async formatEndlessContext(query: string): Promise<string> {
    if (!this.isEndlessModeActive()) {
      return '';
    }

    const workingSet = await this.getWorkingSet();
    const consolidated = await this.searchConsolidated(query, { topK: 3 });
    const continuity = await this.calculateContinuity(query);

    const parts: string[] = [];

    // Continuity status
    if (continuity) {
      const statusEmoji = continuity.transitionType === 'seamless' ? '🔗' :
                          continuity.transitionType === 'topic_shift' ? '↪️' : '🆕';
      parts.push(`${statusEmoji} Context: ${continuity.transitionType} (score: ${continuity.score.toFixed(2)})`);
    }

    // Working set summary
    if (workingSet && workingSet.recentEvents.length > 0) {
      parts.push('\n## Recent Context (Working Set)');
      const recent = workingSet.recentEvents.slice(0, 5);
      for (const event of recent) {
        const preview = event.content.slice(0, 80) + (event.content.length > 80 ? '...' : '');
        const time = event.timestamp.toLocaleTimeString();
        parts.push(`- ${time} [${event.eventType}] ${preview}`);
      }
    }

    // Consolidated memories
    if (consolidated.length > 0) {
      parts.push('\n## Related Knowledge (Consolidated)');
      for (const memory of consolidated) {
        parts.push(`- ${memory.topics.slice(0, 3).join(', ')}: ${memory.summary.slice(0, 100)}...`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Force a graduation evaluation run
   */
  async forceGraduation(): Promise<GraduationRunResult> {
    if (!this.graduationWorker) {
      return { evaluated: 0, graduated: 0, byLevel: {} };
    }
    return this.graduationWorker.forceRun();
  }

  /**
   * Record access to a memory event (for graduation scoring)
   */
  recordMemoryAccess(eventId: string, sessionId: string, confidence: number = 1.0): void {
    this.graduation.recordAccess(eventId, sessionId, confidence);
  }

  /**
   * Shutdown service
   */
  async shutdown(): Promise<void> {
    // Stop graduation worker
    if (this.graduationWorker) {
      this.graduationWorker.stop();
    }

    // Stop endless mode components
    if (this.consolidationWorker) {
      this.consolidationWorker.stop();
    }

    if (this.vectorWorker) {
      this.vectorWorker.stop();
    }

    // Stop sync worker
    if (this.syncWorker) {
      this.syncWorker.stop();
    }

    // Close shared store
    if (this.sharedEventStore) {
      await this.sharedEventStore.close();
    }

    // Close primary store (SQLite)
    await this.sqliteStore.close();

    // Close analytics store (DuckDB)
    if (this.analyticsStore) {
      await this.analyticsStore.close();
    }
  }

  /**
   * Expand ~ to home directory
   */
  private expandPath(p: string): string {
    if (p.startsWith('~')) {
      return path.join(os.homedir(), p.slice(1));
    }
    return p;
  }
}

// ============================================================
// Service Instance Management
// ============================================================

// Instance cache: Map from project hash (or '__global__') to MemoryService
const serviceCache = new Map<string, MemoryService>();
const GLOBAL_KEY = '__global__';
const GLOBAL_READONLY_KEY = '__global_readonly__';

/**
 * Get the global memory service (backward compatibility)
 * Use this for operations not tied to a specific project
 * Note: analyticsEnabled=false and sharedStore disabled to avoid DuckDB lock conflicts
 */
export function getDefaultMemoryService(): MemoryService {
  if (!serviceCache.has(GLOBAL_KEY)) {
    serviceCache.set(GLOBAL_KEY, new MemoryService({
      storagePath: '~/.claude-code/memory',
      analyticsEnabled: false,  // Hooks don't need DuckDB
      sharedStoreConfig: { enabled: false }  // Shared store uses DuckDB too
    }));
  }
  return serviceCache.get(GLOBAL_KEY)!;
}

/**
 * Get a read-only global memory service
 * Use this for web server/dashboard that only needs to read data
 * Creates a fresh connection each time to avoid blocking the main writer process
 * Uses SQLite (WAL mode) which supports concurrent readers
 */
export function getReadOnlyMemoryService(): MemoryService {
  // Don't cache - create fresh instance each time to avoid holding locks
  // The connection will be closed when the request completes
  // Uses SQLite which supports concurrent readers via WAL mode
  return new MemoryService({
    storagePath: '~/.claude-code/memory',
    readOnly: true,
    analyticsEnabled: false,  // Use SQLite for reads (WAL supports concurrent readers)
    sharedStoreConfig: { enabled: false }  // Skip shared store for now
  });
}

/**
 * Get memory service for a specific project path
 * Creates isolated storage at ~/.claude-code/memory/projects/{hash}/
 * Note: analyticsEnabled=false and sharedStore disabled to avoid DuckDB lock conflicts
 */
export function getMemoryServiceForProject(
  projectPath: string,
  sharedStoreConfig?: SharedStoreConfig
): MemoryService {
  const hash = hashProjectPath(projectPath);

  if (!serviceCache.has(hash)) {
    const storagePath = getProjectStoragePath(projectPath);
    serviceCache.set(hash, new MemoryService({
      storagePath,
      projectHash: hash,
      projectPath,
      // Override shared store config - hooks don't need DuckDB
      sharedStoreConfig: sharedStoreConfig ?? { enabled: false },
      analyticsEnabled: false  // Hooks don't need DuckDB
    }));
  }

  return serviceCache.get(hash)!;
}

/**
 * Get memory service for a session by looking up its project
 * Falls back to global storage if session not found in registry
 */
export function getMemoryServiceForSession(sessionId: string): MemoryService {
  const projectInfo = getSessionProject(sessionId);

  if (projectInfo) {
    return getMemoryServiceForProject(projectInfo.projectPath);
  }

  // Fallback to global storage for unknown sessions (backward compat)
  return getDefaultMemoryService();
}

/**
 * Get a lightweight memory service for hooks
 * Only initializes SQLite - no embedder, no vector store, no workers
 * This is FAST (<100ms) compared to full initialization (3-5s)
 */
export function getLightweightMemoryService(sessionId: string): MemoryService {
  const projectInfo = getSessionProject(sessionId);
  const key = projectInfo ? `lightweight_${projectInfo.projectHash}` : 'lightweight_global';

  if (!serviceCache.has(key)) {
    const storagePath = projectInfo
      ? getProjectStoragePath(projectInfo.projectPath)
      : path.join(os.homedir(), '.claude-code', 'memory');

    serviceCache.set(key, new MemoryService({
      storagePath,
      projectHash: projectInfo?.projectHash,
      projectPath: projectInfo?.projectPath,
      lightweightMode: true,  // Skip embedder/vector/workers
      analyticsEnabled: false,
      sharedStoreConfig: { enabled: false }
    }));
  }

  return serviceCache.get(key)!;
}

export function createMemoryService(config: MemoryServiceConfig): MemoryService {
  return new MemoryService(config);
}
