/**
 * Disk-backed loader for the memory operations feature config.
 *
 * The `operations` flags (codifyLite, graphExpansion, retention, ...) were
 * previously only settable programmatically, which meant no production
 * surface — hooks, MCP server, daemon — could ever enable them. This loader
 * gives them a single on-disk switch:
 *
 *   ~/.claude-code/memory/operations.json
 *
 * Example: { "enabled": true, "codifyLite": { "enabled": true } }
 *
 * Missing or malformed files behave exactly as before this loader existed
 * (all optional features stay off). The value is cached per process, so
 * long-lived processes (MCP server, semantic daemon) pick up edits on their
 * next restart, not mid-flight.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MemoryOperationsConfigSchema, type MemoryOperationsConfig } from '../core/types.js';

export function resolveOperationsConfigPath(): string {
  const override = process.env.CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH;
  if (override && override.trim().length > 0) return override.trim();
  return path.join(os.homedir(), '.claude-code', 'memory', 'operations.json');
}

let cached: { path: string; value: MemoryOperationsConfig | undefined } | null = null;

export function loadMemoryOperationsConfig(): MemoryOperationsConfig | undefined {
  const configPath = resolveOperationsConfigPath();
  if (cached && cached.path === configPath) return cached.value;

  let value: MemoryOperationsConfig | undefined;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    value = MemoryOperationsConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    // Hooks must never fail session start over an optional config file.
    value = undefined;
    if (process.env.CLAUDE_MEMORY_DEBUG && (error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error(`[claude-memory-layer] ignoring invalid operations config at ${configPath}:`, error);
    }
  }

  cached = { path: configPath, value };
  return value;
}

export function clearMemoryOperationsConfigCache(): void {
  cached = null;
}
