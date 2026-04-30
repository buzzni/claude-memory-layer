import type { MemoryEvent } from '../types.js';

export interface SessionSummaryDerivation {
  text: string;
  metadata: {
    generated: 'rule-based';
    eventCount: number;
  };
}

const MAX_FIRST_PROMPT_LENGTH = 120;
const MAX_TOOL_NAMES = 6;

export class SummaryDeriver {
  /**
   * Derive the current lightweight rule-based session summary from raw events.
   *
   * The deriver is intentionally pure: callers own persistence and lifecycle
   * orchestration, while this class owns summary text and metadata decisions.
   */
  deriveSessionSummary(events: MemoryEvent[]): SessionSummaryDerivation | null {
    if (events.length < 3) return null;
    if (events.some((event) => event.eventType === 'session_summary')) return null;

    const prompts = events.filter((event) => event.eventType === 'user_prompt');
    const toolObservations = events.filter((event) => event.eventType === 'tool_observation');
    const toolNames = Array.from(new Set(
      toolObservations
        .map((event) => this.asRecord(event.metadata).toolName)
        .filter((toolName): toolName is string => typeof toolName === 'string' && toolName.length > 0)
    ));
    const errorObservations = toolObservations.filter((event) => this.isErrorObservation(event));

    const datePart = events[0].timestamp.toISOString().split('T')[0];
    const parts: string[] = [`[${datePart}] ${prompts.length}턴 세션`];

    if (prompts.length > 0) {
      parts.push(`주요 작업: ${this.firstPromptPreview(prompts[0].content)}`);
    }
    if (toolNames.length > 0) {
      parts.push(`사용 툴: ${toolNames.slice(0, MAX_TOOL_NAMES).join(', ')}`);
    }
    if (errorObservations.length > 0) {
      parts.push(`오류 ${errorObservations.length}건 발생`);
    }

    return {
      text: parts.join('. '),
      metadata: { generated: 'rule-based', eventCount: events.length }
    };
  }

  private firstPromptPreview(content: string): string {
    return content.slice(0, MAX_FIRST_PROMPT_LENGTH).replace(/\r?\n/g, ' ');
  }

  private isErrorObservation(event: MemoryEvent): boolean {
    const metadata = this.asRecord(event.metadata);

    if (metadata.exitCode !== undefined) {
      return metadata.exitCode !== 0;
    }

    return metadata.success === false;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }
}

export function createSummaryDeriver(): SummaryDeriver {
  return new SummaryDeriver();
}
