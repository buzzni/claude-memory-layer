/**
 * The pre-edit check's on/off switch, read without zod or SQLite so the
 * PreToolUse entry can exit before loading either when it is off. The hook
 * body checks again through the schema-validated loader.
 */

import * as fs from 'fs';
import { resolveOperationsConfigPath } from '../../../services/operations-config-path.js';

export function preEditCheckSwitchedOn(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(resolveOperationsConfigPath(), 'utf8'));
    return config?.preEditCheck?.enabled === true;
  } catch {
    return false;
  }
}
