import type {
  RetrievalDisclosureExpansion,
  RetrievalDisclosureSearchResponse,
  RetrievalDisclosureSource
} from '../core/engine/retrieval-disclosure-service.js';
import type { RetrievalResultEnvelope } from '../core/model/retrieval-result.js';
import type { UnifiedRetrievalResult } from '../core/retriever.js';

export function formatPlainSearchResults(result: UnifiedRetrievalResult): string {
  const lines: string[] = [
    '',
    '📚 Search Results',
    '',
    `Confidence: ${result.matchResult.confidence}`,
    `Total local memories found: ${result.memories.length}`,
    `Shared memories found: ${result.sharedMemories?.length ?? 0}`,
    ''
  ];

  for (const memory of result.memories) {
    const date = memory.event.timestamp.toISOString().split('T')[0];
    lines.push('---');
    lines.push(`📌 ${memory.event.eventType} (${date})`);
    lines.push(`   Score: ${memory.score.toFixed(3)}`);
    lines.push(`   Session: ${memory.event.sessionId.slice(0, 8)}...`);
    lines.push(`   Content: ${preview(memory.event.content, 200)}`);
    lines.push('');
  }

  if (result.sharedMemories && result.sharedMemories.length > 0) {
    lines.push('🌐 Shared Memories', '');
    for (const entry of result.sharedMemories) {
      lines.push('---');
      lines.push(`🌐 ${entry.title}`);
      lines.push(`   Source: shared:${entry.entryId}`);
      lines.push(`   Project: ${entry.sourceProjectHash}`);
      lines.push(`   Score: ${entry.confidence.toFixed(3)}`);
      lines.push(`   Topics: ${entry.topics.join(', ') || 'n/a'}`);
      lines.push(`   Symptoms: ${entry.symptoms.join('; ') || 'n/a'}`);
      lines.push(`   Root cause: ${entry.rootCause}`);
      lines.push(`   Solution: ${entry.solution}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function formatDisclosureSearch(response: RetrievalDisclosureSearchResponse): string {
  const lines: string[] = [
    '',
    '🔎 Progressive Search Results',
    '',
    `Meta: total=${response.meta.total} vector=${yesNo(response.meta.usedVector)} keyword=${yesNo(response.meta.usedKeyword)} fallback=${yesNo(response.meta.fallbackApplied)}`,
    ''
  ];

  if (response.results.length === 0) {
    lines.push('No results found.', '');
    return lines.join('\n');
  }

  response.results.forEach((result, index) => {
    lines.push(formatEnvelope(result, index + 1));
  });

  return lines.join('\n');
}

export function formatDisclosureExpansion(expansion: RetrievalDisclosureExpansion): string {
  const lines: string[] = [
    '',
    '🧩 Expanded Retrieval Result',
    '',
    'Target',
    formatEnvelope(expansion.target),
    ''
  ];

  if (expansion.surroundingFacts && expansion.surroundingFacts.length > 0) {
    lines.push('Surrounding');
    expansion.surroundingFacts.forEach((item, index) => {
      lines.push(formatEnvelope(item, index + 1));
    });
    lines.push('');
  }

  if (expansion.summaries && expansion.summaries.length > 0) {
    lines.push('Summaries');
    expansion.summaries.forEach((item, index) => {
      lines.push(formatEnvelope(item, index + 1));
    });
    lines.push('');
  }

  if (expansion.relatedSources && expansion.relatedSources.length > 0) {
    lines.push('Sources');
    for (const source of expansion.relatedSources) {
      lines.push(`- ${source.sourceRef} (${source.sourceType}) events=${source.eventIds.join(',')}`);
      lines.push(...formatMetadataLines(source.metadata, '  '));
    }
    lines.push('');
  }

  if (expansion.expandedContext) {
    lines.push('Expanded Context', expansion.expandedContext, '');
  }

  return lines.join('\n');
}

export function formatDisclosureSource(source: RetrievalDisclosureSource): string {
  const lines: string[] = [
    '',
    '📎 Retrieval Source',
    '',
    `sourceRef: ${source.sourceRef}`,
    `sourceType: ${source.sourceType}`,
    `eventIds: ${source.eventIds.join(', ')}`,
    ''
  ];

  if (source.rawEvents.length > 0) {
    lines.push('Raw Events');
    for (const event of source.rawEvents) {
      const timestamp = event.timestamp instanceof Date
        ? event.timestamp.toISOString()
        : String(event.timestamp);
      lines.push(`- ${event.id} ${timestamp}`);
      lines.push(`  [${event.eventType}] ${preview(event.content, 500)}`);
      if (event.sessionId) lines.push(`  session: ${event.sessionId}`);
      if (event.canonicalKey) lines.push(`  canonicalKey: ${event.canonicalKey}`);
    }
    lines.push('');
  } else if (source.sourceType === 'shared_troubleshooting') {
    lines.push('No local raw events for this shared source.', '');
  }

  if (source.metadata && Object.keys(source.metadata).length > 0) {
    lines.push('Shared Metadata');
    lines.push(...formatMetadataLines(source.metadata, '  '));
    lines.push('');
  }

  return lines.join('\n');
}

function formatEnvelope(result: RetrievalResultEnvelope, index?: number): string {
  const prefix = index ? `${index}. ` : '- ';
  const title = result.title ? ` ${result.title}` : '';
  const lines = [
    `${prefix}[${result.resultType}]${title}`,
    `   id: ${result.id}`,
    `   score: ${result.score.toFixed(3)}`,
    `   reasons: ${result.reasons.join(', ') || 'n/a'}`,
    `   source: ${result.sourceRef || 'n/a'}`
  ];

  if (result.sessionId) {
    lines.push(`   session: ${result.sessionId.slice(0, 12)}${result.sessionId.length > 12 ? '...' : ''}`);
  }

  lines.push(...formatMetadataLines(result.metadata, '   ', ['sourceProjectHash', 'sourceEntryId', 'topics']));
  lines.push(`   snippet: ${result.snippet}`);
  lines.push('');

  return lines.join('\n');
}

function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}

function preview(content: string, maxLength: number): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatMetadataLines(
  metadata: Record<string, unknown> | undefined,
  prefix: string,
  allowedKeys?: string[]
): string[] {
  if (!metadata) return [];
  return Object.entries(metadata)
    .filter(([key, value]) => value !== undefined && (!allowedKeys || allowedKeys.includes(key)))
    .map(([key, value]) => `${prefix}${key}: ${formatMetadataValue(value)}`);
}

function formatMetadataValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
