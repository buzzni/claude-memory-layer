/**
 * Harness boilerplate detection.
 *
 * Agent harnesses deliver some of their own output through the user-message
 * channel (local slash-command transcripts, injected reminders). Importers,
 * qrels extraction, and retrieval guards share these checks so the same text
 * is classified the same way everywhere.
 */

const COMMAND_ARTIFACT_PATTERNS = [
  /<\/?(?:local-command-(?:stdout|stderr)|command-(?:name|message))\b/i,
  /<command-name>[\s\S]*?<\/command-name>/i,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/i,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/i
];

/** Claude local-command transcript entry, as filtered by the importers and qrels extraction. */
export function isClaudeLocalCommandArtifact(content: string): boolean {
  const trimmed = content.trim();
  return (
    /^<local-command-(stdout|stderr)>/.test(trimmed) ||
    /^<command-(name|message)>/.test(trimmed) ||
    (trimmed.includes('<command-name>') && trimmed.includes('<local-command-stdout>'))
  );
}

/** Command artifact mentioned anywhere in the text, as checked by the retrieval guards. */
export function containsCommandArtifact(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const normalized = trimmed.toLowerCase();
  if (normalized.includes('local-command-stdout') || normalized.includes('local-command-stderr')) return true;
  if (normalized.includes('command-name') || normalized.includes('command-message')) return true;
  return COMMAND_ARTIFACT_PATTERNS.some((pattern) => pattern.test(trimmed));
}
