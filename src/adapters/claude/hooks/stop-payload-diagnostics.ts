/**
 * Stop payload diagnostics
 *
 * Measures whether Stop's transcript batch misses the reply Claude Code hands
 * the hook as `last_assistant_message` (the transcript is written
 * asynchronously, so the final reply can land after Stop reads it). Each Stop
 * appends one record to ~/.claude-code/memory/stop-payload-diagnostics.jsonl.
 * Records hold counts only — never message text or session ids.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type StopPayloadOutcome = 'no_payload' | 'in_batch' | 'missing_from_batch';

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function classifyStopPayloadMessage(
  payloadMessage: unknown,
  batch: ReadonlyArray<{ text: string }>
): StopPayloadOutcome {
  const payload = typeof payloadMessage === 'string' ? normalize(payloadMessage) : '';
  if (!payload) return 'no_payload';
  // The transcript can split one reply across entries, so search the whole batch.
  const joined = normalize(batch.map((message) => message.text).join(' '));
  return joined.includes(payload) ? 'in_batch' : 'missing_from_batch';
}

export function recordStopPayloadDiagnostic(
  payloadMessage: unknown,
  batch: ReadonlyArray<{ text: string }>
): void {
  try {
    const record = {
      version: 1,
      at: new Date().toISOString(),
      outcome: classifyStopPayloadMessage(payloadMessage, batch),
      batchMessages: batch.length,
      payloadChars: typeof payloadMessage === 'string' ? payloadMessage.length : 0
    };
    const dir = path.join(os.homedir(), '.claude-code', 'memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'stop-payload-diagnostics.jsonl'), `${JSON.stringify(record)}\n`);
  } catch {
    // Diagnostics must never affect Stop.
  }
}
