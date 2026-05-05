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
  }
];
