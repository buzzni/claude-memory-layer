/**
 * Chat API
 * Endpoints for memory-aware chat using Claude CLI
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { getLightweightServiceFromQuery, getServiceFromQuery, jsonError } from './utils.js';

export const chatRouter = new Hono();

interface ChatRequest {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  mode?: 'assistant' | 'memory-only';
  memoryOnly?: boolean;
}

type SseStream = { writeSSE: (msg: { event?: string; data: string }) => Promise<void> };

interface MemoryHit {
  event: {
    eventType?: string;
    timestamp?: Date | string;
    content?: string;
  };
  score: number;
  sessionContext?: string;
}

class ProviderFailure extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ProviderFailure';
  }
}

const CLAUDE_TIMEOUT_MS = 120_000;

chatRouter.post('/', async (c) => {
  let body: ChatRequest;
  try {
    body = await c.req.json<ChatRequest>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.message?.trim()) {
    return c.json({ error: 'Message is required' }, 400);
  }

  const memoryOnly = body.mode === 'memory-only' || body.memoryOnly === true;
  const memoryService = memoryOnly ? getLightweightServiceFromQuery(c) : getServiceFromQuery(c);

  try {
    await memoryService.initialize();

    const { memoryContext, memoryHits } = await collectMemoryContext(memoryService, body.message);
    const statsContext = await collectStatsContext(memoryService);

    const fullPrompt = buildPrompt(
      statsContext,
      memoryContext,
      body.history || [],
      body.message
    );

    // Stream response via SSE
    return streamSSE(c, async (stream) => {
      if (memoryOnly) {
        await streamMemoryOnlyResponse(stream, {
          memoryContext,
          memoryHits,
          reason: 'memory-only-mode'
        });
        return;
      }

      try {
        await streamClaudeResponse(fullPrompt, stream);
      } catch (err) {
        const diagnostic = providerDiagnostic(err);
        await stream.writeSSE({
          event: 'provider_error',
          data: JSON.stringify(diagnostic)
        });
        await streamMemoryOnlyFallback(stream, memoryContext, memoryHits);
      }
    });
  } catch (error) {
    return jsonError(c, error);
  } finally {
    await memoryService.shutdown();
  }
});

async function collectMemoryContext(
  memoryService: {
    retrieveMemories?: (query: string, options?: { topK?: number; minScore?: number }) => Promise<{ memories?: MemoryHit[] }>;
    keywordSearch?: (query: string, options?: { topK?: number; minScore?: number }) => Promise<MemoryHit[]>;
  },
  query: string
): Promise<{ memoryContext: string; memoryHits: MemoryHit[] }> {
  let memoryHits: MemoryHit[] = [];

  try {
    const result = await memoryService.retrieveMemories?.(query, {
      topK: 8,
      minScore: 0.5
    });
    memoryHits = result?.memories ?? [];
  } catch {
    memoryHits = [];
  }

  if (memoryHits.length === 0) {
    try {
      memoryHits = await memoryService.keywordSearch?.(query, { topK: 8, minScore: 0.05 }) ?? [];
    } catch {
      memoryHits = [];
    }
  }

  return {
    memoryContext: formatMemoryContext(memoryHits),
    memoryHits
  };
}

async function collectStatsContext(memoryService: {
  getStats?: () => Promise<{ totalEvents: number; vectorCount: number; levelStats: Array<{ level: string; count: number }> }>;
}): Promise<string> {
  try {
    const stats = await memoryService.getStats?.();
    if (!stats) return '';
    const levels = stats.levelStats.map(l => `${l.level}: ${l.count}`).join(', ');
    return [
      '## Memory Stats',
      `- Total events: ${stats.totalEvents}`,
      `- Vector nodes: ${stats.vectorCount}`,
      `- By level: ${levels}`
    ].join('\n');
  } catch {
    return '';
  }
}

function formatMemoryContext(memoryHits: MemoryHit[]): string {
  if (memoryHits.length === 0) return '';

  const parts: string[] = ['## Relevant Memories\n'];
  for (const m of memoryHits) {
    const date = m.event.timestamp ? new Date(m.event.timestamp).toISOString().split('T')[0] : 'unknown-date';
    const content = (m.event.content ?? '').slice(0, 500);
    parts.push(`### [${m.event.eventType ?? 'memory'}] ${date} (score: ${m.score.toFixed(2)})`);
    parts.push(content);
    if (m.sessionContext) {
      parts.push(`_Context: ${m.sessionContext}_`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

async function streamMemoryOnlyResponse(
  stream: SseStream,
  options: { memoryContext: string; memoryHits: MemoryHit[]; reason: string }
): Promise<void> {
  await stream.writeSSE({
    event: 'diagnostic',
    data: JSON.stringify({
      provider: 'claude-cli',
      status: 'skipped',
      mode: 'memory-only',
      reason: options.reason,
      retrievedMemories: options.memoryHits.length
    })
  });
  await streamMemoryOnlyFallback(stream, options.memoryContext, options.memoryHits);
}

async function streamMemoryOnlyFallback(
  stream: SseStream,
  memoryContext: string,
  memoryHits: MemoryHit[]
): Promise<void> {
  const content = memoryHits.length > 0
    ? [
        'Provider unavailable or skipped; showing retrieved memory context directly.',
        '',
        memoryContext
      ].join('\n')
    : 'Provider unavailable or skipped, and no directly relevant memories were found for this query.';

  await stream.writeSSE({
    event: 'message',
    data: JSON.stringify({ content, mode: 'memory-only' })
  });
  await stream.writeSSE({ event: 'done', data: '{}' });
}

function providerDiagnostic(err: unknown): { provider: string; code: string; message: string; fallback: string } {
  if (err instanceof ProviderFailure) {
    return {
      provider: 'claude-cli',
      code: err.code,
      message: err.message,
      fallback: 'memory-only'
    };
  }

  return {
    provider: 'claude-cli',
    code: 'claude-cli-error',
    message: err instanceof Error ? err.message : 'Unknown Claude CLI failure',
    fallback: 'memory-only'
  };
}

function classifyProviderFailure(message: string): ProviderFailure {
  const normalized = message.toLowerCase();
  if (normalized.includes('401') || normalized.includes('unauthorized') || normalized.includes('auth')) {
    return new ProviderFailure('claude-cli-auth', 'Claude CLI authentication failed; showing memory-only context.');
  }
  if (normalized.includes('not found') || normalized.includes('enoent')) {
    return new ProviderFailure('claude-cli-not-found', 'Claude CLI was not found; showing memory-only context.');
  }
  if (normalized.includes('timed out')) {
    return new ProviderFailure('claude-cli-timeout', 'Claude CLI timed out; showing memory-only context.');
  }
  return new ProviderFailure('claude-cli-error', 'Claude CLI failed; showing memory-only context.');
}

function buildPrompt(
  statsContext: string,
  memoryContext: string,
  history: Array<{ role: string; content: string }>,
  currentMessage: string
): string {
  const parts: string[] = [];

  parts.push('You are a helpful assistant that answers questions about the user\'s code memory data.');
  parts.push('The memory system tracks coding sessions, tool usage, prompts, and responses.');
  parts.push('Answer concisely based on the memory context below. If you don\'t have enough data, say so.');
  parts.push('Use markdown formatting in your responses.\n');

  if (statsContext) {
    parts.push(statsContext);
    parts.push('');
  }

  if (memoryContext) {
    parts.push(memoryContext);
  } else {
    parts.push('No directly relevant memories found for this query.');
    parts.push('Answer based on general knowledge or suggest the user rephrase.\n');
  }

  parts.push('---\n');

  // Include recent history (last 10 turns)
  const recentHistory = history.slice(-10);
  if (recentHistory.length > 0) {
    parts.push('## Conversation History\n');
    for (const msg of recentHistory) {
      const prefix = msg.role === 'user' ? 'User' : 'Assistant';
      parts.push(`**${prefix}:** ${msg.content}\n`);
    }
  }

  parts.push(`**User:** ${currentMessage}`);

  return parts.join('\n');
}

function streamClaudeResponse(
  prompt: string,
  stream: { writeSSE: (msg: { event?: string; data: string }) => Promise<void> }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc: ChildProcess = spawn('claude', [
      '-p',
      '--output-format', 'stream-json',
      '--verbose'
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(classifyProviderFailure('timed out'));
    }, CLAUDE_TIMEOUT_MS);

    // Write prompt to stdin
    proc.stdin!.write(prompt);
    proc.stdin!.end();

    let buffer = '';
    let lastSentText = '';
    let stderrText = '';

    proc.stdout!.on('data', async (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);

          // Extract text from assistant messages
          if (parsed.type === 'assistant' && parsed.message?.content) {
            const textBlocks = parsed.message.content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { text: string }) => b.text)
              .join('');

            if (textBlocks.length > lastSentText.length) {
              const delta = textBlocks.slice(lastSentText.length);
              lastSentText = textBlocks;
              await stream.writeSSE({
                event: 'message',
                data: JSON.stringify({ content: delta })
              });
            }
          }

          // Handle completion
          if (parsed.type === 'result') {
            await stream.writeSSE({ event: 'done', data: '{}' });
          }
        } catch {
          // Skip non-JSON lines
        }
      }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString();
      if (process.env.CLAUDE_MEMORY_DEBUG) {
        console.error('[chat] claude stderr:', chunk.toString());
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(classifyProviderFailure('ENOENT not found'));
      } else {
        reject(err);
      }
    });

    proc.on('close', async (code) => {
      clearTimeout(timeout);

      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer);
          if (parsed.type === 'result') {
            await stream.writeSSE({ event: 'done', data: '{}' });
          }
        } catch { /* ignore */ }
      }

      if (code !== 0 && code !== null) {
        reject(classifyProviderFailure(stderrText || `Claude CLI exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}
