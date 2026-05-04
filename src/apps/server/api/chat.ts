/**
 * Chat API
 * Endpoints for memory-aware chat using Claude CLI
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { getServiceFromQuery } from './utils.js';

export const chatRouter = new Hono();

interface ChatRequest {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
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

  const memoryService = getServiceFromQuery(c);

  try {
    await memoryService.initialize();

    // Retrieve relevant memories for context
    let memoryContext = '';
    let statsContext = '';

    try {
      const result = await memoryService.retrieveMemories(body.message, {
        topK: 8,
        minScore: 0.5
      });

      if (result.memories.length > 0) {
        const parts: string[] = ['## Relevant Memories\n'];
        for (const m of result.memories) {
          const date = new Date(m.event.timestamp).toISOString().split('T')[0];
          const content = m.event.content.slice(0, 500);
          parts.push(`### [${m.event.eventType}] ${date} (score: ${m.score.toFixed(2)})`);
          parts.push(content);
          if (m.sessionContext) {
            parts.push(`_Context: ${m.sessionContext}_`);
          }
          parts.push('');
        }
        memoryContext = parts.join('\n');
      }
    } catch {
      // Continue without memory context if retrieval fails
    }

    try {
      const stats = await memoryService.getStats();
      const levels = stats.levelStats.map(l => `${l.level}: ${l.count}`).join(', ');
      statsContext = [
        '## Memory Stats',
        `- Total events: ${stats.totalEvents}`,
        `- Vector nodes: ${stats.vectorCount}`,
        `- By level: ${levels}`
      ].join('\n');
    } catch {
      // Continue without stats if it fails
    }

    const fullPrompt = buildPrompt(
      statsContext,
      memoryContext,
      body.history || [],
      body.message
    );

    // Stream response via SSE
    return streamSSE(c, async (stream) => {
      try {
        await streamClaudeResponse(fullPrompt, stream);
      } catch (err) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: (err as Error).message })
        });
      }
    });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  } finally {
    await memoryService.shutdown();
  }
});

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
      reject(new Error('Chat response timed out after 2 minutes'));
    }, CLAUDE_TIMEOUT_MS);

    // Write prompt to stdin
    proc.stdin!.write(prompt);
    proc.stdin!.end();

    let buffer = '';
    let lastSentText = '';

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
      if (process.env.CLAUDE_MEMORY_DEBUG) {
        console.error('[chat] claude stderr:', chunk.toString());
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code'));
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
        reject(new Error(`Claude CLI exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}
