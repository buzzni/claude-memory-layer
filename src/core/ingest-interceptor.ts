import type { MemoryEventInput } from './types.js';

export type IngestStage = 'before' | 'after' | 'error';

export interface IngestContext {
  stage: IngestStage;
  operation: 'user_prompt' | 'agent_response' | 'session_summary' | 'tool_observation';
  sessionId: string;
  event: MemoryEventInput;
  error?: Error;
}

export type IngestInterceptor = (context: IngestContext) => Promise<void> | void;

export class IngestInterceptorRegistry {
  private before: IngestInterceptor[] = [];
  private after: IngestInterceptor[] = [];
  private onError: IngestInterceptor[] = [];

  registerBefore(interceptor: IngestInterceptor): () => void {
    this.before.push(interceptor);
    return () => {
      this.before = this.before.filter((i) => i !== interceptor);
    };
  }

  registerAfter(interceptor: IngestInterceptor): () => void {
    this.after.push(interceptor);
    return () => {
      this.after = this.after.filter((i) => i !== interceptor);
    };
  }

  registerOnError(interceptor: IngestInterceptor): () => void {
    this.onError.push(interceptor);
    return () => {
      this.onError = this.onError.filter((i) => i !== interceptor);
    };
  }

  async run(stage: IngestStage, context: Omit<IngestContext, 'stage'>): Promise<void> {
    const interceptors = stage === 'before'
      ? this.before
      : stage === 'after'
      ? this.after
      : this.onError;

    for (const interceptor of interceptors) {
      await interceptor({ ...context, stage });
    }
  }
}

export function mergeHierarchicalMetadata(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!base && !patch) return undefined;
  if (!base) return patch;
  if (!patch) return base;

  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    if (
      typeof current === 'object' && current !== null && !Array.isArray(current) &&
      typeof value === 'object' && value !== null && !Array.isArray(value)
    ) {
      result[key] = mergeHierarchicalMetadata(
        current as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}
