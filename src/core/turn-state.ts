/**
 * Turn State Management
 *
 * Manages a per-session turn_id state file that links events within a conversation turn.
 *
 * Flow:
 * 1. UserPromptSubmit generates a new turn_id and writes it to a state file
 * 2. PostToolUse reads the current turn_id to associate tool observations with the turn
 * 3. Stop reads the turn_id to associate agent responses, then cleans up
 *
 * State file location: ~/.claude-code/memory/.turn-state-{session_id}.json
 *
 * The file is small (just a JSON with turnId + timestamp) and uses atomic writes
 * to prevent corruption from concurrent hook execution.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TURN_STATE_DIR = path.join(os.homedir(), '.claude-code', 'memory');

interface TurnState {
  turnId: string;
  sessionId: string;
  createdAt: string;
}

/**
 * Get the state file path for a session
 */
function getStatePath(sessionId: string): string {
  return path.join(TURN_STATE_DIR, `.turn-state-${sessionId}.json`);
}

/**
 * Write a new turn state for a session.
 * Called by UserPromptSubmit hook when a new user prompt arrives.
 */
export function writeTurnState(sessionId: string, turnId: string): void {
  try {
    // Ensure directory exists
    if (!fs.existsSync(TURN_STATE_DIR)) {
      fs.mkdirSync(TURN_STATE_DIR, { recursive: true });
    }

    const state: TurnState = {
      turnId,
      sessionId,
      createdAt: new Date().toISOString()
    };

    const filePath = getStatePath(sessionId);
    const tempPath = filePath + '.tmp';

    // Atomic write: write to temp file then rename
    fs.writeFileSync(tempPath, JSON.stringify(state));
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    // Non-critical: if we can't write turn state, events just won't be grouped
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Failed to write turn state:', error);
    }
  }
}

/**
 * Read the current turn_id for a session.
 * Called by PostToolUse and Stop hooks to associate events with the current turn.
 * Returns null if no turn state exists (events won't be grouped).
 */
export function readTurnState(sessionId: string): string | null {
  try {
    const filePath = getStatePath(sessionId);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const data = fs.readFileSync(filePath, 'utf-8');
    const state: TurnState = JSON.parse(data);

    // Validate the state belongs to this session
    if (state.sessionId !== sessionId) {
      return null;
    }

    // Check staleness: if the turn state is older than 30 minutes, ignore it
    const createdAt = new Date(state.createdAt).getTime();
    const now = Date.now();
    if (now - createdAt > 30 * 60 * 1000) {
      // Stale turn state, clean up
      clearTurnState(sessionId);
      return null;
    }

    return state.turnId;
  } catch (error) {
    // Non-critical: return null if we can't read
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Failed to read turn state:', error);
    }
    return null;
  }
}

/**
 * Clear the turn state for a session.
 * Called by Stop hook after processing agent responses.
 */
export function clearTurnState(sessionId: string): void {
  try {
    const filePath = getStatePath(sessionId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    // Non-critical
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Failed to clear turn state:', error);
    }
  }
}

/**
 * Clean up stale turn state files (older than 1 hour).
 * Can be called periodically to prevent file accumulation.
 */
export function cleanupStaleTurnStates(): number {
  let cleaned = 0;

  try {
    if (!fs.existsSync(TURN_STATE_DIR)) return 0;

    const files = fs.readdirSync(TURN_STATE_DIR);
    const now = Date.now();

    for (const file of files) {
      if (!file.startsWith('.turn-state-') || !file.endsWith('.json')) continue;

      const filePath = path.join(TURN_STATE_DIR, file);

      try {
        const stat = fs.statSync(filePath);
        // Remove files older than 1 hour
        if (now - stat.mtimeMs > 60 * 60 * 1000) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Non-critical
  }

  return cleaned;
}
