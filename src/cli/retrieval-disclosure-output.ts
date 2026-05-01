import type {
  RetrievalDisclosureExpansion,
  RetrievalDisclosureSearchResponse,
  RetrievalDisclosureSource
} from '../core/engine/retrieval-disclosure-service.js';
import type { RetrievalResultEnvelope } from '../core/model/retrieval-result.js';

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
