/**
 * MCP Tool Handlers
 * Implementation of tool calls
 */

import { getDefaultMemoryService } from '../services/memory-service.js';
import { generateCitationId } from '../core/citation-generator.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const memoryService = getDefaultMemoryService();
    await memoryService.initialize();

    switch (name) {
      case 'mem-search':
        return await handleMemSearch(args);

      case 'mem-timeline':
        return await handleMemTimeline(args);

      case 'mem-details':
        return await handleMemDetails(args);

      case 'mem-stats':
        return await handleMemStats();

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true
        };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
      isError: true
    };
  }
}

async function handleMemSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const query = args.query as string;
  const topK = Math.min((args.topK as number) || 5, 20);

  const memoryService = getDefaultMemoryService();
  const result = await memoryService.retrieveMemories(query, {
    topK,
    sessionId: args.sessionId as string
  });

  const lines: string[] = [
    '## Memory Search Results',
    '',
    `Found ${result.memories.length} relevant memories:`,
    ''
  ];

  for (let i = 0; i < result.memories.length; i++) {
    const m = result.memories[i];
    const citationId = generateCitationId(m.event.id);
    const date = m.event.timestamp.toISOString().split('T')[0];
    const preview = m.event.content.slice(0, 100) + (m.event.content.length > 100 ? '...' : '');

    lines.push(`### ${i + 1}. [mem:${citationId}] (score: ${m.score.toFixed(2)})`);
    lines.push(`**Type**: ${m.event.eventType} | **Date**: ${date}`);
    lines.push(`> ${preview}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('*Use `mem-details` with IDs for full content.*');

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
}

async function handleMemTimeline(args: Record<string, unknown>): Promise<ToolResult> {
  const ids = args.ids as string[];
  const windowSize = (args.windowSize as number) || 3;

  const memoryService = getDefaultMemoryService();
  const recentEvents = await memoryService.getRecentEvents(10000);

  const lines: string[] = [
    '## Timeline Context',
    ''
  ];

  for (const targetId of ids) {
    // Find the target event
    const targetEvent = recentEvents.find(e =>
      e.id === targetId || generateCitationId(e.id) === targetId
    );

    if (!targetEvent) {
      lines.push(`Event ${targetId} not found.`);
      continue;
    }

    // Get session events
    const sessionEvents = recentEvents
      .filter(e => e.sessionId === targetEvent.sessionId)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const eventIndex = sessionEvents.findIndex(e => e.id === targetEvent.id);
    const start = Math.max(0, eventIndex - windowSize);
    const end = Math.min(sessionEvents.length, eventIndex + windowSize + 1);

    lines.push(`### Session: ${targetEvent.sessionId.slice(0, 8)}`);
    lines.push('');

    for (let i = start; i < end; i++) {
      const e = sessionEvents[i];
      const isTarget = e.id === targetEvent.id;
      const marker = isTarget ? '**→**' : '   ';
      const time = e.timestamp.toLocaleTimeString();
      const preview = e.content.slice(0, 60) + (e.content.length > 60 ? '...' : '');
      const citationId = generateCitationId(e.id);

      lines.push(`${marker} ${time} [${citationId}] ${e.eventType}: ${preview}`);
    }

    lines.push('');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
}

async function handleMemDetails(args: Record<string, unknown>): Promise<ToolResult> {
  const ids = args.ids as string[];

  const memoryService = getDefaultMemoryService();
  const recentEvents = await memoryService.getRecentEvents(10000);

  const lines: string[] = [];

  for (const targetId of ids) {
    const event = recentEvents.find(e =>
      e.id === targetId || generateCitationId(e.id) === targetId
    );

    if (!event) {
      lines.push(`## Event ${targetId} not found.`);
      lines.push('');
      continue;
    }

    const citationId = generateCitationId(event.id);
    const date = event.timestamp.toISOString();

    lines.push(`## Memory: [mem:${citationId}]`);
    lines.push('');
    lines.push(`**Session**: ${event.sessionId}`);
    lines.push(`**Type**: ${event.eventType}`);
    lines.push(`**Date**: ${date}`);
    lines.push('');
    lines.push('**Content**:');
    lines.push('```');
    lines.push(event.content);
    lines.push('```');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
}

async function handleMemStats(): Promise<ToolResult> {
  const memoryService = getDefaultMemoryService();
  const stats = await memoryService.getStats();
  const recentEvents = await memoryService.getRecentEvents(10000);

  const uniqueSessions = new Set(recentEvents.map(e => e.sessionId));

  const lines: string[] = [
    '## Memory Statistics',
    '',
    `- **Total Events**: ${stats.totalEvents}`,
    `- **Total Vectors**: ${stats.vectorCount}`,
    `- **Sessions**: ${uniqueSessions.size}`,
    '',
    '### Events by Type',
    ''
  ];

  const eventsByType = recentEvents.reduce((acc, e) => {
    acc[e.eventType] = (acc[e.eventType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [type, count] of Object.entries(eventsByType)) {
    lines.push(`- ${type}: ${count}`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
}
