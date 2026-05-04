import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { tools as toolsFromExtension } from '../src/extensions/mcp/tools.js';
import { tools as toolsFromCompat } from '../src/mcp/tools.js';
import { handleToolCall as handleFromExtension } from '../src/extensions/mcp/handlers.js';
import { handleToolCall as handleFromCompat } from '../src/mcp/handlers.js';

describe('mcp extension boundary', () => {
  it('keeps MCP implementation under extensions with compatibility re-exports', () => {
    const indexCompatSource = readFileSync('src/mcp/index.ts', 'utf8');
    const toolsCompatSource = readFileSync('src/mcp/tools.ts', 'utf8');
    const handlersCompatSource = readFileSync('src/mcp/handlers.ts', 'utf8');

    expect(toolsFromCompat).toBe(toolsFromExtension);
    expect(handleFromCompat).toBe(handleFromExtension);
    expect(indexCompatSource).toContain("../extensions/mcp/index.js");
    expect(toolsCompatSource).toContain("../extensions/mcp/tools.js");
    expect(handlersCompatSource).toContain("../extensions/mcp/handlers.js");
  });
});
