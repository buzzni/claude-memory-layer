/** Selected trace named by a successful delivery ack; malformed records never imply a link. */
export function deliveredSelectionTraceId(resultJson: string | null | undefined): string | null {
  if (typeof resultJson !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(resultJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const result = parsed as Record<string, unknown>;
    return result.outcome === 'delivered' && typeof result.traceId === 'string' && result.traceId.length > 0
      ? result.traceId
      : null;
  } catch {
    return null;
  }
}
