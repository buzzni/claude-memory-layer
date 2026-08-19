#!/usr/bin/env node
/**
 * MCP Server for Claude Desktop
 * Provides memory search tools via Model Context Protocol
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { tools } from './tools.js';
import { handleToolCall, shutdownMcpMemoryServices } from './handlers.js';
import { createMcpIdleResourceController, parseMcpIdleReleaseMs } from './idle-resources.js';
import { createMcpProcessLifecycle } from './process-lifecycle.js';
import {
  markRuntimeProcessStopped,
  registerRuntimeProcess
} from '../../core/runtime-resource-telemetry.js';

const server = new Server(
  {
    name: 'claude-memory-layer-mcp',
    version: process.env.CLAUDE_MEMORY_LAYER_VERSION || 'development'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

const idleResources = createMcpIdleResourceController({
  release: () => shutdownMcpMemoryServices('idle-timeout'),
  idleMs: parseMcpIdleReleaseMs(process.env.CLAUDE_MEMORY_MCP_IDLE_RELEASE_MS)
});

// Tool listing handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;
  return idleResources.run(() => handleToolCall(name, args || {}));
});

// Start server
async function main() {
  registerRuntimeProcess('mcp');
  const transport = new StdioServerTransport();
  let lifecycleCheck: NodeJS.Timeout | null = null;
  const lifecycle = createMcpProcessLifecycle({
    shutdown: async () => {
      if (lifecycleCheck) clearInterval(lifecycleCheck);
      idleResources.stopAccepting();
      await idleResources.waitForIdle();
      await idleResources.waitForRelease();
      try {
        await Promise.allSettled([
          server.close(),
          shutdownMcpMemoryServices('process-shutdown')
        ]);
      } finally {
        markRuntimeProcessStopped();
      }
    },
    exit: (code) => process.exit(code),
    getParentPid: () => process.ppid
  });

  const shutdownNormally = () => { void lifecycle.requestShutdown(0); };
  const shutdownForFailure = () => { void lifecycle.requestShutdown(1); };
  process.stdin.once('end', shutdownNormally);
  process.stdin.once('close', shutdownNormally);
  process.once('SIGINT', shutdownNormally);
  process.once('SIGTERM', shutdownNormally);
  process.once('SIGHUP', shutdownNormally);
  process.once('uncaughtException', shutdownForFailure);
  process.once('unhandledRejection', shutdownForFailure);
  lifecycleCheck = setInterval(() => {
    lifecycle.checkParent();
    void idleResources.releaseIfIdle().catch(() => {
      console.error('claude-memory-layer MCP idle resource release failed');
    });
  }, 30_000);
  lifecycleCheck.unref();

  await server.connect(transport);
  console.error('claude-memory-layer MCP server started');
}

main().catch((error) => {
  console.error('claude-memory-layer MCP server failed:', error instanceof Error ? error.message : 'unknown error');
  // stdin listeners are already attached at this point. Merely assigning
  // exitCode would keep a failed stdio server alive until its client closes.
  markRuntimeProcessStopped();
  process.exit(1);
});
