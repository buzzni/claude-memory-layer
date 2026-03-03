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
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLightweightMemoryService, getMemoryServiceForSession } from '../services/memory-service.js';
import { writeTurnState } from '../core/turn-state.js';
import type { UserPromptSubmitInput, UserPromptSubmitOutput } from '../core/types.js';

// Configuration
const MAX_MEMORIES = parseInt(process.env.CLAUDE_MEMORY_MAX_COUNT || '5');
// Tuned default for noise/recall balance on shopping_assistant-like corpus
const BASE_MIN_SCORE = parseFloat(process.env.CLAUDE_MEMORY_MIN_SCORE || '0.4');
const FALLBACK_MIN_SCORE = parseFloat(process.env.CLAUDE_MEMORY_FALLBACK_MIN_SCORE || '0.3');
const ENABLE_SEARCH = process.env.CLAUDE_MEMORY_SEARCH !== 'false';
const RETRIEVAL_MODE = (process.env.CLAUDE_MEMORY_RETRIEVAL_MODE || 'hybrid') as 'keyword' | 'semantic' | 'hybrid';
const SEMANTIC_TIMEOUT_MS = parseInt(process.env.CLAUDE_MEMORY_SEMANTIC_TIMEOUT_MS || '1200');
const ADHERENCE_INTERVAL_TURNS = parseInt(process.env.CLAUDE_MEMORY_ADHERENCE_INTERVAL_TURNS || '3');

const ADHERENCE_STATE_DIR = path.join(os.homedir(), '.claude-code', 'memory');

interface AdherenceState {
  sessionId: string;
  turnCount: number;
  lastCheckedTurn: number;
  lastPrompt: string;
  updatedAt: string;
}

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`semantic retrieval timeout (${timeoutMs}ms)`)), timeoutMs);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function formatMemoryContext(items: Array<{ type: string; content: string }>): string {
  if (items.length === 0) return '';
  const lines = items.map((m) => {
    const preview = m.content.length > 300 ? m.content.substring(0, 300) + '...' : m.content;
    return `- [${m.type}] ${preview}`;
  });
  return `💡 **Related memories found:**\n\n${lines.join('\n\n')}`;
}

function getAdherenceStatePath(sessionId: string): string {
  return path.join(ADHERENCE_STATE_DIR, `.adherence-state-${sessionId}.json`);
}

function readAdherenceState(sessionId: string): AdherenceState {
  try {
    const filePath = getAdherenceStatePath(sessionId);
    if (!fs.existsSync(filePath)) {
      return {
        sessionId,
        turnCount: 0,
        lastCheckedTurn: 0,
        lastPrompt: '',
        updatedAt: new Date().toISOString()
      };
    }

    const data = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(data) as AdherenceState;
    if (parsed.sessionId !== sessionId) throw new Error('session mismatch');
    return parsed;
  } catch {
    return {
      sessionId,
      turnCount: 0,
      lastCheckedTurn: 0,
      lastPrompt: '',
      updatedAt: new Date().toISOString()
    };
  }
}

function writeAdherenceState(state: AdherenceState): void {
  try {
    if (!fs.existsSync(ADHERENCE_STATE_DIR)) {
      fs.mkdirSync(ADHERENCE_STATE_DIR, { recursive: true });
    }
    const filePath = getAdherenceStatePath(state.sessionId);
    const tempPath = filePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(state));
    fs.renameSync(tempPath, filePath);
  } catch {
    // non-critical
  }
}

function hasWriteIntent(prompt: string): boolean {
  return /(fix|refactor|implement|change|modify|edit|update|rewrite|patch|create|add|remove|delete|버그|수정|리팩터|구현|추가|삭제|개선)/i.test(prompt);
}

function tokenize(text: string): string[] {
  const stopwords = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'what', 'when', 'where', 'how', 'why', '그리고', '그리고요', '이거', '그거', '해주세요', '해줘', '좀', '에서', '으로', '하는', '해']);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !stopwords.has(w));
}

function isTopicShift(currentPrompt: string, lastPrompt: string): boolean {
  if (!lastPrompt || lastPrompt.length < 10) return false;
  const a = new Set(tokenize(currentPrompt));
  const b = new Set(tokenize(lastPrompt));
  if (a.size === 0 || b.size === 0) return false;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  const similarity = union > 0 ? intersection / union : 0;
  return similarity < 0.2;
}

function shouldRunAdherenceCheck(turnCount: number, prompt: string, state: AdherenceState): { run: boolean; reason: string } {
  if (turnCount === 1) return { run: true, reason: 'first-turn' };
  if (hasWriteIntent(prompt)) return { run: true, reason: 'write-intent' };
  if (isTopicShift(prompt, state.lastPrompt)) return { run: true, reason: 'topic-shift' };
  if (turnCount - state.lastCheckedTurn >= ADHERENCE_INTERVAL_TURNS) return { run: true, reason: 'interval' };
  return { run: false, reason: 'skip' };
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

    const adherenceState = readAdherenceState(input.session_id);
    const currentTurn = adherenceState.turnCount + 1;
    const adherenceDecision = shouldRunAdherenceCheck(currentTurn, input.prompt, adherenceState);

    // Search strategy: turn-1 always enforce adherence check,
    // then adaptively enforce on write-intent/topic-shift/interval
    if (ENABLE_SEARCH && input.prompt.length > 10 && adherenceDecision.run) {
      const minScore = getDynamicMinScore(input.prompt);
      let mergedMemories: Array<{ type: string; content: string; id?: string; score?: number }> = [];

      const canUseSemantic = RETRIEVAL_MODE === 'semantic' || RETRIEVAL_MODE === 'hybrid';
      if (canUseSemantic) {
        try {
          const semanticService = getMemoryServiceForSession(input.session_id);
          const semantic = await withTimeout(
            semanticService.retrieveMemories(input.prompt, {
              topK: MAX_MEMORIES,
              minScore,
              sessionId: input.session_id,
              intentRewrite: true,
              adaptiveRerank: true,
              projectScopeMode: 'strict'
            }),
            SEMANTIC_TIMEOUT_MS
          );

          mergedMemories = semantic.memories.map((m) => ({
            type: m.event.eventType,
            content: m.event.content,
            id: m.event.id,
            score: m.score
          }));
        } catch {
          // Semantic retrieval is best-effort; fallback below handles the rest
        }
      }

      const shouldUseKeywordFallback =
        RETRIEVAL_MODE === 'keyword' ||
        RETRIEVAL_MODE === 'hybrid' ||
        mergedMemories.length === 0;

      if (shouldUseKeywordFallback && mergedMemories.length < MAX_MEMORIES) {
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

        const existingIds = new Set(mergedMemories.map((m) => m.id).filter(Boolean));
        for (const r of results) {
          if (existingIds.has(r.event.id)) continue;
          mergedMemories.push({
            type: r.event.eventType,
            content: r.event.content,
            id: r.event.id,
            score: r.score
          });
          if (mergedMemories.length >= MAX_MEMORIES) break;
        }
      }

      if (mergedMemories.length > 0) {
        // Increment access count for found memories
        const eventIds = mergedMemories.map((m) => m.id).filter((v): v is string => Boolean(v));
        if (eventIds.length > 0) {
          await memoryService.incrementMemoryAccess(eventIds);
        }

        // Record each retrieval for helpfulness tracking
        for (const m of mergedMemories) {
          if (!m.id) continue;
          try {
            await memoryService.recordRetrieval(
              m.id,
              input.session_id,
              m.score ?? minScore,
              input.prompt
            );
          } catch { /* non-critical */ }
        }

        context = formatMemoryContext(mergedMemories);
      }
    }

    writeAdherenceState({
      sessionId: input.session_id,
      turnCount: currentTurn,
      lastCheckedTurn: adherenceDecision.run ? currentTurn : adherenceState.lastCheckedTurn,
      lastPrompt: input.prompt,
      updatedAt: new Date().toISOString()
    });

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
