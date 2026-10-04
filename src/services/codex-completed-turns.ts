import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface CodexCompletedTurn {
  turnId: string;
  cwd: string;
  userMessages: string[];
  assistantResponse: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CodexCompletedTurns {
  sessionId: string;
  cwd: string;
  turns: CodexCompletedTurn[];
}

export interface CodexCompletedTurnsOptions {
  sessionId: string;
  /** Provider-acknowledged completed turn; later records are never imported. */
  throughTurnId: string;
}

export type CodexCompletedTurnErrorReason = 'session_mismatch' | 'invalid_transcript' | 'incomplete_turn';

/** Classifications contain no transcript path or content. */
export class CodexCompletedTurnError extends Error {
  constructor(readonly reason: CodexCompletedTurnErrorReason) {
    super(reason);
    this.name = 'CodexCompletedTurnError';
  }
}

interface PendingTurn extends CodexCompletedTurn {
  invalid: boolean;
  finalMessages: string[];
  unphasedMessages: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function timestamp(value: unknown, fallback: unknown): string | null {
  for (const candidate of [value, fallback]) {
    if (typeof candidate !== 'string' && typeof candidate !== 'number') continue;
    // Codex variants emit Unix seconds or milliseconds; record.timestamp is ISO.
    const date = new Date(typeof candidate === 'number' && Math.abs(candidate) < 100_000_000_000
      ? candidate * 1000 : candidate);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}

function messageText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    const item = record(block);
    if (!item || typeof item.type !== 'string') return null;
    if (['input_text', 'output_text', 'text'].includes(item.type)) {
      if (typeof item.text !== 'string') return null;
      texts.push(item.text);
    }
  }
  return texts.join('\n');
}

/** One coherent frame at a time; copied fork history need not contain starts. */
class CompletedTurnReader {
  private meta: { sessionId: string; cwd: string } | null = null;
  private pending: PendingTurn | null = null;
  private readonly turns: CodexCompletedTurn[] = [];
  private readonly completedIds = new Set<string>();
  private reachedTarget = false;
  private lineIndex = -1;
  private ownHistoryStart: number | null = null;
  private copiedFromId: string | null = null;

  constructor(private readonly options: CodexCompletedTurnsOptions) {
    if (!nonempty(options.sessionId) || !nonempty(options.throughTurnId)) {
      throw new CodexCompletedTurnError('invalid_transcript');
    }
  }

  /** True stops the file reader immediately after the acknowledged completion. */
  consume(line: string): boolean {
    if (this.reachedTarget) return true;
    this.lineIndex++;
    if (!line.trim()) {
      // The verified fork ordinal addresses canonical one-record-per-line
      // history. An altered prefix cannot establish that boundary safely.
      if (this.ownHistoryStart !== null && this.lineIndex < this.ownHistoryStart) {
        throw new CodexCompletedTurnError('invalid_transcript');
      }
      return false;
    }
    let entry: Record<string, unknown> | null;
    try { entry = record(JSON.parse(line)); }
    catch {
      if (this.ownHistoryStart !== null && this.lineIndex < this.ownHistoryStart) {
        throw new CodexCompletedTurnError('invalid_transcript');
      }
      // Never persist a partially decoded turn as complete evidence.
      if (this.pending) this.pending.invalid = true;
      return false;
    }
    const payload = record(entry?.payload);
    if (!entry || !payload) {
      if (this.ownHistoryStart !== null && this.lineIndex < this.ownHistoryStart) {
        throw new CodexCompletedTurnError('invalid_transcript');
      }
      if (this.pending) this.pending.invalid = true;
      return false;
    }

    // Codex sub-agent forks prepend their own meta to an inherited parent
    // prefix. The explicit ordinal identifies the start of their own records;
    // without one, a fork cannot safely distinguish inherited completed turns.
    if (this.ownHistoryStart !== null && this.lineIndex < this.ownHistoryStart) {
      if (entry.type === 'session_meta' && payload.id !== this.copiedFromId) {
        throw new CodexCompletedTurnError('invalid_transcript');
      }
      return false;
    }

    if (entry.type === 'session_meta') {
      const sessionId = nonempty(payload.id);
      const cwd = nonempty(payload.cwd);
      if (sessionId !== this.options.sessionId) throw new CodexCompletedTurnError('session_mismatch');
      if (!cwd || (this.meta && this.meta.cwd !== cwd)) throw new CodexCompletedTurnError('invalid_transcript');
      const copiedFromId = nonempty(payload.forked_from_id);
      if (copiedFromId && !this.meta) {
        const ownStart = payload.subagent_history_start_ordinal;
        if (payload.thread_source !== 'subagent' || payload.parent_thread_id !== copiedFromId
          || !Number.isSafeInteger(ownStart) || (ownStart as number) < 2) {
          throw new CodexCompletedTurnError('invalid_transcript');
        }
        this.ownHistoryStart = ownStart as number;
        this.copiedFromId = copiedFromId;
      }
      this.meta = { sessionId, cwd };
      return false;
    }
    // A caller may never reconstruct an unbound transcript's leading messages.
    if (!this.meta) return false;

    if (entry.type === 'event_msg' && payload.type === 'task_started') {
      const turnId = nonempty(payload.turn_id);
      this.pending = turnId ? {
        turnId, cwd: this.meta.cwd, userMessages: [], assistantResponse: '',
        startedAt: timestamp(payload.started_at, entry.timestamp), completedAt: null,
        invalid: false, finalMessages: [], unphasedMessages: []
      } : null;
      return false;
    }
    if (entry.type === 'event_msg' && payload.type === 'turn_aborted') {
      if (!payload.turn_id || payload.turn_id === this.pending?.turnId) this.pending = null;
      return false;
    }
    if (entry.type === 'event_msg' && payload.type === 'task_complete') {
      const turnId = nonempty(payload.turn_id);
      const pending = this.pending;
      if (!pending || pending.turnId !== turnId || pending.invalid) {
        if (turnId === this.options.throughTurnId) throw new CodexCompletedTurnError('incomplete_turn');
        return false;
      }
      const finalText = pending.finalMessages.length > 0
        ? pending.finalMessages.join('\n\n')
        : nonempty(payload.last_agent_message) ?? pending.unphasedMessages.join('\n\n');
      if (!this.completedIds.has(pending.turnId)) {
        this.turns.push({
          turnId: pending.turnId, cwd: pending.cwd, userMessages: pending.userMessages,
          assistantResponse: finalText,
          startedAt: pending.startedAt, completedAt: timestamp(payload.completed_at, entry.timestamp)
        });
        this.completedIds.add(pending.turnId);
      }
      this.pending = null;
      this.reachedTarget = turnId === this.options.throughTurnId;
      return this.reachedTarget;
    }
    if (!this.pending) return false;
    if (entry.type === 'turn_context' && payload.turn_id === this.pending.turnId) {
      const cwd = nonempty(payload.cwd);
      if (!cwd) this.pending.invalid = true;
      else this.pending.cwd = cwd;
      return false;
    }
    if (entry.type !== 'response_item' || payload.type !== 'message') return false;
    if (payload.role !== 'user' && payload.role !== 'assistant') return false;
    const text = messageText(payload.content);
    if (text === null) { this.pending.invalid = true; return false; }
    if (!text.trim()) return false;
    if (payload.role === 'user') this.pending.userMessages.push(text);
    else if (payload.role === 'assistant') {
      if (payload.phase === 'final_answer') this.pending.finalMessages.push(text);
      else if (payload.phase === undefined || payload.phase === null) this.pending.unphasedMessages.push(text);
    }
    return false;
  }

  result(): CodexCompletedTurns {
    if (!this.meta) throw new CodexCompletedTurnError('invalid_transcript');
    if (!this.reachedTarget) throw new CodexCompletedTurnError('incomplete_turn');
    return { sessionId: this.meta.sessionId, cwd: this.meta.cwd, turns: this.turns };
  }
}

/** Pure replay helper for fixtures and callers that already have decoded lines. */
export function parseCodexCompletedTurns(
  lines: Iterable<string>, options: CodexCompletedTurnsOptions
): CodexCompletedTurns {
  const reader = new CompletedTurnReader(options);
  for (const line of lines) if (reader.consume(line)) break;
  return reader.result();
}

/** Reads only through the provider's acknowledged turn, without retaining raw lines. */
export async function readCodexCompletedTurns(
  transcriptPath: string, options: CodexCompletedTurnsOptions
): Promise<CodexCompletedTurns> {
  const reader = new CompletedTurnReader(options);
  const stream = createReadStream(transcriptPath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (reader.consume(line)) break;
    return reader.result();
  } catch (error) {
    if (error instanceof CodexCompletedTurnError) throw error;
    throw new CodexCompletedTurnError('invalid_transcript');
  } finally {
    lines.close();
    stream.destroy();
  }
}
