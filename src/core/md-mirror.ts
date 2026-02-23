import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryEventInput } from './types.js';

function sanitizeSegment(input: string | undefined, fallback: string): string {
  const v = (input || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return v || fallback;
}

function getAtPath(obj: Record<string, unknown> | undefined, dotted: string): unknown {
  if (!obj) return undefined;
  return dotted.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

export function buildMirrorPath(rootDir: string, event: MemoryEventInput): string {
  const meta = event.metadata as Record<string, unknown> | undefined;

  const namespaceRaw = getAtPath(meta, 'namespace') ?? getAtPath(meta, 'scope.namespace') ?? event.eventType;
  const namespace = sanitizeSegment(typeof namespaceRaw === 'string' ? namespaceRaw : undefined, 'general');

  const categoryRaw = getAtPath(meta, 'categoryPath') ?? getAtPath(meta, 'scope.categoryPath');
  const categoryPath = Array.isArray(categoryRaw) && categoryRaw.length > 0
    ? categoryRaw.map((x) => sanitizeSegment(typeof x === 'string' ? x : undefined, 'uncategorized'))
    : [sanitizeSegment(event.eventType, 'uncategorized')];

  const d = event.timestamp;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');

  return path.join(rootDir, 'memory', namespace, ...categoryPath, `${yyyy}-${mm}-${dd}.md`);
}

export class MarkdownMirror {
  constructor(private readonly rootDir: string) {}

  async append(event: MemoryEventInput, eventId?: string): Promise<void> {
    const out = buildMirrorPath(this.rootDir, event);
    fs.mkdirSync(path.dirname(out), { recursive: true });

    const lines = [
      '',
      `## ${event.timestamp.toISOString()} | ${eventId ?? 'pending-id'}`,
      `- type: ${event.eventType}`,
      `- session: ${event.sessionId}`,
      event.content,
    ];

    await fs.promises.appendFile(out, lines.join('\n'), 'utf8');
  }
}
