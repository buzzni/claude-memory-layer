import { appendFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import type { MemoryEvent } from './types.js';

const DEFAULT_NAMESPACE = 'default';
const DEFAULT_CATEGORY = 'uncategorized';

export function sanitizeSegment(input: unknown, fallback: string): string {
  const raw = String(input ?? '').trim().toLowerCase();
  const safe = raw
    .normalize('NFKD')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!safe || safe === '.' || safe === '..') return fallback;
  return safe;
}

function getCategorySegments(metadata: Record<string, unknown> | undefined, eventType: string): string[] {
  const raw = metadata?.categoryPath;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((s) => sanitizeSegment(s, DEFAULT_CATEGORY));
  }
  const single = metadata?.category;
  if (typeof single === 'string' && single.trim()) {
    return [sanitizeSegment(single, DEFAULT_CATEGORY)];
  }
  return [sanitizeSegment(eventType, DEFAULT_CATEGORY)];
}

export function buildMirrorPath(rootDir: string, event: MemoryEvent): string {
  const metadata = event.metadata as Record<string, unknown> | undefined;
  const namespace = sanitizeSegment(metadata?.namespace, DEFAULT_NAMESPACE);
  const categories = getCategorySegments(metadata, event.eventType);

  const d = event.timestamp;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');

  return path.join(rootDir, 'memory', namespace, ...categories, `${yyyy}-${mm}-${dd}.md`);
}

export function formatMirrorEntry(event: MemoryEvent): string {
  const category = Array.isArray((event.metadata as any)?.categoryPath)
    ? ((event.metadata as any).categoryPath as unknown[]).join('/')
    : String((event.metadata as any)?.category ?? event.eventType);

  return [
    '',
    `- ts: ${event.timestamp.toISOString()}`,
    `  id: ${event.id}`,
    `  type: ${event.eventType}`,
    `  session: ${event.sessionId}`,
    `  category: ${category}`,
    '  content: |',
    ...event.content.split('\n').map((line) => `    ${line}`)
  ].join('\n') + '\n';
}

export class MarkdownMirror {
  constructor(private readonly rootDir: string) {}

  async append(event: MemoryEvent): Promise<string> {
    const outPath = buildMirrorPath(this.rootDir, event);
    // Synchronous too, so the entry is on disk before SQLiteEventStore.append
    // resolves: a caller that removes or leaves the store right after never
    // races a pending directory creation.
    mkdirSync(path.dirname(outPath), { recursive: true });
    // Open and write in one step. redact-credentials replaces mirror files by
    // rename, and an entry written through a descriptor opened before the swap
    // but written after the run read the old file is lost (#267); an async
    // append waits on the event loop between the two.
    appendFileSync(outPath, formatMirrorEntry(event), 'utf8');
    return outPath;
  }
}
