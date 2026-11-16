/**
 * Compaction checkpoint: where a session was right before Claude Code
 * compacted its context, so the SessionStart that follows the compaction
 * (source "compact") can put it back.
 *
 * Stored in the existing memory_checkpoints table (CheckpointRepository, the
 * same rows mem-checkpoint-create writes) with a session target. Built from
 * stored events only, never an LLM call: PreCompact runs on the compaction's
 * critical path.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CheckpointRepository } from '../../../core/operations/checkpoint-repository.js';
import { getProjectStoragePath, hashProjectPath } from '../../../core/registry/project-path.js';
import { singleLineRecallText } from '../../../core/recall-sanitizer.js';
import { SQLiteEventStore } from '../../../core/sqlite-event-store.js';
import type { MemoryEvent } from '../../../core/types.js';

const CHECKPOINT_KIND = 'pre_compact';
const CHECKPOINT_ACTOR = 'claude-hook:pre-compact';

/** Turns scanned for the checkpoint. Bounds the read on a long session. */
const SCAN_TURNS = 5;
const MAX_PROMPTS = 3;
const MAX_EDITED_FILES = 10;
const PROMPT_CHARS = 300;
const RESPONSE_CHARS = 600;

/**
 * How long after it is saved a checkpoint still describes the compaction that
 * follows. SessionStart fires as soon as the summary is written; an older
 * checkpoint belongs to an earlier compaction whose PreCompact succeeded when
 * this one's did not.
 */
export const COMPACTION_CHECKPOINT_MAX_AGE_MS = 10 * 60 * 1000;

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export interface CompactionCheckpoint {
  trigger: string;
  createdAt: Date;
  /** Oldest first. */
  recentPrompts: string[];
  lastResponse?: string;
  /** Relative to the session cwd, most recent first. */
  editedFiles: string[];
  /** The prompt and response events quoted above. */
  sourceEventIds: string[];
}

function storeDbPath(cwd: string): string {
  return path.join(getProjectStoragePath(cwd), 'events.sqlite');
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit).trimEnd()}…`;
}

/** The project file a stored edit observation touched, relative to cwd; null outside it. */
function editedFile(event: MemoryEvent, cwd: string): string | null {
  try {
    const payload = JSON.parse(event.content) as {
      toolName?: unknown;
      toolInput?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };
    if (typeof payload.toolName !== 'string' || !EDIT_TOOLS.has(payload.toolName)) return null;
    const filePath = payload.metadata?.filePath ?? payload.toolInput?.file_path ?? payload.toolInput?.notebook_path;
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
    const relative = path.relative(cwd, filePath);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : null;
  } catch {
    return null;
  }
}

/** Turns newest first, events within a turn oldest first (getSessionTurns order). */
export function buildCompactionCheckpointState(
  turns: ReadonlyArray<{ events: MemoryEvent[] }>,
  cwd: string
): Omit<CompactionCheckpoint, 'trigger' | 'createdAt'> {
  const newestFirst = turns.flatMap((turn) => [...turn.events].reverse());
  const prompts = newestFirst
    .filter((event) => event.eventType === 'user_prompt' && event.content.trim())
    .slice(0, MAX_PROMPTS)
    .reverse();
  const response = newestFirst.find((event) => event.eventType === 'agent_response' && event.content.trim());
  const editedFiles: string[] = [];
  for (const event of newestFirst) {
    if (editedFiles.length >= MAX_EDITED_FILES) break;
    if (event.eventType !== 'tool_observation') continue;
    const file = editedFile(event, cwd);
    if (file && !editedFiles.includes(file)) editedFiles.push(file);
  }

  return {
    recentPrompts: prompts.map((event) => clip(event.content, PROMPT_CHARS)),
    ...(response ? { lastResponse: clip(response.content, RESPONSE_CHARS) } : {}),
    editedFiles,
    sourceEventIds: [...prompts, ...(response ? [response] : [])].map((event) => event.id)
  };
}

/**
 * Save the checkpoint for this session. Returns false, without creating a
 * store, when the project has no store or the session has no stored turns.
 */
export async function saveCompactionCheckpoint(input: { cwd: string; sessionId: string; trigger: string }): Promise<boolean> {
  const dbPath = storeDbPath(input.cwd);
  if (!fs.existsSync(dbPath)) return false;

  const store = new SQLiteEventStore(dbPath);
  try {
    const turns = await store.getSessionTurns(input.sessionId, { limit: SCAN_TURNS });
    const state = buildCompactionCheckpointState(turns, input.cwd);
    if (state.recentPrompts.length === 0 && !state.lastResponse && state.editedFiles.length === 0) return false;

    const { sourceEventIds, ...rest } = state;
    await new CheckpointRepository(store.getDatabase()).create({
      projectHash: hashProjectPath(input.cwd),
      sessionId: input.sessionId,
      title: `Pre-compaction checkpoint (${input.trigger})`,
      summary: `${rest.recentPrompts.length} recent request(s), ${rest.editedFiles.length} edited file(s)`,
      // The repository redacts absolute paths and credentials in this state.
      stateJson: { kind: CHECKPOINT_KIND, trigger: input.trigger, ...rest },
      sourceEventIds,
      actor: CHECKPOINT_ACTOR
    });
    return true;
  } finally {
    await store.close();
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** This session's latest compaction checkpoint, or null when there is no recent one. */
export async function readCompactionCheckpoint(
  cwd: string,
  sessionId: string,
  now: Date = new Date()
): Promise<CompactionCheckpoint | null> {
  const dbPath = storeDbPath(cwd);
  if (!fs.existsSync(dbPath)) return null;

  const store = new SQLiteEventStore(dbPath, { readonly: true });
  try {
    const checkpoints = await new CheckpointRepository(store.getDatabase())
      .list({ projectHash: hashProjectPath(cwd), sessionId, limit: 10 });
    const latest = checkpoints.find((checkpoint) => checkpoint.stateJson.kind === CHECKPOINT_KIND);
    if (!latest || now.getTime() - latest.createdAt.getTime() > COMPACTION_CHECKPOINT_MAX_AGE_MS) return null;

    const state = latest.stateJson;
    return {
      trigger: typeof state.trigger === 'string' ? state.trigger : 'unknown',
      createdAt: latest.createdAt,
      recentPrompts: stringArray(state.recentPrompts),
      ...(typeof state.lastResponse === 'string' ? { lastResponse: state.lastResponse } : {}),
      editedFiles: stringArray(state.editedFiles),
      sourceEventIds: latest.sourceEventIds
    };
  } finally {
    await store.close();
  }
}

/**
 * The SessionStart section for a checkpoint. Every item is collapsed onto one
 * line so stored text cannot open a heading or list item of its own; the hook
 * output envelope sanitizes the whole context on the way out.
 */
export function formatCompactionCheckpointContext(checkpoint: CompactionCheckpoint): string {
  let context = '## Before Compaction\n\n'
    + `The conversation was just compacted (${singleLineRecallText(checkpoint.trigger)}). `
    + `This is where it stood, saved at ${checkpoint.createdAt.toISOString()} right before the compaction:\n\n`;
  if (checkpoint.recentPrompts.length > 0) {
    context += '- Recent requests, oldest first:\n';
    for (const prompt of checkpoint.recentPrompts) context += `  - ${singleLineRecallText(prompt)}\n`;
  }
  if (checkpoint.lastResponse) context += `- Last response: ${singleLineRecallText(checkpoint.lastResponse)}\n`;
  if (checkpoint.editedFiles.length > 0) {
    context += `- Files edited: ${checkpoint.editedFiles.map(singleLineRecallText).join(', ')}\n`;
  }
  return context;
}
