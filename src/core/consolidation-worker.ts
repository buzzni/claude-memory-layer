/**
 * Consolidation Worker
 * Periodically consolidates working set into long-term memory
 * Biomimetic: Simulates memory consolidation during sleep/idle periods
 */

import type {
  EndlessModeConfig,
  MemoryEvent,
  EventGroup,
  WorkingSet
} from './types.js';
import { WorkingSetStore } from './working-set-store.js';
import { ConsolidatedStore } from './consolidated-store.js';

export class ConsolidationWorker {
  private running = false;
  private timeout: NodeJS.Timeout | null = null;
  private lastActivity: Date = new Date();

  constructor(
    private workingSetStore: WorkingSetStore,
    private consolidatedStore: ConsolidatedStore,
    private config: EndlessModeConfig
  ) {}

  /**
   * Start the consolidation worker
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  /**
   * Stop the consolidation worker
   */
  stop(): void {
    this.running = false;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  /**
   * Record activity (resets idle timer)
   */
  recordActivity(): void {
    this.lastActivity = new Date();
  }

  /**
   * Check if currently running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Force a consolidation run (manual trigger)
   */
  async forceRun(): Promise<number> {
    return await this.consolidate();
  }

  /**
   * Schedule the next consolidation check
   */
  private scheduleNext(): void {
    if (!this.running) return;

    this.timeout = setTimeout(
      () => this.run(),
      this.config.consolidation.triggerIntervalMs
    );
  }

  /**
   * Run consolidation check
   */
  private async run(): Promise<void> {
    if (!this.running) return;

    try {
      await this.checkAndConsolidate();
    } catch (error) {
      console.error('Consolidation error:', error);
    }

    this.scheduleNext();
  }

  /**
   * Check conditions and consolidate if needed
   */
  private async checkAndConsolidate(): Promise<void> {
    const workingSet = await this.workingSetStore.get();

    if (!this.shouldConsolidate(workingSet)) {
      return;
    }

    await this.consolidate();
  }

  /**
   * Perform consolidation
   */
  private async consolidate(): Promise<number> {
    const workingSet = await this.workingSetStore.get();

    if (workingSet.recentEvents.length < 3) {
      return 0; // Not enough events to consolidate
    }

    // Group events by topic
    const groups = this.groupByTopic(workingSet.recentEvents);
    let consolidatedCount = 0;

    for (const group of groups) {
      // Require minimum 3 events per group
      if (group.events.length < 3) continue;

      // Check if already consolidated
      const eventIds = group.events.map(e => e.id);
      const alreadyConsolidated = await this.consolidatedStore.isAlreadyConsolidated(eventIds);
      if (alreadyConsolidated) continue;

      // Generate summary
      const summary = await this.summarize(group);

      // Create consolidated memory
      await this.consolidatedStore.create({
        summary,
        topics: group.topics,
        sourceEvents: eventIds,
        confidence: this.calculateConfidence(group)
      });

      consolidatedCount++;
    }

    // Prune consolidated events from working set
    if (consolidatedCount > 0) {
      const consolidatedEventIds = groups
        .filter(g => g.events.length >= 3)
        .flatMap(g => g.events.map(e => e.id));

      // Only prune old events (keep recent for context)
      const oldEventIds = consolidatedEventIds.filter(id => {
        const event = workingSet.recentEvents.find(e => e.id === id);
        if (!event) return false;
        const ageHours = (Date.now() - event.timestamp.getTime()) / (1000 * 60 * 60);
        return ageHours > this.config.workingSet.timeWindowHours / 2;
      });

      if (oldEventIds.length > 0) {
        await this.workingSetStore.prune(oldEventIds);
      }
    }

    return consolidatedCount;
  }

  /**
   * Check if consolidation should run
   */
  private shouldConsolidate(workingSet: WorkingSet): boolean {
    // Check event count trigger
    if (workingSet.recentEvents.length >= this.config.consolidation.triggerEventCount) {
      return true;
    }

    // Check idle time trigger
    const idleTime = Date.now() - this.lastActivity.getTime();
    if (idleTime >= this.config.consolidation.triggerIdleMs) {
      return true;
    }

    return false;
  }

  /**
   * Group events by topic using simple keyword extraction
   */
  private groupByTopic(events: MemoryEvent[]): EventGroup[] {
    const groups = new Map<string, EventGroup>();

    for (const event of events) {
      const topics = this.extractTopics(event.content);

      for (const topic of topics) {
        if (!groups.has(topic)) {
          groups.set(topic, { topics: [topic], events: [] });
        }
        const group = groups.get(topic)!;
        if (!group.events.find(e => e.id === event.id)) {
          group.events.push(event);
        }
      }
    }

    // Merge groups with overlapping events
    const mergedGroups = this.mergeOverlappingGroups(Array.from(groups.values()));

    return mergedGroups;
  }

  /**
   * Extract topics from content using simple keyword extraction
   */
  private extractTopics(content: string): string[] {
    const topics: string[] = [];

    // Extract code-related keywords
    const codePatterns = [
      /\b(function|class|interface|type|const|let|var)\s+(\w+)/gi,
      /\b(import|export)\s+.*?from\s+['"]([^'"]+)['"]/gi,
      /\bfile[:\s]+([^\s,]+)/gi
    ];

    for (const pattern of codePatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const keyword = match[2] || match[1];
        if (keyword && keyword.length > 2) {
          topics.push(keyword.toLowerCase());
        }
      }
    }

    // Extract common programming terms
    const commonTerms = [
      'bug', 'fix', 'error', 'issue', 'feature',
      'test', 'refactor', 'implement', 'add', 'remove',
      'update', 'change', 'modify', 'create', 'delete'
    ];

    const contentLower = content.toLowerCase();
    for (const term of commonTerms) {
      if (contentLower.includes(term)) {
        topics.push(term);
      }
    }

    return [...new Set(topics)].slice(0, 5); // Limit to 5 topics
  }

  /**
   * Merge groups that have significant event overlap
   */
  private mergeOverlappingGroups(groups: EventGroup[]): EventGroup[] {
    const merged: EventGroup[] = [];

    for (const group of groups) {
      let foundMerge = false;

      for (const existing of merged) {
        const overlap = group.events.filter(e =>
          existing.events.some(ex => ex.id === e.id)
        );

        // If > 50% overlap, merge
        if (overlap.length > group.events.length / 2) {
          existing.topics = [...new Set([...existing.topics, ...group.topics])];
          for (const event of group.events) {
            if (!existing.events.find(e => e.id === event.id)) {
              existing.events.push(event);
            }
          }
          foundMerge = true;
          break;
        }
      }

      if (!foundMerge) {
        merged.push(group);
      }
    }

    return merged;
  }

  /**
   * Generate summary for a group of events
   * Rule-based extraction (no LLM by default)
   */
  private async summarize(group: EventGroup): Promise<string> {
    if (this.config.consolidation.useLLMSummarization) {
      // Future: LLM-based summarization
      return this.ruleBasedSummary(group);
    }

    return this.ruleBasedSummary(group);
  }

  /**
   * Rule-based summary generation
   */
  private ruleBasedSummary(group: EventGroup): string {
    const keyPoints: string[] = [];

    for (const event of group.events.slice(0, 10)) {
      const keyPoint = this.extractKeyPoint(event.content);
      if (keyPoint) {
        keyPoints.push(keyPoint);
      }
    }

    const topicsStr = group.topics.slice(0, 3).join(', ');
    const summary = [
      `Topics: ${topicsStr}`,
      '',
      'Key points:',
      ...keyPoints.map(kp => `- ${kp}`)
    ].join('\n');

    return summary;
  }

  /**
   * Extract key point from content
   */
  private extractKeyPoint(content: string): string | null {
    // Get first meaningful sentence
    const sentences = content.split(/[.!?\n]+/).filter(s => s.trim().length > 10);
    if (sentences.length === 0) return null;

    const firstSentence = sentences[0].trim();

    // Truncate if too long
    if (firstSentence.length > 100) {
      return firstSentence.slice(0, 100) + '...';
    }

    return firstSentence;
  }

  /**
   * Calculate confidence score for a group
   */
  private calculateConfidence(group: EventGroup): number {
    // Factor 1: Event count (more events = higher confidence)
    const eventScore = Math.min(group.events.length / 10, 1);

    // Factor 2: Time proximity (events closer together = higher confidence)
    const timeScore = this.calculateTimeProximity(group.events);

    // Factor 3: Topic consistency (fewer topics per event = higher confidence)
    const topicScore = Math.min(3 / group.topics.length, 1);

    return (eventScore * 0.4 + timeScore * 0.4 + topicScore * 0.2);
  }

  /**
   * Calculate time proximity score
   */
  private calculateTimeProximity(events: MemoryEvent[]): number {
    if (events.length < 2) return 1;

    const timestamps = events.map(e => e.timestamp.getTime()).sort((a, b) => a - b);
    const timeSpan = timestamps[timestamps.length - 1] - timestamps[0];

    // Score based on average time between events
    const avgGap = timeSpan / (events.length - 1);
    const hourInMs = 60 * 60 * 1000;

    // Within 1 hour average = score 1, 24 hours = score 0.5, etc.
    return Math.max(0, 1 - (avgGap / (24 * hourInMs)));
  }
}

/**
 * Create a Consolidation Worker instance
 */
export function createConsolidationWorker(
  workingSetStore: WorkingSetStore,
  consolidatedStore: ConsolidatedStore,
  config: EndlessModeConfig
): ConsolidationWorker {
  return new ConsolidationWorker(workingSetStore, consolidatedStore, config);
}
