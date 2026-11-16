/**
 * Where the operations config lives. Kept apart from the loader, which parses
 * with zod, so a hook can find the file without loading the schema.
 */

import * as os from 'os';
import * as path from 'path';

export function resolveOperationsConfigPath(): string {
  const override = process.env.CLAUDE_MEMORY_OPERATIONS_CONFIG_PATH;
  if (override && override.trim().length > 0) return override.trim();
  return path.join(os.homedir(), '.claude-code', 'memory', 'operations.json');
}
