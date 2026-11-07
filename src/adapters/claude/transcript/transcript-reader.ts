import * as fs from 'fs';

export interface ClaudeTranscriptEntry {
  type?: string;
  message?: {
    content?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TranscriptRange {
  entries: ClaudeTranscriptEntry[];
  /** Byte offset just past the last complete JSONL record that was read. */
  endOffset: number;
}

/**
 * Read the JSONL entries that lie in bytes [start, end) of a Claude transcript.
 *
 * A record cut by `start` is skipped. A trailing record without a newline is
 * read only if it already parses, so a line Claude is still writing is left
 * for the next read: `endOffset` then stops before it.
 */
export function readTranscriptRange(transcriptPath: string, start: number, end: number): TranscriptRange {
  // Read one byte early to tell whether `start` is a record boundary.
  const readFrom = Math.max(0, start - 1);
  const buffer = Buffer.alloc(Math.max(0, end - readFrom));
  const fd = fs.openSync(transcriptPath, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < buffer.length) {
      const n = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, readFrom + bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
  } finally {
    fs.closeSync(fd);
  }

  const data = buffer.subarray(0, bytesRead);
  let lineStart = start > 0 ? data.indexOf(0x0a) + 1 : 0;
  if (start > 0 && lineStart === 0) return { entries: [], endOffset: start };

  const entries: ClaudeTranscriptEntry[] = [];
  const pushIfObject = (line: string): boolean => {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === 'object' && parsed !== null) entries.push(parsed as ClaudeTranscriptEntry);
      return true;
    } catch {
      return false;
    }
  };

  let consumed = lineStart;
  for (let newline = data.indexOf(0x0a, lineStart); newline !== -1; newline = data.indexOf(0x0a, lineStart)) {
    pushIfObject(data.toString('utf8', lineStart, newline));
    lineStart = newline + 1;
    consumed = lineStart;
  }
  const trailing = data.toString('utf8', lineStart);
  if (trailing.trim() && pushIfObject(trailing)) consumed = data.length;

  return { entries, endOffset: readFrom + consumed };
}
