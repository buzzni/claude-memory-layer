#!/usr/bin/env node
/**
 * Session End Hook
 * Called when session ends - generates and stores session summary
 */

import { getDefaultMemoryService } from '../services/memory-service.js';
import type { SessionEndInput } from '../core/types.js';

async function main(): Promise<void> {
  // Read input from stdin
  const inputData = await readStdin();
  const input: SessionEndInput = JSON.parse(inputData);

  const memoryService = getDefaultMemoryService();

  try {
    // Get session history
    const sessionEvents = await memoryService.getSessionHistory(input.session_id);

    if (sessionEvents.length > 0) {
      // Generate a simple session summary
      const summary = generateSummary(sessionEvents);

      // Store session summary
      await memoryService.storeSessionSummary(input.session_id, summary);

      // End session with summary
      await memoryService.endSession(input.session_id, summary);

      // Process any pending embeddings
      await memoryService.processPendingEmbeddings();
    }

    console.log(JSON.stringify({}));
  } catch (error) {
    console.error('Memory hook error:', error);
    console.log(JSON.stringify({}));
  }
}

/**
 * Generate a simple session summary from events
 */
function generateSummary(events: Array<{ eventType: string; content: string }>): string {
  const userPrompts = events.filter(e => e.eventType === 'user_prompt');
  const responses = events.filter(e => e.eventType === 'agent_response');

  const parts: string[] = [];

  parts.push(`Session with ${userPrompts.length} user prompts and ${responses.length} responses.`);

  // Add first few user prompts as topics
  if (userPrompts.length > 0) {
    parts.push('Topics discussed:');
    for (const prompt of userPrompts.slice(0, 3)) {
      const topic = prompt.content.slice(0, 100).replace(/\n/g, ' ');
      parts.push(`- ${topic}${prompt.content.length > 100 ? '...' : ''}`);
    }
  }

  return parts.join('\n');
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
