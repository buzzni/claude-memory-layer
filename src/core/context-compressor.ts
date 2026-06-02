export type ContextCompressionMode = 'off' | 'safe' | 'aggressive';
export type ContextContentType = 'log' | 'markdown' | 'diff' | 'code' | 'plain';
export type ContextCompressionStrategy =
  | 'none'
  | 'log_signal'
  | 'markdown_outline'
  | 'diff_hunks'
  | 'code_outline'
  | 'plain_head_tail';

export interface ContextCompressionOptions {
  mode: ContextCompressionMode;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextCompressionMetadata {
  mode: ContextCompressionMode;
  source: string;
  contentType: ContextContentType;
  strategy: ContextCompressionStrategy;
  originalChars: number;
  compressedChars: number;
  savedChars: number;
  compressionRatio: number;
  originalLines: number;
  omittedLines: number;
  signalCount: number;
}

export interface ContextCompressionResult {
  text: string;
  metadata: ContextCompressionMetadata;
}

export interface CompressionGroupSummary {
  source?: string;
  strategy?: ContextCompressionStrategy;
  items: number;
  originalChars: number;
  compressedChars: number;
  savedChars: number;
}

export interface CompressionTelemetrySummary {
  totalItems: number;
  totalOriginalChars: number;
  totalCompressedChars: number;
  totalSavedChars: number;
  bySource: Array<CompressionGroupSummary & { source: string }>;
  byStrategy: Array<CompressionGroupSummary & { strategy: ContextCompressionStrategy }>;
}

const LOG_SIGNAL_LINE_PATTERN = /\b(error|failed|failure|fail|traceback|exception|stack trace|stderr|exit code|panic|segfault|timeout|root cause|resolved by|missing source-ref)\b/i;
const MARKDOWN_KEEP_LINE_PATTERN = /^(?:#{1,6}\s+|[-*]\s+(?:Decision|Constraint|Next|Action|Verify|TODO|Blocker|Risk|Accepted|Rejected)\b|\d+\.\s+(?:Decision|Constraint|Next|Action|Verify|TODO|Blocker|Risk)\b)/i;
const CODE_DECLARATION_PATTERN = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|def)\s+[A-Za-z0-9_$]+|^\s*(?:import|from)\s+/;

export function detectContextContentType(content: string, metadata: Record<string, unknown> = {}): ContextContentType {
  const explicit = explicitContentType(metadata);
  if (explicit && explicit !== 'plain') return explicit;

  const eventType = typeof metadata.eventType === 'string' ? metadata.eventType.toLowerCase() : '';
  if (eventType === 'tool_observation') return 'log';

  if (/^(?:diff --git |Index: |@@\s|---\s|\+\+\+\s)/m.test(content)) return 'diff';
  if (/^#{1,6}\s+|\n#{1,6}\s+|\n[-*]\s+(?:Decision|Constraint|Next|Action|Verify|TODO|Blocker|Risk)\b/i.test(content)) return 'markdown';
  if (looksLikeLog(content)) return 'log';
  if (looksLikeCode(content)) return 'code';
  return explicit ?? 'plain';
}

export class ContextCompressor {
  compress(content: string, options: ContextCompressionOptions): ContextCompressionResult {
    const source = safeLabel(options.source) || 'unknown';
    const mode = options.mode;
    const contentType = detectContextContentType(content, options.metadata ?? {});
    const originalLines = nonEmptyLines(content).length;

    if (mode === 'off') {
      return result(content, {
        mode,
        source,
        contentType,
        strategy: 'none',
        originalChars: content.length,
        originalLines,
        omittedLines: 0,
        signalCount: 0
      });
    }

    if (contentType === 'log') {
      return this.compressLog(content, mode, source, contentType);
    }
    if (contentType === 'markdown') {
      return this.compressMarkdown(content, mode, source, contentType);
    }
    if (contentType === 'diff') {
      return this.compressDiff(content, mode, source, contentType);
    }
    if (contentType === 'code') {
      return this.compressCode(content, mode, source, contentType);
    }
    return this.compressPlain(content, mode, source, contentType);
  }

  private compressLog(
    content: string,
    mode: ContextCompressionMode,
    source: string,
    contentType: ContextContentType
  ): ContextCompressionResult {
    const lines = nonEmptyLines(content);
    const normalized = content.replace(/\s+/g, ' ').trim();
    const maxSignalLines = mode === 'aggressive' ? 2 : 4;
    const maxTailLines = mode === 'aggressive' ? 1 : 2;
    const signalLines = uniqueStrings(lines.filter((line) => LOG_SIGNAL_LINE_PATTERN.test(line))).slice(0, maxSignalLines);
    const shouldCompress = signalLines.length > 0 || normalized.length > (mode === 'aggressive' ? 180 : 320) || lines.length > 12;
    if (!shouldCompress) {
      return result(content, {
        mode,
        source,
        contentType,
        strategy: 'log_signal',
        originalChars: content.length,
        originalLines: lines.length,
        omittedLines: 0,
        signalCount: signalLines.length
      });
    }

    const tailLines = uniqueStrings(lines.slice(-maxTailLines).filter((line) => !signalLines.includes(line)));
    const headLines = signalLines.length > 0 ? [] : lines.slice(0, mode === 'aggressive' ? 1 : 2);
    const parts = [`[compressed ${content.length} chars; type=log]`];
    if (signalLines.length > 0) {
      parts.push(`Signals: ${signalLines.join(' | ')}`);
    } else {
      parts.push(`Head: ${headLines.join(' | ')}`);
    }
    if (tailLines.length > 0) parts.push(`Tail: ${tailLines.join(' | ')}`);
    const emittedLines = signalLines.length > 0
      ? signalLines.length + tailLines.length
      : headLines.length + tailLines.filter((line) => !headLines.includes(line)).length;
    const omittedLines = Math.max(0, lines.length - emittedLines);
    if (omittedLines > 0) parts.push(`omittedLines=${omittedLines}`);

    return result(parts.join(' '), {
      mode,
      source,
      contentType,
      strategy: 'log_signal',
      originalChars: content.length,
      originalLines: lines.length,
      omittedLines,
      signalCount: signalLines.length
    });
  }

  private compressMarkdown(
    content: string,
    mode: ContextCompressionMode,
    source: string,
    contentType: ContextContentType
  ): ContextCompressionResult {
    const lines = nonEmptyLines(content);
    const maxLines = mode === 'aggressive' ? 6 : 10;
    const kept = uniqueStrings(lines.filter((line) => MARKDOWN_KEEP_LINE_PATTERN.test(line))).slice(0, maxLines);
    if (kept.length === 0) return this.compressPlain(content, mode, source, contentType);

    const omittedLines = Math.max(0, lines.length - kept.length);
    const output = [`[compressed ${content.length} chars; type=markdown]`, ...kept];
    if (omittedLines > 0) output.push(`omittedLines=${omittedLines}`);

    return result(output.join('\n'), {
      mode,
      source,
      contentType,
      strategy: 'markdown_outline',
      originalChars: content.length,
      originalLines: lines.length,
      omittedLines,
      signalCount: kept.filter((line) => /^[-*]\s+/i.test(line)).length
    });
  }

  private compressDiff(
    content: string,
    mode: ContextCompressionMode,
    source: string,
    contentType: ContextContentType
  ): ContextCompressionResult {
    const lines = nonEmptyLines(content);
    const maxLines = mode === 'aggressive' ? 10 : 18;
    const kept = lines.filter((line) => /^(?:diff --git |@@\s|---\s|\+\+\+\s|[+-](?![+-]))/.test(line)).slice(0, maxLines);
    const selected = kept.length > 0 ? kept : lines.slice(0, maxLines);
    const omittedLines = Math.max(0, lines.length - selected.length);
    const output = selected.length < lines.length
      ? [`[compressed ${content.length} chars; type=diff]`, ...selected, `omittedLines=${omittedLines}`].join('\n')
      : content;
    return result(output, {
      mode,
      source,
      contentType,
      strategy: 'diff_hunks',
      originalChars: content.length,
      originalLines: lines.length,
      omittedLines,
      signalCount: selected.filter((line) => /^[+-](?![+-])/.test(line)).length
    });
  }

  private compressCode(
    content: string,
    mode: ContextCompressionMode,
    source: string,
    contentType: ContextContentType
  ): ContextCompressionResult {
    const lines = nonEmptyLines(content);
    const maxLines = mode === 'aggressive' ? 8 : 14;
    const declarations = uniqueStrings(lines.filter((line) => CODE_DECLARATION_PATTERN.test(line))).slice(0, maxLines);
    const selected = declarations.length > 0 ? declarations : lines.slice(0, maxLines);
    const omittedLines = Math.max(0, lines.length - selected.length);
    const output = selected.length < lines.length
      ? [`[compressed ${content.length} chars; type=code]`, ...selected, `omittedLines=${omittedLines}`].join('\n')
      : content;
    return result(output, {
      mode,
      source,
      contentType,
      strategy: 'code_outline',
      originalChars: content.length,
      originalLines: lines.length,
      omittedLines,
      signalCount: declarations.length
    });
  }

  private compressPlain(
    content: string,
    mode: ContextCompressionMode,
    source: string,
    contentType: ContextContentType
  ): ContextCompressionResult {
    const lines = nonEmptyLines(content);
    const threshold = mode === 'aggressive' ? 220 : 420;
    if (content.replace(/\s+/g, ' ').trim().length <= threshold && lines.length <= 8) {
      return result(content, {
        mode,
        source,
        contentType,
        strategy: 'plain_head_tail',
        originalChars: content.length,
        originalLines: lines.length,
        omittedLines: 0,
        signalCount: 0
      });
    }

    const headCount = mode === 'aggressive' ? 1 : 2;
    const tailCount = mode === 'aggressive' ? 1 : 2;
    const head = lines.slice(0, headCount);
    const tail = lines.slice(-tailCount).filter((line) => !head.includes(line));
    const omittedLines = Math.max(0, lines.length - head.length - tail.length);
    const output = [`[compressed ${content.length} chars; type=plain]`, `Head: ${head.join(' | ')}`];
    if (tail.length > 0) output.push(`Tail: ${tail.join(' | ')}`);
    if (omittedLines > 0) output.push(`omittedLines=${omittedLines}`);

    return result(output.join(' '), {
      mode,
      source,
      contentType,
      strategy: 'plain_head_tail',
      originalChars: content.length,
      originalLines: lines.length,
      omittedLines,
      signalCount: 0
    });
  }
}

export function summarizeCompressionTelemetry(metadata: ContextCompressionMetadata[]): CompressionTelemetrySummary {
  const totalOriginalChars = metadata.reduce((sum, item) => sum + item.originalChars, 0);
  const totalCompressedChars = metadata.reduce((sum, item) => sum + item.compressedChars, 0);
  const totalSavedChars = metadata.reduce((sum, item) => sum + item.savedChars, 0);
  return {
    totalItems: metadata.length,
    totalOriginalChars,
    totalCompressedChars,
    totalSavedChars,
    bySource: summarizeBy(metadata, 'source') as Array<CompressionGroupSummary & { source: string }>,
    byStrategy: summarizeBy(metadata, 'strategy') as Array<CompressionGroupSummary & { strategy: ContextCompressionStrategy }>
  };
}

function summarizeBy(
  metadata: ContextCompressionMetadata[],
  key: 'source' | 'strategy'
): CompressionGroupSummary[] {
  const groups = new Map<string, CompressionGroupSummary>();
  for (const item of metadata) {
    const groupKey = String(item[key]);
    const existing = groups.get(groupKey) ?? {
      [key]: groupKey,
      items: 0,
      originalChars: 0,
      compressedChars: 0,
      savedChars: 0
    } as CompressionGroupSummary;
    existing.items += 1;
    existing.originalChars += item.originalChars;
    existing.compressedChars += item.compressedChars;
    existing.savedChars += item.savedChars;
    groups.set(groupKey, existing);
  }
  return Array.from(groups.values()).sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? '')));
}

function result(
  text: string,
  base: Omit<ContextCompressionMetadata, 'compressedChars' | 'savedChars' | 'compressionRatio'>
): ContextCompressionResult {
  const compressedChars = text.length;
  const savedChars = Math.max(0, base.originalChars - compressedChars);
  const compressionRatio = base.originalChars > 0 ? compressedChars / base.originalChars : 1;
  return {
    text,
    metadata: {
      ...base,
      compressedChars,
      savedChars,
      compressionRatio
    }
  };
}

function explicitContentType(metadata: Record<string, unknown>): ContextContentType | undefined {
  for (const key of ['contentType', 'content_type', 'mimeType', 'mime_type']) {
    const value = metadata[key];
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    if (!normalized) continue;
    if (normalized.includes('markdown') || normalized === 'md' || normalized.endsWith('/md')) return 'markdown';
    if (normalized.includes('x-log') || normalized.includes('log') || normalized.includes('stderr') || normalized.includes('stdout')) return 'log';
    if (normalized.includes('diff') || normalized.includes('patch')) return 'diff';
    if (normalized.includes('javascript') || normalized.includes('typescript') || normalized.includes('python') || normalized.includes('json') || normalized.includes('yaml')) return 'code';
    if (normalized.startsWith('text/')) return 'plain';
  }
  return undefined;
}

function looksLikeLog(content: string): boolean {
  const lines = nonEmptyLines(content);
  if (lines.some((line) => LOG_SIGNAL_LINE_PATTERN.test(line))) return true;
  const levelLines = lines.filter((line) => /\b(?:INFO|WARN|ERROR|DEBUG|TRACE)\b|^\[[A-Z]+\]/.test(line)).length;
  return lines.length >= 4 && levelLines >= 2;
}

function looksLikeCode(content: string): boolean {
  const lines = nonEmptyLines(content);
  const declarationCount = lines.filter((line) => CODE_DECLARATION_PATTERN.test(line)).length;
  const braceCount = (content.match(/[{}]/g) ?? []).length;
  return declarationCount > 0 && (braceCount > 0 || /;\s*$|:\s*$/m.test(content));
}

function nonEmptyLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function safeLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return cleaned || undefined;
}
