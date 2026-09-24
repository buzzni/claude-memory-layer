import { createHash } from 'crypto';

import type { MemoryEvent } from '../types.js';
import type { MemoryFact, MemoryFactType } from '../model/memory-fact.js';

export interface FactDerivationOptions {
  /** Fallback project hash when the source event metadata does not carry scope.project.hash. */
  projectHash?: string;
  /** Optional current time hook for deterministic tests. */
  now?: Date;
}

const DEFAULT_PROJECT_HASH = 'default';
const MAX_FACT_TEXT_LENGTH = 600;

/**
 * Create a stable, rebuild-safe fact id for an event-derived fact.
 *
 * Format intentionally avoids UUID randomness so derived fact stores can be
 * dropped and rebuilt without producing duplicate logical facts.
 */
export function makeEventDerivedFactId(
  eventId: string,
  factType: MemoryFactType,
  ordinal = 0
): string {
  const digest = createHash('sha1')
    .update(`${eventId}:${factType}:${ordinal}`)
    .digest('hex')
    .slice(0, 16);

  return `fact:event:${eventId}:${factType}:${ordinal}:${digest}`;
}

export class FactDeriver {
  deriveFromEvent(event: MemoryEvent, options: FactDerivationOptions = {}): MemoryFact[] {
    const text = this.toFactText(event);
    if (!text) return [];

    const factType = this.inferFactType(event);
    const now = (options.now ?? new Date()).toISOString();
    const metadata = this.asRecord(event.metadata);
    const projectHash = this.getProjectHash(metadata) ?? options.projectHash ?? DEFAULT_PROJECT_HASH;
    const tags = this.getTags(metadata);

    return [{
      factId: makeEventDerivedFactId(event.id, factType),
      projectHash,
      factType,
      text,
      derivedFromEventIds: [event.id],
      sourceKind: this.getSourceKind(event),
      confidence: this.getConfidence(event),
      importance: this.getImportance(event),
      tags,
      ...(this.getFileRefs(metadata).length > 0 ? { fileRefs: this.getFileRefs(metadata) } : {}),
      createdAt: now,
      updatedAt: now
    }];
  }

  private toFactText(event: MemoryEvent): string | null {
    const content = event.content.trim().replace(/\s+/g, ' ');
    if (!content) return null;

    const clipped = content.length > MAX_FACT_TEXT_LENGTH
      ? `${content.slice(0, MAX_FACT_TEXT_LENGTH - 1)}…`
      : content;

    switch (event.eventType) {
      case 'user_prompt':
        return `User asked: ${clipped}`;
      case 'agent_response':
        return `Assistant responded: ${clipped}`;
      case 'session_summary':
        return `Session summary: ${clipped}`;
      case 'tool_observation': {
        const metadata = this.asRecord(event.metadata);
        const toolName = typeof metadata.toolName === 'string' ? metadata.toolName : 'unknown_tool';
        const success = typeof metadata.success === 'boolean'
          ? metadata.success
          : undefined;
        const status = success === undefined ? '' : success ? ' succeeded' : ' failed';
        return `Tool ${toolName}${status}: ${clipped}`;
      }
    }
  }

  private inferFactType(event: MemoryEvent): MemoryFactType {
    if (event.eventType === 'tool_observation') return 'tool_observation';
    if (event.eventType === 'session_summary') return 'summary_fact';

    const content = event.content.toLowerCase();
    if (/\b(decided|decision|선택|결정)\b/.test(content)) return 'decision';
    if (/\b(must|should not|constraint|requirement|제약|필수|금지)\b/.test(content)) return 'constraint';
    if (/\b(todo|task|next|pending|해야|작업|진행)\b/.test(content)) return 'task_state';
    if (/\b(prefer|preference|선호)\b/.test(content)) return 'preference';
    if (/\b(src\/|tests\/|\.ts|\.tsx|\.js|\.py|function|class)\b/.test(content)) return 'code_context';

    return 'task_state';
  }

  private getSourceKind(event: MemoryEvent): MemoryFact['sourceKind'] {
    switch (event.eventType) {
      case 'user_prompt':
        return 'prompt';
      case 'agent_response':
      case 'session_summary':
        return 'assistant';
      case 'tool_observation':
        return 'tool';
    }
  }

  private getConfidence(event: MemoryEvent): number {
    switch (event.eventType) {
      case 'session_summary':
        return 0.8;
      case 'tool_observation':
        return 0.75;
      case 'agent_response':
        return 0.7;
      case 'user_prompt':
        return 0.65;
    }
  }

  private getImportance(event: MemoryEvent): number {
    const metadata = this.asRecord(event.metadata);
    const importance = metadata.importance;
    if (typeof importance === 'number' && Number.isFinite(importance)) {
      return Math.max(0, Math.min(1, importance));
    }

    if (event.eventType === 'session_summary') return 0.8;
    if (event.eventType === 'tool_observation') return 0.6;
    return 0.5;
  }

  private getProjectHash(metadata: Record<string, unknown>): string | undefined {
    const scope = this.asRecord(metadata.scope);
    const project = this.asRecord(scope.project);
    return typeof project.hash === 'string' && project.hash.length > 0
      ? project.hash
      : undefined;
  }

  private getTags(metadata: Record<string, unknown>): string[] {
    return Array.isArray(metadata.tags)
      ? metadata.tags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
      : [];
  }

  private getFileRefs(metadata: Record<string, unknown>): string[] {
    const refs = metadata.fileRefs ?? metadata.files;
    return Array.isArray(refs)
      ? refs.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
      : [];
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }
}

export function createFactDeriver(): FactDeriver {
  return new FactDeriver();
}
