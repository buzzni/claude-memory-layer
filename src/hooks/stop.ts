#!/usr/bin/env node
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

import * as fs from 'fs';
import * as readline from 'readline';
import { getLightweightMemoryService } from '../services/memory-service.js';
import { applyPrivacyFilter } from '../core/privacy/index.js';
import { readTurnState, clearTurnState } from '../core/turn-state.js';
import type { StopInput, Config } from '../core/types.js';

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

/**
 * Extract assistant text messages from transcript JSONL.
 * Only reads the last N lines to avoid processing entire transcript.
 */
async function extractAssistantMessages(transcriptPath: string): Promise<string[]> {
  if (!fs.existsSync(transcriptPath)) return [];

  const messages: string[] = [];

  // Read last portion of file (last ~200KB should cover recent messages)
  const stats = fs.statSync(transcriptPath);
  const readStart = Math.max(0, stats.size - 200 * 1024);

  const stream = fs.createReadStream(transcriptPath, {
    start: readStart,
    encoding: 'utf8'
  });

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    try {
      const entry = JSON.parse(line);

      // Only process assistant messages with text content
      if (entry.type !== 'assistant') continue;

      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;

      // Extract text blocks from content array
      const textParts = content
        .filter((c: { type: string }) => c.type === 'text')
        .map((c: { text: string }) => c.text)
        .filter(Boolean);

      if (textParts.length > 0) {
        messages.push(textParts.join('\n'));
      }
    } catch {
      // Skip malformed lines (e.g., partial first line from readStart offset)
    }
  }

  return messages;
}

async function main(): Promise<void> {
  // Read input from stdin
  const inputData = await readStdin();
  const input: StopInput = JSON.parse(inputData);

  // Use lightweight service (SQLite only, no embedder/vector - FAST!)
  const memoryService = getLightweightMemoryService(input.session_id);

  try {
    // Read current turn_id from state file
    const turnId = readTurnState(input.session_id);

    // Read assistant messages from transcript
    const assistantMessages = await extractAssistantMessages(input.transcript_path);

    // Store each assistant response
    for (const text of assistantMessages) {
      // Apply privacy filter
      const filterResult = applyPrivacyFilter(text, DEFAULT_PRIVACY_CONFIG);
      let content = filterResult.content;

      // Truncate very long responses
      if (content.length > 5000) {
        content = content.slice(0, 5000) + '...[truncated]';
      }

      // Skip very short responses (likely just tool calls)
      if (content.trim().length < 10) continue;

      await memoryService.storeAgentResponse(
        input.session_id,
        content,
        {
          privacy: filterResult.metadata,
          ...(turnId ? { turnId } : {})
        }
      );
    }

    // Clean up turn state file after processing
    clearTurnState(input.session_id);

    // Embeddings enqueued in SQLite - will be processed by vector worker when server runs
    await memoryService.processPendingEmbeddings();

    // Output empty (stop hook doesn't return context)
    console.log(JSON.stringify({}));
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Stop hook error:', error);
    }
    console.log(JSON.stringify({}));
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}

main().catch(console.error);
