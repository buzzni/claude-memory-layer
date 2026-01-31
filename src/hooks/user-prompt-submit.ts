#!/usr/bin/env node
/**
 * User Prompt Submit Hook
 * Called when user submits a prompt - retrieves relevant memories
 */

import { getDefaultMemoryService } from '../services/memory-service.js';
import type { UserPromptSubmitInput, UserPromptSubmitOutput } from '../core/types.js';

async function main(): Promise<void> {
  // Read input from stdin
  const inputData = await readStdin();
  const input: UserPromptSubmitInput = JSON.parse(inputData);

  const memoryService = getDefaultMemoryService();

  try {
    // Retrieve relevant memories for the prompt
    const retrievalResult = await memoryService.retrieveMemories(input.prompt, {
      topK: 5,
      minScore: 0.7
    });

    // Store the user prompt for future retrieval
    await memoryService.storeUserPrompt(
      input.session_id,
      input.prompt
    );

    // Format context for Claude
    const context = memoryService.formatAsContext(retrievalResult);

    const output: UserPromptSubmitOutput = { context };
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
