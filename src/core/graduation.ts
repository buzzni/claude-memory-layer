/**
 * Memory Graduation Pipeline - AXIOMMIND L0→L1→L2→L3→L4
 *
 * L0: EventStore (raw events, append-only)
 * L1: Structured JSON (session summaries, patterns)
 * L2: Type Candidates (Idris2-inspired, validated schemas)
 * L3: Verified Knowledge (cross-session validated)
 * L4: Active/Searchable (indexed, readily available)
 */

import { EventStore } from './event-store.js';
import type {
  MemoryEvent,
  MemoryLevel,
  GraduationResult,
  Insight,
  InsightType
} from './types.js';

export interface GraduationCriteria {
  minAccessCount: number;
  minConfidence: number;
  minCrossSessionRefs: number;
  maxAgeDays: number;
}

export interface LevelCriteria {
  L0toL1: GraduationCriteria;
  L1toL2: GraduationCriteria;
  L2toL3: GraduationCriteria;
  L3toL4: GraduationCriteria;
}

const DEFAULT_CRITERIA: LevelCriteria = {
  L0toL1: {
    minAccessCount: 1,
    minConfidence: 0.5,
    minCrossSessionRefs: 0,
    maxAgeDays: 30
  },
  L1toL2: {
    minAccessCount: 3,
    minConfidence: 0.7,
    minCrossSessionRefs: 1,
    maxAgeDays: 60
  },
  L2toL3: {
    minAccessCount: 5,
    minConfidence: 0.85,
    minCrossSessionRefs: 2,
    maxAgeDays: 90
  },
  L3toL4: {
    minAccessCount: 10,
    minConfidence: 0.92,
    minCrossSessionRefs: 3,
    maxAgeDays: 180
  }
};

export interface EventMetrics {
  eventId: string;
  accessCount: number;
  lastAccessed: Date;
  crossSessionRefs: number;
  confidence: number;
}

export class GraduationPipeline {
  private readonly eventStore: EventStore;
  private readonly criteria: LevelCriteria;
  private readonly metrics: Map<string, EventMetrics> = new Map();

  constructor(
    eventStore: EventStore,
    criteria: Partial<LevelCriteria> = {}
  ) {
    this.eventStore = eventStore;
    this.criteria = {
      L0toL1: { ...DEFAULT_CRITERIA.L0toL1, ...criteria.L0toL1 },
      L1toL2: { ...DEFAULT_CRITERIA.L1toL2, ...criteria.L1toL2 },
      L2toL3: { ...DEFAULT_CRITERIA.L2toL3, ...criteria.L2toL3 },
      L3toL4: { ...DEFAULT_CRITERIA.L3toL4, ...criteria.L3toL4 }
    };
  }

  /**
   * Record an access to an event (used for graduation scoring)
   */
  recordAccess(eventId: string, fromSessionId: string, confidence: number = 1.0): void {
    const existing = this.metrics.get(eventId);

    if (existing) {
      existing.accessCount++;
      existing.lastAccessed = new Date();
      existing.confidence = Math.max(existing.confidence, confidence);
      // Track cross-session references
      // This would need more sophisticated tracking in production
    } else {
      this.metrics.set(eventId, {
        eventId,
        accessCount: 1,
        lastAccessed: new Date(),
        crossSessionRefs: 0,
        confidence
      });
    }
  }

  /**
   * Evaluate if an event should graduate to the next level
   */
  async evaluateGraduation(eventId: string, currentLevel: MemoryLevel): Promise<GraduationResult> {
    const metrics = this.metrics.get(eventId);

    if (!metrics) {
      return {
        eventId,
        fromLevel: currentLevel,
        toLevel: currentLevel,
        success: false,
        reason: 'No metrics available for event'
      };
    }

    const nextLevel = this.getNextLevel(currentLevel);
    if (!nextLevel) {
      return {
        eventId,
        fromLevel: currentLevel,
        toLevel: currentLevel,
        success: false,
        reason: 'Already at maximum level'
      };
    }

    const criteria = this.getCriteria(currentLevel, nextLevel);
    const evaluation = this.checkCriteria(metrics, criteria);

    if (evaluation.passed) {
      // Update level in event store
      await this.eventStore.updateMemoryLevel(eventId, nextLevel);

      return {
        eventId,
        fromLevel: currentLevel,
        toLevel: nextLevel,
        success: true
      };
    }

    return {
      eventId,
      fromLevel: currentLevel,
      toLevel: currentLevel,
      success: false,
      reason: evaluation.reason
    };
  }

  /**
   * Run graduation evaluation for all events at a given level
   */
  async graduateBatch(level: MemoryLevel): Promise<GraduationResult[]> {
    const results: GraduationResult[] = [];

    for (const [eventId, metrics] of this.metrics) {
      const result = await this.evaluateGraduation(eventId, level);
      results.push(result);
    }

    return results;
  }

  /**
   * Extract insights from graduated events (L1+)
   */
  extractInsights(events: MemoryEvent[]): Insight[] {
    const insights: Insight[] = [];

    // Pattern detection: Look for repeated themes
    const patterns = this.detectPatterns(events);
    for (const pattern of patterns) {
      insights.push({
        id: crypto.randomUUID(),
        insightType: 'pattern',
        content: pattern.description,
        canonicalKey: pattern.key,
        confidence: pattern.confidence,
        sourceEvents: pattern.eventIds,
        createdAt: new Date(),
        lastUpdated: new Date()
      });
    }

    // Preference detection: Look for user preferences
    const preferences = this.detectPreferences(events);
    for (const pref of preferences) {
      insights.push({
        id: crypto.randomUUID(),
        insightType: 'preference',
        content: pref.description,
        canonicalKey: pref.key,
        confidence: pref.confidence,
        sourceEvents: pref.eventIds,
        createdAt: new Date(),
        lastUpdated: new Date()
      });
    }

    return insights;
  }

  /**
   * Get the next level in the graduation pipeline
   */
  private getNextLevel(current: MemoryLevel): MemoryLevel | null {
    const levels: MemoryLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4'];
    const currentIndex = levels.indexOf(current);

    if (currentIndex === -1 || currentIndex >= levels.length - 1) {
      return null;
    }

    return levels[currentIndex + 1];
  }

  /**
   * Get criteria for level transition
   */
  private getCriteria(from: MemoryLevel, to: MemoryLevel): GraduationCriteria {
    const key = `${from}to${to}` as keyof LevelCriteria;
    return this.criteria[key] || DEFAULT_CRITERIA.L0toL1;
  }

  /**
   * Check if metrics meet criteria
   */
  private checkCriteria(
    metrics: EventMetrics,
    criteria: GraduationCriteria
  ): { passed: boolean; reason?: string } {
    if (metrics.accessCount < criteria.minAccessCount) {
      return {
        passed: false,
        reason: `Access count ${metrics.accessCount} < ${criteria.minAccessCount}`
      };
    }

    if (metrics.confidence < criteria.minConfidence) {
      return {
        passed: false,
        reason: `Confidence ${metrics.confidence} < ${criteria.minConfidence}`
      };
    }

    if (metrics.crossSessionRefs < criteria.minCrossSessionRefs) {
      return {
        passed: false,
        reason: `Cross-session refs ${metrics.crossSessionRefs} < ${criteria.minCrossSessionRefs}`
      };
    }

    const ageDays = (Date.now() - metrics.lastAccessed.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > criteria.maxAgeDays) {
      return {
        passed: false,
        reason: `Event too old: ${ageDays.toFixed(1)} days > ${criteria.maxAgeDays}`
      };
    }

    return { passed: true };
  }

  /**
   * Detect patterns in events
   */
  private detectPatterns(events: MemoryEvent[]): Array<{
    key: string;
    description: string;
    confidence: number;
    eventIds: string[];
  }> {
    // Simple pattern detection: group by canonical key and look for repeats
    const keyGroups = new Map<string, MemoryEvent[]>();

    for (const event of events) {
      const existing = keyGroups.get(event.canonicalKey) || [];
      existing.push(event);
      keyGroups.set(event.canonicalKey, existing);
    }

    const patterns: Array<{
      key: string;
      description: string;
      confidence: number;
      eventIds: string[];
    }> = [];

    for (const [key, groupEvents] of keyGroups) {
      if (groupEvents.length >= 2) {
        patterns.push({
          key,
          description: `Repeated topic: ${key.slice(0, 50)}`,
          confidence: Math.min(1.0, groupEvents.length / 5),
          eventIds: groupEvents.map(e => e.id)
        });
      }
    }

    return patterns;
  }

  /**
   * Detect user preferences from events
   */
  private detectPreferences(events: MemoryEvent[]): Array<{
    key: string;
    description: string;
    confidence: number;
    eventIds: string[];
  }> {
    // Simple preference detection: look for keywords
    const preferenceKeywords = ['prefer', 'like', 'want', 'always', 'never', 'favorite'];
    const preferences: Array<{
      key: string;
      description: string;
      confidence: number;
      eventIds: string[];
    }> = [];

    for (const event of events) {
      if (event.eventType !== 'user_prompt') continue;

      const lowerContent = event.content.toLowerCase();
      for (const keyword of preferenceKeywords) {
        if (lowerContent.includes(keyword)) {
          preferences.push({
            key: `preference_${keyword}_${event.id.slice(0, 8)}`,
            description: `User preference: ${event.content.slice(0, 100)}`,
            confidence: 0.7,
            eventIds: [event.id]
          });
          break;
        }
      }
    }

    return preferences;
  }

  /**
   * Get graduation statistics
   */
  async getStats(): Promise<{ level: string; count: number }[]> {
    return this.eventStore.getLevelStats();
  }
}

/**
 * Create graduation pipeline with default settings
 */
export function createGraduationPipeline(eventStore: EventStore): GraduationPipeline {
  return new GraduationPipeline(eventStore);
}
