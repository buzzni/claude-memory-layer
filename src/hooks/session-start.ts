#!/usr/bin/env node
/**
 * Session Start Hook
 * Called when a new Claude Code session starts
 */

import { getDefaultMemoryService } from '../services/memory-service.js';
import type { SessionStartInput, SessionStartOutput } from '../core/types.js';

async function main(): Promise<void> {
  // Read input from stdin
  const inputData = await readStdin();
  const input: SessionStartInput = JSON.parse(inputData);

  const memoryService = getDefaultMemoryService();

  try {
    // Start session in memory service
    await memoryService.startSession(input.session_id, input.cwd);

    // Get recent context for this project
    const recentEvents = await memoryService.getRecentEvents(10);
    const projectEvents = recentEvents.filter(e =>
      e.metadata?.projectPath === input.cwd
    );

    let context = '';
    if (projectEvents.length > 0) {
      context = `## Previous Session Context\n\nYou have worked on this project before. Here are some relevant memories:\n\n`;
      for (const event of projectEvents.slice(0, 3)) {
        const date = event.timestamp.toISOString().split('T')[0];
        context += `- **${date}**: ${event.content.slice(0, 150)}...\n`;
      }
    }

    const output: SessionStartOutput = { context };
    console.log(JSON.stringify(output));
  } catch (error) {
    console.error('Memory hook error:', error);
    console.log(JSON.stringify({ context: '' }));
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
