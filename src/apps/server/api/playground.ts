/**
 * Playground API
 * Dry-run/replay endpoints for retrieval UX experiments.
 */

import { Hono } from 'hono';
import { sanitizeGovernanceAuditValue } from '../../../core/operations/governance-audit.js';
import { getLightweightServiceFromQuery, getServiceFromQuery } from './utils.js';

export const playgroundRouter = new Hono();

interface PlaygroundDryRunRequest {
  query: string;
  options?: {
    topK?: number;
    minScore?: number;
    sessionId?: string;
    includeShared?: boolean;
    adaptiveRerank?: boolean;
    intentRewrite?: boolean;
    projectScopeMode?: 'strict' | 'prefer' | 'global';
    allowedProjectHashes?: string[];
    strategy?: 'auto' | 'fast' | 'deep';
    windowSize?: number;
    selectedResultId?: string;
  };
}

function normalizeWindowSize(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(1, Math.min(10, Math.trunc(parsed)));
}

function disclosureOptions(options: PlaygroundDryRunRequest['options'] = {}) {
  const {
    windowSize: _windowSize,
    selectedResultId: _selectedResultId,
    ...rest
  } = options;
  return rest;
}

const SOURCE_EVENT_PREVIEW_CHARS = 500;
const SOURCE_EVENT_LIMIT = 3;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function safeSourcePreview(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  const sanitized = String(sanitizeGovernanceAuditValue(raw));
  return sanitized.length > SOURCE_EVENT_PREVIEW_CHARS
    ? `${sanitized.slice(0, SOURCE_EVENT_PREVIEW_CHARS)}...`
    : sanitized;
}

function sanitizeSourceEvent(event: unknown): Record<string, unknown> {
  const record = asRecord(event);
  if (!record) {
    return { preview: safeSourcePreview(event) };
  }

  const safe: Record<string, unknown> = {};
  if (record.id !== undefined) safe.id = sanitizeGovernanceAuditValue(record.id, 'id');
  if (record.eventId !== undefined) safe.eventId = sanitizeGovernanceAuditValue(record.eventId, 'eventId');
  if (record.sessionId !== undefined) safe.sessionId = sanitizeGovernanceAuditValue(record.sessionId, 'sessionId');
  if (record.eventType !== undefined) safe.eventType = sanitizeGovernanceAuditValue(record.eventType, 'eventType');
  if (record.timestamp !== undefined) safe.timestamp = sanitizeGovernanceAuditValue(record.timestamp, 'timestamp');

  const previewSource = record.content ?? record.preview ?? '';
  safe.preview = safeSourcePreview(previewSource);
  if (typeof record.content === 'string') {
    safe.contentLength = record.content.length;
  }
  return safe;
}

function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => safeSourcePreview(item).slice(0, 160))
    .filter((item) => item.length > 0);
}

function sanitizePlaygroundSource(source: unknown): unknown {
  const record = asRecord(source);
  if (!record) return source;

  const safe: Record<string, unknown> = {};
  if (record.sourceRef !== undefined) safe.sourceRef = sanitizeGovernanceAuditValue(record.sourceRef, 'sourceRef');
  if (record.sourceType !== undefined) safe.sourceType = sanitizeGovernanceAuditValue(record.sourceType, 'sourceType');
  if (record.retrievalLayer !== undefined) safe.retrievalLayer = sanitizeGovernanceAuditValue(record.retrievalLayer, 'retrievalLayer');
  if (record.summary !== undefined) safe.summary = sanitizeGovernanceAuditValue(record.summary, 'summary');

  const eventIds = sanitizeStringArray(record.eventIds);
  if (eventIds) safe.eventIds = eventIds;

  const rawEvents = Array.isArray(record.rawEvents) ? record.rawEvents : [];
  safe.rawEvents = rawEvents.slice(0, SOURCE_EVENT_LIMIT).map(sanitizeSourceEvent);
  if (rawEvents.length > SOURCE_EVENT_LIMIT) {
    safe.omittedRawEventCount = rawEvents.length - SOURCE_EVENT_LIMIT;
  }

  if (record.primaryEvent !== undefined) safe.primaryEvent = sanitizeSourceEvent(record.primaryEvent);
  if (record.rawEvent !== undefined) safe.rawEvent = sanitizeSourceEvent(record.rawEvent);
  if (record.event !== undefined) safe.event = sanitizeSourceEvent(record.event);

  return safe;
}

function sanitizeScore(value: unknown): number | undefined {
  const score = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(score) ? score : undefined;
}

function sanitizeReasons(value: unknown): string[] {
  return sanitizeStringArray(value)?.slice(0, 8) ?? [];
}

function sanitizeSearchResult(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  if (!record) return { snippet: safeSourcePreview(result) };

  const safe: Record<string, unknown> = {};
  if (record.id !== undefined) safe.id = sanitizeGovernanceAuditValue(record.id, 'id');
  if (record.sourceRef !== undefined) safe.sourceRef = sanitizeGovernanceAuditValue(record.sourceRef, 'sourceRef');
  if (record.resultType !== undefined) safe.resultType = sanitizeGovernanceAuditValue(record.resultType, 'resultType');
  const score = sanitizeScore(record.score);
  if (score !== undefined) safe.score = score;
  safe.snippet = safeSourcePreview(record.snippet ?? record.preview ?? record.summary ?? '');
  if (record.preview !== undefined) safe.preview = safeSourcePreview(record.preview);
  safe.reasons = sanitizeReasons(record.reasons);
  return safe;
}

const PLAYGROUND_META_FIELDS = [
  'total',
  'totalMatches',
  'usedVector',
  'usedKeyword',
  'usedRerank',
  'queryTimeMs',
  'strategy',
] as const;

function copySafeMetaValue(target: Record<string, unknown>, source: Record<string, unknown>, field: string) {
  const value = source[field];
  if (typeof value === 'number' || typeof value === 'boolean') {
    target[field] = value;
  } else if (typeof value === 'string') {
    target[field] = safeSourcePreview(value).slice(0, 160);
  }
}

function sanitizeMeta(meta: unknown): Record<string, unknown> | undefined {
  const record = asRecord(meta);
  if (!record) return undefined;
  const safe: Record<string, unknown> = {};
  for (const field of PLAYGROUND_META_FIELDS) {
    copySafeMetaValue(safe, record, field);
  }
  return safe;
}

function sanitizePlaygroundSearch(search: unknown): unknown {
  const record = asRecord(search);
  if (!record) return search;
  const safe: Record<string, unknown> = {
    results: Array.isArray(record.results) ? record.results.map(sanitizeSearchResult) : [],
  };
  const meta = sanitizeMeta(record.meta);
  if (meta) safe.meta = meta;
  return safe;
}

function sanitizeExpansionFact(fact: unknown): Record<string, unknown> {
  const record = asRecord(fact);
  if (!record) return { snippet: safeSourcePreview(fact) };

  const safe: Record<string, unknown> = {};
  if (record.id !== undefined) safe.id = sanitizeGovernanceAuditValue(record.id, 'id');
  if (record.eventId !== undefined) safe.eventId = sanitizeGovernanceAuditValue(record.eventId, 'eventId');
  if (record.sourceRef !== undefined) safe.sourceRef = sanitizeGovernanceAuditValue(record.sourceRef, 'sourceRef');
  if (record.eventType !== undefined) safe.eventType = sanitizeGovernanceAuditValue(record.eventType, 'eventType');
  if (record.sessionId !== undefined) safe.sessionId = sanitizeGovernanceAuditValue(record.sessionId, 'sessionId');
  if (record.timestamp !== undefined) safe.timestamp = sanitizeGovernanceAuditValue(record.timestamp, 'timestamp');
  const preview = safeSourcePreview(record.snippet ?? record.summary ?? record.preview ?? record.content ?? '');
  safe.snippet = preview;
  safe.preview = preview;
  return safe;
}

function sanitizeRelatedSource(source: unknown): Record<string, unknown> {
  const record = asRecord(source);
  if (!record) return { preview: safeSourcePreview(source) };
  const safe: Record<string, unknown> = {};
  if (record.sourceRef !== undefined) safe.sourceRef = sanitizeGovernanceAuditValue(record.sourceRef, 'sourceRef');
  const eventIds = sanitizeStringArray(record.eventIds);
  if (eventIds) safe.eventIds = eventIds;
  const previewSource = record.snippet ?? record.summary ?? record.preview;
  if (previewSource !== undefined) safe.preview = safeSourcePreview(previewSource);
  return safe;
}

function sanitizePlaygroundExpansion(expansion: unknown): unknown {
  const record = asRecord(expansion);
  if (!record) return expansion;
  const safe: Record<string, unknown> = {};
  if (record.target !== undefined) safe.target = sanitizeSearchResult(record.target);
  safe.surroundingFacts = Array.isArray(record.surroundingFacts)
    ? record.surroundingFacts.slice(0, 12).map(sanitizeExpansionFact)
    : [];
  safe.relatedSources = Array.isArray(record.relatedSources)
    ? record.relatedSources.slice(0, 12).map(sanitizeRelatedSource)
    : [];
  return safe;
}

function selectedResultIdFrom(searchResult: { results?: Array<{ id?: string; sourceRef?: string }> }, requested?: string): string | null {
  if (requested && searchResult.results?.some((r) => r.id === requested || r.sourceRef === requested)) {
    return requested;
  }
  const first = searchResult.results?.[0];
  return first?.id ?? first?.sourceRef ?? null;
}

// POST /api/playground/dry-run - Search → Expand → Source without mutations
playgroundRouter.post('/dry-run', async (c) => {
  let body: PlaygroundDryRunRequest;
  try {
    body = await c.req.json<PlaygroundDryRunRequest>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const query = body.query?.trim();
  if (!query) {
    return c.json({ error: 'Query is required' }, 400);
  }

  const useFastStrategy = body.options?.strategy === 'fast';
  const memoryService = useFastStrategy ? getLightweightServiceFromQuery(c) : getServiceFromQuery(c);
  const replayTrace: string[] = [];

  try {
    await memoryService.initialize();
    replayTrace.push('search');

    const search = await memoryService.searchDisclosure(query, disclosureOptions(body.options));
    const selectedResultId = selectedResultIdFrom(search, body.options?.selectedResultId);
    const safeSearch = sanitizePlaygroundSearch(search);

    if (!selectedResultId) {
      replayTrace.push('no-results');
      return c.json({
        dryRun: true,
        mutated: false,
        query,
        selectedResultId: null,
        search: safeSearch,
        expansion: null,
        source: null,
        replayTrace,
      });
    }

    const windowSize = normalizeWindowSize(body.options?.windowSize);
    replayTrace.push(`expand:${selectedResultId}`);
    const expansion = sanitizePlaygroundExpansion(await memoryService.expandDisclosure(selectedResultId, { windowSize }));

    replayTrace.push(`source:${selectedResultId}`);
    const source = sanitizePlaygroundSource(await memoryService.sourceDisclosure(selectedResultId));

    return c.json({
      dryRun: true,
      mutated: false,
      query,
      selectedResultId,
      search: safeSearch,
      expansion,
      source,
      replayTrace,
    });
  } catch (error) {
    return c.json({ error: safeSourcePreview((error as Error).message), dryRun: true, mutated: false, replayTrace }, 500);
  } finally {
    await memoryService.shutdown();
  }
});
