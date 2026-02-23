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
    : ['uncategorized'];

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
    await this.refreshIndex();
  }

  private async refreshIndex(): Promise<void> {
    const memoryRoot = path.join(this.rootDir, 'memory');
    await fs.promises.mkdir(memoryRoot, { recursive: true });

    const files: string[] = [];
    await this.walk(memoryRoot, files);

    const mdFiles = files
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.relative(this.rootDir, f))
      .filter((rel) => rel !== path.join('memory', '_index.md'))
      .sort();

    const index = [
      '# Memory Index',
      '',
      'Generated automatically by MarkdownMirror.',
      '',
      ...mdFiles.map((rel) => `- ${rel}`),
      '',
    ].join('\n');

    await fs.promises.writeFile(path.join(memoryRoot, '_index.md'), index, 'utf8');
  }

  private async walk(dir: string, out: string[]): Promise<void> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await this.walk(full, out);
      } else {
        out.push(full);
      }
    }
  }
}
