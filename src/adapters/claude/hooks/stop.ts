/**
 * Stop Hook
 * Called when agent stops - reads transcript and stores assistant responses
 *
 * Actual Claude Code input format:
 * {
 *   session_id, transcript_path, cwd, permission_mode,
 *   hook_event_name: "Stop", stop_hook_active
 * }
 *
 * NOTE: Claude Code does NOT send messages in the Stop hook.
 * We read them from the transcript JSONL file instead.
 */

import { getLightweightMemoryServiceForProject } from '../../../services/memory-service.js';
import { applyPrivacyFilter } from '../../../core/privacy/index.js';
import { readTurnStateDetails, clearTurnState, writeLastAssistantSnippet } from '../../../core/turn-state.js';
import type { StopInput, Config } from '../../../core/types.js';
import { readUnprocessedAssistantMessages } from '../transcript/stop-transcript-cursor.js';
import { readStdin, readNumberEnv } from './hook-runtime.js';
import { scheduleSessionSummary } from './semantic-daemon-client.js';
import { isLlmSummaryEnabled } from '../../llm/session-summary-llm.js';

// Default privacy config
const DEFAULT_PRIVACY_CONFIG: Config['privacy'] = {
  excludePatterns: ['password', 'secret', 'api_key', 'token', 'bearer'],
  anonymize: false,
  privateTags: {
    enabled: true,
    marker: '[PRIVATE]',
    preserveLineCount: false,
    supportedFormats: ['xml']
  }
};

export async function main(): Promise<string> {
  try {
    // Read input from stdin (parse inside try so malformed JSON still emits a safe envelope)
    const input: StopInput = JSON.parse(await readStdin());

    // Use lightweight service (SQLite only, no embedder/vector - FAST!)
    // Stop has an explicit cwd; do not let a missing or stale session registry
    // redirect canonical writes to the global or another project store.
    const memoryService = getLightweightMemoryServiceForProject(input.cwd);

    // Read current turn_id from state file
    const turnState = readTurnStateDetails(input.session_id);
    const turnId = turnState?.turnId ?? null;
    // Responses to automated notifications carry their trigger so they are not
    // read as the answer to the previous real request.
    const turnTrigger = turnState?.turnTrigger;

    // Read the assistant messages appended since this session's previous Stop
    const transcriptBatch = readUnprocessedAssistantMessages(input.session_id, input.transcript_path);
    const assistantMessages = transcriptBatch.messages;

    const MIN_AGENT_RESPONSE_LEN = readNumberEnv('CLAUDE_MEMORY_AGENT_RESPONSE_MIN_LEN', 150, { integer: true, min: 0 });
    const lastIdx = assistantMessages.length - 1;
    let allStored = true;

    // Store each assistant response
    for (let i = 0; i < assistantMessages.length; i++) {
      const { text, timestamp } = assistantMessages[i];
      const isLast = i === lastIdx;

      // Apply privacy filter
      const filterResult = applyPrivacyFilter(text, DEFAULT_PRIVACY_CONFIG);
      let content = filterResult.content;

      // Truncate very long responses
      if (content.length > 5000) {
        content = content.slice(0, 5000) + '...[truncated]';
      }

      // Skip very short responses (likely just tool calls or transition messages)
      // Always store the last message (may be the final answer)
      if (!isLast && content.trim().length < MIN_AGENT_RESPONSE_LEN) continue;

      const stored = await memoryService.storeAgentResponse(
        input.session_id,
        content,
        {
          privacy: filterResult.metadata,
          // Every message of the turn is stored now, at Stop; keep when each
          // was written, the same way the transcript importers record it.
          ...(timestamp ? { originalTimestamp: timestamp } : {}),
          ...(turnId ? { turnId } : {}),
          ...(turnTrigger ? { turnTrigger } : {})
        }
      );
      if (!stored.success) allStored = false;
    }
    // A failed store keeps the cursor where it was so the next Stop retries it.
    if (allStored) transcriptBatch.commit();

    // Save last assistant response snippet for next-turn retrieval context
    // enrichment. A reply to an automated notification is not what the next
    // human prompt follows up on, so it keeps the previous user turn's snippet
    // (adherence lastPrompt is preserved the same way).
    const isAutomatedTurn = turnTrigger !== undefined && turnTrigger !== 'user';
    if (assistantMessages.length > 0 && !isAutomatedTurn) {
      const lastMessage = assistantMessages[assistantMessages.length - 1].text;
      writeLastAssistantSnippet(input.session_id, lastMessage);
    }

    // Clean up turn state file after processing; keep it while a message
    // awaits retry so the retrying Stop stores it under the same turn.
    if (allStored) clearTurnState(input.session_id);

    // Evaluate helpfulness of retrieved memories for this session
    try {
      await memoryService.evaluateSessionHelpfulness(input.session_id);
    } catch {
      // non-critical
    }

    // Session summary. The LLM path produces the decisions/failures/constraints
    // a later session can actually reuse, but it is far too slow to run here, so
    // the daemon is asked to build it in the background. A failed or skipped
    // summary leaves the session without one, which keeps it eligible for the
    // session-start backfill to retry. There is deliberately no rule-based
    // fallback: that text grounds at 0.9% and is what this path replaces.
    try {
      if (isLlmSummaryEnabled()) {
        await scheduleSessionSummary(input.session_id);
      } else {
        await memoryService.generateSessionSummary(input.session_id);
      }
    } catch {
      // non-critical
    }

    // Embeddings enqueued in SQLite - will be processed by vector worker when server runs
    await memoryService.processPendingEmbeddings();

    // Output empty (stop hook doesn't return context)
    return JSON.stringify({});
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Stop hook error:', error);
    }
    return JSON.stringify({});
  }
}
