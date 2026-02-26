#!/usr/bin/env node
/**
 * User Prompt Submit Hook
 * Called when user submits a prompt - retrieves relevant memories using fast keyword search
 *
 * Uses SQLite FTS5 for fast keyword-based search (no ML model needed)
 * Much faster than vector search (~100ms vs 3-5s)
 *
 * Turn Grouping: Generates a turn_id and persists it to a state file
 * so PostToolUse and Stop hooks can associate their events with this turn.
 */

import { randomUUID } from 'crypto';
import { getLightweightMemoryService } from '../services/memory-service.js';
import { writeTurnState } from '../core/turn-state.js';
import type { UserPromptSubmitInput, UserPromptSubmitOutput } from '../core/types.js';

// Configuration
const MAX_MEMORIES = parseInt(process.env.CLAUDE_MEMORY_MAX_COUNT || '5');
// Tuned default for noise/recall balance on shopping_assistant-like corpus
const BASE_MIN_SCORE = parseFloat(process.env.CLAUDE_MEMORY_MIN_SCORE || '0.4');
const FALLBACK_MIN_SCORE = parseFloat(process.env.CLAUDE_MEMORY_FALLBACK_MIN_SCORE || '0.3');
const ENABLE_SEARCH = process.env.CLAUDE_MEMORY_SEARCH !== 'false';

/**
 * Determine if a prompt is worth storing as a memory.
 * Filters slash commands, very short inputs, and trivial patterns.
 */
function shouldStorePrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.startsWith('/')) return false;
  if (trimmed.length < 15) return false;
  if (!/[a-zA-Z가-힣]{2,}/.test(trimmed)) return false;
  return true;
}


function getDynamicMinScore(prompt: string): number {
  const len = prompt.trim().length;
  if (len <= 20) return Math.min(0.55, BASE_MIN_SCORE + 0.1);   // short query → stricter
  if (len >= 80) return Math.max(0.3, BASE_MIN_SCORE - 0.05);    // long query → slightly looser
  return BASE_MIN_SCORE;
}

async function main(): Promise<void> {
  // Read input from stdin
  const inputData = await readStdin();
  const input: UserPromptSubmitInput = JSON.parse(inputData);

  // Generate a new turn_id for this user prompt
  // This groups the prompt with subsequent tool calls and the final agent response
  const turnId = randomUUID();

  // Persist turn state so PostToolUse and Stop hooks can read it
  writeTurnState(input.session_id, turnId);

  // Use lightweight service (SQLite only, no embedder/vector - FAST!)
  const memoryService = getLightweightMemoryService(input.session_id);

  try {
    // Store only non-trivial prompts (skip /commands, short inputs)
    if (shouldStorePrompt(input.prompt)) {
      await memoryService.storeUserPrompt(
        input.session_id,
        input.prompt,
        { turnId }
      );
    }

    let context = '';

    // Fast keyword search if enabled
    if (ENABLE_SEARCH && input.prompt.length > 10) {
      const minScore = getDynamicMinScore(input.prompt);
      let results = await memoryService.keywordSearch(input.prompt, {
        topK: MAX_MEMORIES,
        minScore
      });

      // recall rescue: if nothing found at tuned threshold, retry with fallback floor
      if (results.length === 0 && FALLBACK_MIN_SCORE < minScore) {
        results = await memoryService.keywordSearch(input.prompt, {
          topK: MAX_MEMORIES,
          minScore: FALLBACK_MIN_SCORE
        });
      }

      if (results.length > 0) {
        // Increment access count for found memories
        const eventIds = results.map(r => r.event.id);
        await memoryService.incrementMemoryAccess(eventIds);

        // Record each retrieval for helpfulness tracking
        for (const r of results) {
          try {
            await memoryService.recordRetrieval(
              r.event.id,
              input.session_id,
              r.score,
              input.prompt
            );
          } catch { /* non-critical */ }
        }

        // Format context
        const memories = results.map(r => {
          const preview = r.event.content.length > 300
            ? r.event.content.substring(0, 300) + '...'
            : r.event.content;
          return `- [${r.event.eventType}] ${preview}`;
        });

        context = `💡 **Related memories found:**\n\n${memories.join('\n\n')}`;
      }
    }

    const output: UserPromptSubmitOutput = { context };
    console.log(JSON.stringify(output));
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Memory hook error:', error);
    }
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
