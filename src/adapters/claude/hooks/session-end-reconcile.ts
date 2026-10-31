/**
 * Session End Transcript Reconcile
 *
 * Stores the assistant messages of a finished session that Stop never stored.
 * Stop reads from a per-session cursor and still loses messages behind it: a
 * backlog larger than its read cap keeps only the newest bytes, and when the
 * first Stop of a session fails to store and a new prompt arrives, the next
 * Stop (still without a cursor) reads only its own turn. A turn the session
 * ends in without a Stop is never read at all.
 *
 * Every one of those losses lies before the cursor, so the whole transcript is
 * read again. Messages are normalized exactly as Stop normalizes them, so a
 * message Stop already stored has the same content (and dedupe key) and is
 * skipped; only the missing ones are stored.
 */

import type { AppendResult, MemoryEvent } from '../../../core/types.js';
import { readTurnStateDetails } from '../../../core/turn-state.js';
import { readTranscriptTurns } from '../transcript/transcript-turns.js';
import { isStorableAgentResponse, normalizeAgentResponse, readMinAgentResponseLength } from './agent-response-normalization.js';

export interface ReconcileMemoryService {
  getSessionHistory(sessionId: string): Promise<MemoryEvent[]>;
  storeAgentResponse(sessionId: string, content: string, metadata?: Record<string, unknown>): Promise<AppendResult>;
}

export interface SessionTranscriptReconcileResult {
  recovered: number;
  alreadyStored: number;
  failed: number;
}

interface TurnMark {
  at: number;
  turnId: string;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/** When each stored event of the session happened, for those that carry a turn. */
function turnMarks(events: MemoryEvent[]): TurnMark[] {
  const marks: TurnMark[] = [];
  for (const event of events) {
    const turnId = event.metadata?.turnId;
    if (typeof turnId !== 'string' || !turnId) continue;
    const at = parseTime(event.metadata?.originalTimestamp) ?? new Date(event.timestamp).getTime();
    if (!Number.isNaN(at)) marks.push({ at, turnId });
  }
  return marks.sort((a, b) => a.at - b.at);
}

/**
 * The turn a message belongs to is the one whose prompt, tool calls or stored
 * responses fall between its transcript turn's prompt and the next prompt:
 * the latest of them written up to the message, else the first after it.
 */
function turnIdAt(marks: TurnMark[], start: number, end: number, at: number): string | undefined {
  const inTurn = marks.filter((mark) => mark.at >= start && mark.at < end);
  return inTurn.filter((mark) => mark.at <= at).pop()?.turnId ?? inTurn[0]?.turnId;
}

export async function reconcileSessionTranscript(
  memoryService: ReconcileMemoryService,
  sessionId: string,
  transcriptPath: string
): Promise<SessionTranscriptReconcileResult> {
  const result: SessionTranscriptReconcileResult = { recovered: 0, alreadyStored: 0, failed: 0 };
  const turns = await readTranscriptTurns(transcriptPath, sessionId);
  if (!turns.some((turn) => turn.messages.length > 0)) return result;

  const events = await memoryService.getSessionHistory(sessionId);
  const storedContents = new Set(
    events.filter((event) => event.eventType === 'agent_response').map((event) => event.content)
  );
  const marks = turnMarks(events);
  const openTurn = readTurnStateDetails(sessionId);
  const minResponseLength = readMinAgentResponseLength();

  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t];
    const start = parseTime(turn.startedAt) ?? -Infinity;
    const end = parseTime(turns[t + 1]?.startedAt) ?? Infinity;
    const isLastTurn = t === turns.length - 1;

    for (let i = 0; i < turn.messages.length; i++) {
      const { text, timestamp } = turn.messages[i];
      // Stop runs once per turn, so its last-message exception is per turn here.
      const { content, privacy } = normalizeAgentResponse(text);
      if (!isStorableAgentResponse(content, i === turn.messages.length - 1, minResponseLength)) continue;
      if (storedContents.has(content)) {
        result.alreadyStored++;
        continue;
      }

      // The turn the session ended in may have left no event yet; its turn
      // state is still open because no successful Stop cleared it.
      const turnId = turnIdAt(marks, start, end, parseTime(timestamp) ?? end)
        ?? (isLastTurn ? openTurn?.turnId : undefined);
      const stored = await memoryService.storeAgentResponse(sessionId, content, {
        privacy,
        ...(timestamp ? { originalTimestamp: timestamp } : {}),
        ...(turnId ? { turnId } : {}),
        ...(turn.trigger !== 'user' ? { turnTrigger: turn.trigger } : {}),
        recoveredAtSessionEnd: true
      });
      if (!stored.success) {
        result.failed++;
        continue;
      }
      storedContents.add(content);
      if (stored.isDuplicate) result.alreadyStored++;
      else result.recovered++;
    }
  }

  return result;
}
