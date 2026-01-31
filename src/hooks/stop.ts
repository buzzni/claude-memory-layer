#!/usr/bin/env node
/**
 * Stop Hook
 * Called when agent stops - stores the conversation messages
 */

import { getDefaultMemoryService } from '../services/memory-service.js';
import type { StopInput } from '../core/types.js';

async function main(): Promise<void> {
  // Read input from stdin
  const inputData = await readStdin();
  const input: StopInput = JSON.parse(inputData);

  const memoryService = getDefaultMemoryService();

  try {
    // Store agent responses from the conversation
    for (const message of input.messages) {
      if (message.role === 'assistant' && message.content) {
        // Truncate very long responses
        const content = message.content.length > 5000
          ? message.content.slice(0, 5000) + '...[truncated]'
          : message.content;

        await memoryService.storeAgentResponse(
          input.session_id,
          content,
          { stopReason: input.stop_reason }
        );
      }
    }

    // Process embeddings immediately
    await memoryService.processPendingEmbeddings();

    // Output empty (stop hook doesn't return context)
    console.log(JSON.stringify({}));
  } catch (error) {
    console.error('Memory hook error:', error);
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
