/**
 * Context Formatter
 * Formats progressive search results for Claude context injection
 */

import type {
  ProgressiveSearchResult,
  SearchIndexItem,
  TimelineItem,
  FullDetail,
  CitedSearchResult
} from './types.js';
import { formatCitationId } from './citation-generator.js';

export interface FormatOptions {
  format?: 'inline' | 'footnote' | 'reference';
  showTokens?: boolean;
  maxWidth?: number;
}

export class ContextFormatter {
  /**
   * Format progressive search result for Claude context
   */
  formatProgressiveResult(
    result: ProgressiveSearchResult,
    options?: FormatOptions
  ): string {
    const parts: string[] = [];

    // Layer 1: Always included (index)
    parts.push(this.formatLayer1(result.index));

    // Layer 2: Timeline (if expanded)
    if (result.timeline && result.timeline.length > 0) {
      parts.push(this.formatLayer2(result.timeline));
    }

    // Layer 3: Details (if expanded)
    if (result.details && result.details.length > 0) {
      parts.push(this.formatLayer3(result.details, options));
    }

    // Meta information
    if (options?.showTokens !== false) {
      parts.push(this.formatMeta(result.meta));
    }

    return parts.join('\n\n');
  }

  /**
   * Format Layer 1: Search Index
   */
  private formatLayer1(items: SearchIndexItem[]): string {
    if (items.length === 0) {
      return '## Related Memories\n\nNo relevant memories found.';
    }

    const header = `## Related Memories (${items.length} matches)\n`;
    const rows = items.map((item, i) => {
      const date = item.timestamp.toISOString().split('T')[0];
      return `${i + 1}. **[${item.id.slice(0, 8)}]** ${item.summary} _(${date}, score: ${item.score.toFixed(2)})_`;
    }).join('\n');

    return header + rows;
  }

  /**
   * Format Layer 2: Timeline
   */
  private formatLayer2(items: TimelineItem[]): string {
    const header = '## Timeline Context\n';
    const timeline = items.map(item => {
      const marker = item.isTarget ? '**→**' : '   ';
      const time = item.timestamp.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit'
      });
      const typeIcon = this.getTypeIcon(item.type);
      return `${marker} ${time} ${typeIcon} ${item.preview}`;
    }).join('\n');

    return header + timeline;
  }

  /**
   * Format Layer 3: Full Details
   */
  private formatLayer3(items: FullDetail[], options?: FormatOptions): string {
    const format = options?.format ?? 'inline';

    switch (format) {
      case 'inline':
        return this.formatDetailsInline(items);
      case 'footnote':
        return this.formatDetailsFootnote(items);
      case 'reference':
        return this.formatDetailsReference(items);
    }
  }

  /**
   * Inline format for details
   */
  private formatDetailsInline(items: FullDetail[]): string {
    return items.map(item => {
      const date = item.timestamp.toLocaleDateString();
      const session = item.sessionId.slice(0, 8);
      const citation = item.citationId ? formatCitationId(item.citationId) : '';

      const header = `## Detail: ${item.id.slice(0, 8)}`;
      const meta = `_${item.type} | Session: ${session} | ${date}_`;
      const content = item.content;
      const footer = citation ? `\n${citation}` : '';

      return [header, meta, '', content, footer].join('\n');
    }).join('\n\n---\n\n');
  }

  /**
   * Footnote format for details
   */
  private formatDetailsFootnote(items: FullDetail[]): string {
    const content = items.map((item, i) => {
      return `${item.content} [${i + 1}]`;
    }).join('\n\n');

    const footnotes = items.map((item, i) => {
      const citation = item.citationId ? formatCitationId(item.citationId) : `[${item.id.slice(0, 8)}]`;
      const date = item.timestamp.toLocaleDateString();
      return `[${i + 1}] ${citation} - ${date}`;
    }).join('\n');

    return `${content}\n\n---\n**References:**\n${footnotes}`;
  }

  /**
   * Reference format for details
   */
  private formatDetailsReference(items: FullDetail[]): string {
    const content = items.map(item => {
      return `### ${item.type}\n${item.content}`;
    }).join('\n\n');

    const references = items.map(item => {
      const citation = item.citationId ? formatCitationId(item.citationId) : `[${item.id.slice(0, 8)}]`;
      const date = item.timestamp.toLocaleDateString();
      return `- ${citation} Session ${item.sessionId.slice(0, 8)}, ${date}`;
    }).join('\n');

    return `## Content\n\n${content}\n\n## References\n${references}`;
  }

  /**
   * Format meta information
   */
  private formatMeta(meta: ProgressiveSearchResult['meta']): string {
    const parts: string[] = [];

    if (meta.expansionReason) {
      const reasonText = this.getExpansionReasonText(meta.expansionReason);
      parts.push(`_${reasonText}_`);
    }

    parts.push(`_~${meta.estimatedTokens} tokens | ${meta.expandedCount} expanded_`);

    return parts.join(' | ');
  }

  /**
   * Get icon for event type
   */
  private getTypeIcon(type: string): string {
    switch (type) {
      case 'user_prompt':
        return '👤';
      case 'agent_response':
        return '🤖';
      case 'session_summary':
        return '📋';
      case 'tool_observation':
        return '🔧';
      default:
        return '📄';
    }
  }

  /**
   * Get human-readable expansion reason
   */
  private getExpansionReasonText(reason: string): string {
    switch (reason) {
      case 'high_confidence_single':
        return 'High confidence match - auto-expanded';
      case 'clear_winner':
        return 'Clear best match found';
      case 'ambiguous_multiple_high':
        return 'Multiple relevant results - showing timeline';
      case 'low_confidence':
        return 'No high confidence matches';
      case 'no_results':
        return 'No matches found';
      default:
        return reason;
    }
  }
}

/**
 * Format context with citations (for cited search results)
 */
export function formatContextWithCitations(
  results: CitedSearchResult[],
  options?: FormatOptions
): string {
  const format = options?.format ?? 'inline';

  switch (format) {
    case 'inline':
      return formatCitedInline(results);
    case 'footnote':
      return formatCitedFootnote(results);
    case 'reference':
      return formatCitedReference(results);
  }
}

function formatCitedInline(results: CitedSearchResult[]): string {
  return results.map(r => {
    const date = r.event.timestamp.toLocaleDateString();
    const session = r.event.sessionId.slice(0, 8);
    const citation = formatCitationId(r.citation.citationId);

    return [
      `> ${r.event.content}`,
      `>`,
      `> ${citation} - ${date}, Session ${session}`
    ].join('\n');
  }).join('\n\n---\n\n');
}

function formatCitedFootnote(results: CitedSearchResult[]): string {
  const content = results.map((r, i) => {
    return `${r.event.content} [${i + 1}]`;
  }).join('\n\n');

  const footnotes = results.map((r, i) => {
    const citation = formatCitationId(r.citation.citationId);
    const date = r.event.timestamp.toLocaleDateString();
    return `[${i + 1}] ${citation} - ${date}`;
  }).join('\n');

  return `${content}\n\n---\n**References:**\n${footnotes}`;
}

function formatCitedReference(results: CitedSearchResult[]): string {
  const content = results.map(r => {
    return `### ${r.event.eventType}\n${r.event.content}`;
  }).join('\n\n');

  const references = results.map(r => {
    const citation = formatCitationId(r.citation.citationId);
    const date = r.event.timestamp.toLocaleDateString();
    return `- ${citation} Session ${r.event.sessionId.slice(0, 8)}, ${date}`;
  }).join('\n');

  return `## Content\n\n${content}\n\n## References\n${references}`;
}

/**
 * Create a context formatter instance
 */
export function createContextFormatter(): ContextFormatter {
  return new ContextFormatter();
}
