/**
 * MCP Tool Definitions
 * Available tools for Claude Desktop
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const projectPathProperty = {
  type: 'string',
  description: 'Optional: absolute project path to search a project-scoped claude-memory-layer store instead of the global store'
} as const;

export const tools: Tool[] = [
  {
    name: 'mem-search',
    description: 'Search claude-memory-layer for relevant past conversations and insights. Returns a compact index of results - use mem-details to get full content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query'
        },
        topK: {
          type: 'number',
          description: 'Maximum number of results (default: 5, max: 20)'
        },
        sessionId: {
          type: 'string',
          description: 'Optional: filter by specific session ID'
        },
        projectPath: projectPathProperty,
        eventType: {
          type: 'string',
          enum: ['user_prompt', 'agent_response', 'tool_observation', 'session_summary'],
          description: 'Optional: filter by event type'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'mem-timeline',
    description: 'Get chronological context around specific memories. Useful for understanding the conversation flow.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Memory IDs (from mem-search) to get timeline for'
        },
        windowSize: {
          type: 'number',
          description: 'Number of items before/after each ID (default: 3)'
        },
        projectPath: projectPathProperty
      },
      required: ['ids']
    }
  },
  {
    name: 'mem-details',
    description: 'Get full content of specific memories. Use after mem-search to get complete information.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Memory IDs to fetch full details for'
        },
        projectPath: projectPathProperty
      },
      required: ['ids']
    }
  },
  {
    name: 'mem-stats',
    description: 'Get statistics about the memory storage (total events, sessions, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty
      }
    }
  },
  {
    name: 'mem-context-pack',
    description: 'Build a compact, agent-ready project context pack from relevant memories plus recent project timeline. Use at the start of Hermes/Codex work to recover the important project state without reading raw transcripts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional task/topic query. Defaults to recent project context.'
        },
        topK: {
          type: 'number',
          description: 'Maximum relevant memories to include (default: 5, max: 12)'
        },
        recentLimit: {
          type: 'number',
          description: 'Maximum recent events to inspect for project timeline (default: 30, max: 200)'
        },
        sessionLimit: {
          type: 'number',
          description: 'Maximum recent sessions to summarize (default: 5, max: 20)'
        },
        sessionId: {
          type: 'string',
          description: 'Optional: filter relevant memories by specific session ID'
        },
        projectPath: projectPathProperty
      }
    }
  },
  {
    name: 'mem-project-timeline',
    description: 'Summarize recent project memory by session, source agent, event counts, and safe previews. Useful for understanding what happened recently before continuing work.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum recent events to inspect (default: 50, max: 500)'
        },
        sessionLimit: {
          type: 'number',
          description: 'Maximum sessions to summarize (default: 10, max: 50)'
        },
        projectPath: projectPathProperty
      }
    }
  },
  {
    name: 'mem-source-ref',
    description: 'Resolve memory IDs, mem citation IDs, or event: IDs into privacy-safe source references with redacted previews and safe metadata only. Prefer this before mem-details when raw transcript exposure is unnecessary.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Memory/event IDs to resolve. Accepts full event IDs, event:<id>, mem:<citation>, or bare citation IDs.'
        },
        maxContentChars: {
          type: 'number',
          description: 'Maximum redacted preview characters per source (default: 500, max: 2000)'
        },
        lookupLimit: {
          type: 'number',
          description: 'Maximum recent events to scan for ID resolution (default: 10000, max: 50000)'
        },
        projectPath: projectPathProperty
      },
      required: ['ids']
    }
  }
];
