import type {
  MemoryUsefulnessObservationV2,
  RetrievalPresentationMode,
  RetrievalTriggerType,
  UsefulnessAdoption,
  UsefulnessReaskOutcome,
  UsefulnessTaskOutcome
} from './retrieval-telemetry.js';

export type ParsedToolOutcome = 'success' | 'failure' | 'unknown';

/** Outcome signals are attributable only to the bounded task phase after delivery. */
export const USEFULNESS_V2_EVALUATION_WINDOW_MS = 30 * 60 * 1000;

export function parseToolOutcome(value: unknown): ParsedToolOutcome {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return 'unknown';
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown';
  const record = parsed as Record<string, unknown>;
  if (typeof record.success === 'boolean') return record.success ? 'success' : 'failure';
  if (typeof record.ok === 'boolean') return record.ok ? 'success' : 'failure';
  if (typeof record.isError === 'boolean') return record.isError ? 'failure' : 'success';
  if (typeof record.status === 'string') {
    const status = record.status.trim().toLowerCase();
    if (['ok', 'success', 'succeeded', 'complete', 'completed'].includes(status)) return 'success';
    if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(status)) return 'failure';
  }
  return 'unknown';
}

export function deriveTaskOutcome(
  adoption: UsefulnessAdoption,
  toolOutcomes: ParsedToolOutcome[]
): UsefulnessTaskOutcome {
  if (adoption !== 'grounded' && adoption !== 'navigated') return 'unknown';
  const measured = toolOutcomes.filter((outcome) => outcome !== 'unknown');
  if (measured.length === 0) return 'unknown';
  const successes = measured.filter((outcome) => outcome === 'success').length;
  const failures = measured.length - successes;
  if (successes > 0 && failures > 0) return 'mixed';
  return successes > 0 ? 'success' : 'failure';
}

export function classifyReaskOutcome(
  originalQuery: unknown,
  promptsAfter: unknown[]
): UsefulnessReaskOutcome {
  if (!Array.isArray(promptsAfter)) return 'unknown';
  if (promptsAfter.length === 0) return 'none';
  const query = typeof originalQuery === 'string' ? originalQuery.trim() : '';
  const prompts = promptsAfter.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (prompts.length === 0) return 'unknown';
  const combined = prompts.join(' ').toLowerCase();
  if (/(clarify|what do you mean|more specific|explain more|무슨 뜻|좀 더 설명|구체적으로|명확히)/i.test(combined)) {
    return 'clarification';
  }
  if (/(still|again|same error|doesn.t work|did not work|failed again|여전히|또 실패|같은 오류|안[돼되]|작동하지 않)/i.test(combined)) {
    return 'repeat_failure';
  }
  if (!query) return 'unknown';
  const queryTokens = tokens(query);
  if (queryTokens.size === 0) return 'unknown';
  for (const prompt of prompts) {
    const promptTokens = tokens(prompt);
    const overlap = [...queryTokens].filter((token) => promptTokens.has(token)).length / queryTokens.size;
    if (overlap >= 0.35) return 'topic_continuation';
  }
  return 'none';
}

export function buildUsefulnessObservationV2(input: {
  traceId: string;
  eventId: string;
  presentationMode: RetrievalPresentationMode;
  triggerType: RetrievalTriggerType;
  delivered: boolean | null;
  adoption: UsefulnessAdoption;
  contentOverlapScore: number | null;
  toolOutcomes: ParsedToolOutcome[];
  reaskOutcome: UsefulnessReaskOutcome;
  evaluatedAt: string | null;
  evaluatorVersion?: string;
}): MemoryUsefulnessObservationV2 {
  return {
    traceId: input.traceId,
    eventId: input.eventId,
    observationKind: 'outcome',
    presentationMode: input.presentationMode,
    triggerType: input.triggerType,
    selected: true,
    delivered: input.delivered,
    adoption: input.adoption,
    contentOverlapScore: input.contentOverlapScore,
    taskOutcome: deriveTaskOutcome(input.adoption, input.toolOutcomes),
    reaskOutcome: input.reaskOutcome,
    explicitFeedback: null,
    confidence: confidenceFor(input.presentationMode, input.adoption),
    evaluatedAt: input.evaluatedAt,
    evaluatorVersion: input.evaluatorVersion ?? 'v2'
  };
}

function confidenceFor(presentationMode: RetrievalPresentationMode, adoption: UsefulnessAdoption): number {
  if (presentationMode === 'reference') return adoption === 'navigated' ? 0.95 : 0.7;
  if (presentationMode === 'evidence') return adoption === 'grounded' ? 0.85 : 0.6;
  if (presentationMode === 'core') return 0.4;
  return 0.3;
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9_/-]{3,}|[가-힣]{2,}/g) ?? []);
}
