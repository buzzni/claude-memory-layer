/**
 * Graduation Worker
 * Periodically evaluates memory events for promotion to higher levels
 * L0 → L1 → L2 → L3 → L4 based on access patterns and confidence
 */

import type { MemoryLevel } from './types.js';
import { EventStore } from './event-store.js';
import { GraduationPipeline, type EventMetrics } from './graduation.js';

export interface GraduationWorkerConfig {
  /** How often to run graduation evaluation (ms) */
  evaluationIntervalMs: number;
  /** Batch size for graduation evaluation */
  batchSize: number;
  /** Minimum time between evaluations of the same event (ms) */
  cooldownMs: number;
}

export type GraduationRunStatus = 'success' | 'not_eligible' | 'failed';

export interface GraduationRunTelemetryInput {
  startedAt: Date;
  finishedAt: Date;
  status: GraduationRunStatus;
  evaluated: number;
  graduated: number;
}

/**
 * SQLite stores can persist aggregate liveness data.  Keep this optional so
 * the worker remains compatible with the legacy EventStore and test doubles.
 */
export interface GraduationRunTelemetryStore {
  recordGraduationRun(input: GraduationRunTelemetryInput): Promise<void>;
}

export interface GraduationMetricsStore {
  getGraduationMetrics(eventIds: string[]): Promise<EventMetrics[]>;
}

export interface GraduationCandidateStore {
  getGraduationCandidates(level: MemoryLevel, options: { limit: number }): Promise<Awaited<ReturnType<EventStore['getEventsByLevel']>>>;
}

function hasGraduationRunTelemetry(store: EventStore): store is EventStore & GraduationRunTelemetryStore {
  return typeof (store as Partial<GraduationRunTelemetryStore>).recordGraduationRun === 'function';
}

function hasGraduationMetrics(store: EventStore): store is EventStore & GraduationMetricsStore {
  return typeof (store as Partial<GraduationMetricsStore>).getGraduationMetrics === 'function';
}

function hasGraduationCandidates(store: EventStore): store is EventStore & GraduationCandidateStore {
  return typeof (store as Partial<GraduationCandidateStore>).getGraduationCandidates === 'function';
}

const DEFAULT_CONFIG: GraduationWorkerConfig = {
  evaluationIntervalMs: 300000, // 5 minutes
  batchSize: 50,
  cooldownMs: 3600000 // 1 hour cooldown between evaluations
};

export class GraduationWorker {
  private running = false;
  private timeout: NodeJS.Timeout | null = null;
  private lastEvaluated: Map<string, number> = new Map();

  constructor(
    private eventStore: EventStore,
    private graduation: GraduationPipeline,
    private config: GraduationWorkerConfig = DEFAULT_CONFIG
  ) {}

  /**
   * Start the graduation worker
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  /**
   * Stop the graduation worker
   */
  stop(): void {
    this.running = false;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  /**
   * Check if currently running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Force a graduation evaluation run
   */
  async forceRun(): Promise<GraduationRunResult> {
    return await this.runGraduationWithTelemetry();
  }

  /**
   * Schedule the next graduation check
   */
  private scheduleNext(): void {
    if (!this.running) return;

    this.timeout = setTimeout(
      () => this.run(),
      this.config.evaluationIntervalMs
    );
  }

  /**
   * Run graduation evaluation
   */
  private async run(): Promise<void> {
    if (!this.running) return;

    try {
      await this.runGraduationWithTelemetry();
    } catch (error) {
      console.error('Graduation error:', error);
    }

    this.scheduleNext();
  }

  /**
   * Perform graduation evaluation across all levels
   */
  private async runGraduation(): Promise<GraduationRunResult> {
    const result: GraduationRunResult = {
      evaluated: 0,
      graduated: 0,
      byLevel: {}
    };

    const levels: MemoryLevel[] = ['L0', 'L1', 'L2', 'L3'];
    const now = Date.now();

    for (const level of levels) {
      const events = hasGraduationCandidates(this.eventStore)
        ? await this.eventStore.getGraduationCandidates(level, { limit: this.config.batchSize })
        : await this.eventStore.getEventsByLevel(level, { limit: this.config.batchSize });

      if (hasGraduationMetrics(this.eventStore) && events.length > 0) {
        this.graduation.hydrateMetrics(await this.eventStore.getGraduationMetrics(events.map((event) => event.id)));
      }

      let levelGraduated = 0;

      for (const event of events) {
        // Check cooldown
        const lastEval = this.lastEvaluated.get(event.id);
        if (lastEval && (now - lastEval) < this.config.cooldownMs) {
          continue;
        }

        result.evaluated++;
        this.lastEvaluated.set(event.id, now);

        const gradResult = await this.graduation.evaluateGraduation(event.id, level);

        if (gradResult.success) {
          result.graduated++;
          levelGraduated++;
        }
      }

      if (levelGraduated > 0) {
        result.byLevel[level] = levelGraduated;
      }
    }

    // Clean up old cooldown entries (keep last 1000)
    if (this.lastEvaluated.size > 1000) {
      const entries = Array.from(this.lastEvaluated.entries());
      entries.sort((a, b) => b[1] - a[1]);
      this.lastEvaluated = new Map(entries.slice(0, 1000));
    }

    return result;
  }

  private async runGraduationWithTelemetry(): Promise<GraduationRunResult> {
    const startedAt = new Date();
    try {
      const result = await this.runGraduation();
      await this.recordTelemetry({
        startedAt,
        finishedAt: new Date(),
        status: result.graduated === 0 ? 'not_eligible' : 'success',
        evaluated: result.evaluated,
        graduated: result.graduated
      });
      return result;
    } catch (error) {
      await this.recordTelemetry({
        startedAt,
        finishedAt: new Date(),
        status: 'failed',
        evaluated: 0,
        graduated: 0
      });
      throw error;
    }
  }

  private async recordTelemetry(input: GraduationRunTelemetryInput): Promise<void> {
    if (!hasGraduationRunTelemetry(this.eventStore)) return;

    // Telemetry must not make a successful derivation fail.  Errors are kept
    // out of public output and the next run will attempt to record again.
    try {
      await this.eventStore.recordGraduationRun(input);
    } catch {
      // best-effort liveness telemetry
    }
  }
}

export interface GraduationRunResult {
  evaluated: number;
  graduated: number;
  byLevel: Record<string, number>;
}

/**
 * Create a Graduation Worker instance
 */
export function createGraduationWorker(
  eventStore: EventStore,
  graduation: GraduationPipeline,
  config?: Partial<GraduationWorkerConfig>
): GraduationWorker {
  return new GraduationWorker(
    eventStore,
    graduation,
    { ...DEFAULT_CONFIG, ...config }
  );
}
