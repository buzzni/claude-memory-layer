import * as fs from 'fs';
import * as readline from 'readline';

import { normalizeUserPrompt } from '../../../core/prompt-normalizer.js';
import type { TurnTrigger } from '../../../core/turn-state.js';
import type { ClaudeTranscriptEntry } from './transcript-reader.js';
import { extractAssistantTextMessages, isUserPromptEntry, type AssistantTextMessage } from './turn-reconstructor.js';

export interface ReadTranscriptTurnsOptions {
  /** Read only bytes before this offset; a record it cuts is skipped. */
  endOffset?: number;
}

export interface TranscriptTurn {
  /** When the prompt that opened the turn was written; absent for text before the first prompt. */
  startedAt?: string;
  trigger: TurnTrigger;
  messages: AssistantTextMessage[];
}

function promptText(entry: ClaudeTranscriptEntry): string {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      (block as { type?: unknown })?.type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Read a whole Claude transcript as turns of assistant text messages.
 *
 * The file is streamed and only assistant text is kept, so a transcript of
 * hundreds of megabytes of tool results does not have to fit in memory.
 * Entries recorded under another session id (history a resumed or forked
 * session copied in) belong to that session and are skipped.
 */
export async function readTranscriptTurns(
  transcriptPath: string,
  sessionId: string,
  options: ReadTranscriptTurnsOptions = {}
): Promise<TranscriptTurn[]> {
  if (!fs.existsSync(transcriptPath)) return [];
  if (options.endOffset !== undefined && options.endOffset <= 0) return [];

  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  const input = fs.createReadStream(transcriptPath, {
    encoding: 'utf8',
    ...(options.endOffset !== undefined ? { end: options.endOffset - 1 } : {})
  });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    let entry: ClaudeTranscriptEntry;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null) continue;
      entry = parsed as ClaudeTranscriptEntry;
    } catch {
      // Skip malformed lines, including a record Claude is still writing.
      continue;
    }
    if (typeof entry.sessionId === 'string' && entry.sessionId !== sessionId) continue;

    if (isUserPromptEntry(entry)) {
      current = {
        ...(typeof entry.timestamp === 'string' ? { startedAt: entry.timestamp } : {}),
        trigger: normalizeUserPrompt(promptText(entry)).kind,
        messages: []
      };
      turns.push(current);
      continue;
    }

    const messages = extractAssistantTextMessages([entry]);
    if (messages.length === 0) continue;
    if (!current) {
      current = { trigger: 'user', messages: [] };
      turns.push(current);
    }
    current.messages.push(...messages);
  }

  return turns;
}
