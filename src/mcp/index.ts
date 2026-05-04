#!/usr/bin/env node
// Compatibility entrypoint. MCP is an optional extension, but existing package
// and local paths still resolve through src/mcp during the strangler migration.
import '../extensions/mcp/index.js';
