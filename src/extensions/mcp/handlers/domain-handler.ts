import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { handleToolCallInDomain } from '../handlers.js';

export type McpToolHandler = (
  name: string,
  args: Record<string, unknown>
) => Promise<CallToolResult>;

export interface McpHandlerDomain {
  name: 'context-search' | 'source-import' | 'operations' | 'graph-lessons' | 'governance-assets' | 'perspective-shared';
  toolNames: readonly string[];
  handle: McpToolHandler;
}

export function createMcpHandlerDomain(
  name: McpHandlerDomain['name'],
  toolNames: readonly string[]
): McpHandlerDomain {
  const boundedNames = new Set(toolNames);
  return {
    name,
    toolNames,
    async handle(toolName, args) {
      if (!boundedNames.has(toolName)) {
        throw new Error(`MCP ${name} handler cannot dispatch unowned tool: ${toolName}`);
      }
      return handleToolCallInDomain(name, toolName, args);
    }
  };
}
