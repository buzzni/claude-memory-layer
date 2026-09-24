export const TAG_NAMESPACES = {
  SYSTEM: 'sys:',
  QUALITY: 'q:',
  PROJECT: 'proj:',
  TOPIC: 'topic:',
  TEMPORAL: 't:',
  USER: 'user:',
  AGENT: 'agent:'
} as const;

export const VALID_TAG_NAMESPACES = new Set<string>(Object.values(TAG_NAMESPACES));

export function parseTag(tag: string): { namespace?: string; value: string } {
  const value = (tag || '').trim();
  const idx = value.indexOf(':');
  if (idx <= 0) return { value };

  const namespace = `${value.slice(0, idx)}:`;
  const tagValue = value.slice(idx + 1);
  if (!tagValue) return { value };

  return { namespace, value: tagValue };
}

export function validateTag(tag: string): boolean {
  const normalized = (tag || '').trim();
  if (!normalized) return false;

  const { namespace } = parseTag(normalized);
  if (!namespace) return true; // backward compatibility for legacy tags
  return VALID_TAG_NAMESPACES.has(namespace);
}

export function withNamespace(value: string, namespace: string): string {
  const clean = parseTag(value).value.trim();
  return `${namespace}${clean}`;
}

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];

  const dedup = new Set<string>();
  for (const item of tags) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim();
    if (!validateTag(normalized)) continue;
    dedup.add(normalized);
  }

  return [...dedup];
}
