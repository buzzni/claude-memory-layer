import * as fs from 'fs';
import * as readline from 'readline';

export interface ClaudeTranscriptEntry {
  type?: string;
  message?: {
    content?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ReadTranscriptTailOptions {
  /** Maximum number of bytes to scan from the end of the transcript. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 200 * 1024;

/**
 * Read JSONL entries from the tail of a Claude transcript.
 *
 * Claude transcripts can grow large during long sessions, so hook-time readers
 * should scan only the recent tail by default. Malformed lines are skipped to
 * tolerate starting in the middle of a JSONL record.
 */
export async function readTranscriptTailEntries(
  transcriptPath: string,
  options: ReadTranscriptTailOptions = {}
): Promise<ClaudeTranscriptEntry[]> {
  if (!fs.existsSync(transcriptPath)) return [];

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const stats = fs.statSync(transcriptPath);
  const readStart = Math.max(0, stats.size - maxBytes);
  const entries: ClaudeTranscriptEntry[] = [];

  const stream = fs.createReadStream(transcriptPath, {
    start: readStart,
    encoding: 'utf8'
  });

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        entries.push(parsed as ClaudeTranscriptEntry);
      }
    } catch {
      // Skip malformed lines, including a partial first line when readStart > 0.
    }
  }

  return entries;
}
