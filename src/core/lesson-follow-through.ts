/**
 * What a session did with a lesson after it was shown: did it open the body,
 * and did it run the distinctive commands the lesson prescribes.
 *
 * These are observations, not proof of application. A matched command may have
 * been run for an unrelated reason, and a lesson can be applied without running
 * any of its commands, so neither signal is reported as "applied"
 * (specs/memory-usage-followup-2026-10-03 R2).
 */

import { classifyLessonGetOutput, LESSON_GET_TOOL_ALIASES } from './lesson-usage-audit.js';
import { sqliteAll, type SQLiteDatabase } from './sqlite-wrapper.js';

/** Per lesson: session-start listings that reached the model, and how many were followed by opening its body. */
export interface SessionStartLessonUsage {
  exposures: number;
  engaged: number;
}

export interface LessonFollowThrough {
  /** A mem-lesson-get for this lesson that returned found=true. */
  bodyRead: boolean;
  /** Distinctive shell commands the lesson's steps/validation name. */
  commandAnchors: number;
  /** How many of those anchors a later shell command contained. */
  matchedAnchors: number;
}

const SHELL_TOOL_NAMES = new Set(['Bash', 'bash', 'shell', 'exec_command', 'mcp__happy__bash_stream']);

const MIN_ANCHOR_CHARS = 8;
/** Code and compound commands, not one runnable command. */
const NON_COMMAND = /===|=>|[{}]|\|\||&&/;

/**
 * An argument that ties a command to this lesson: a file or path. Git refs
 * (origin/main, HEAD) and bare flags do not: sessions run `git status --short`,
 * `npm test` or `git show origin/main:` whether or not any lesson is involved.
 */
function hasSpecificArgument(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    // A redirect target (`2>/dev/null`, `> /tmp/out.log`) is plumbing, not a subject.
    if (/^\d*[<>]+&?$/.test(args[i])) { i++; continue; }
    if (/^\d*[<>]/.test(args[i])) continue;
    if (isSpecificArgument(args[i])) return true;
  }
  return false;
}

function isSpecificArgument(token: string): boolean {
  let value = token.replace(/^['"]+|['"]+$/g, '');
  if (value.startsWith('-')) {
    const assigned = value.indexOf('=');
    if (assigned < 0) return false;
    value = value.slice(assigned + 1);
  }
  if (/^(?:origin|upstream)\//i.test(value) || /(?:^|\.\.\.?)HEAD(?=$|[~^@:])/.test(value)) return false;
  return value.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(value);
}

function normalizeCommand(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Backtick spans from steps and validation that read as a shell command: a
 * lowercase program name followed by arguments, at least one of them a file or
 * path. The span is cut before the first `<placeholder>` or `...` so a
 * filled-in command still matches.
 */
export function lessonCommandAnchors(lesson: { steps: readonly string[]; validation?: readonly string[] }): string[] {
  const anchors: string[] = [];
  for (const text of [...lesson.steps, ...(lesson.validation ?? [])]) {
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      if (NON_COMMAND.test(match[1])) continue;
      const cut = match[1].search(/<|\.\.\.|…/);
      const anchor = normalizeCommand(cut >= 0 ? match[1].slice(0, cut) : match[1]);
      const tokens = anchor.split(' ');
      if (tokens.length < 2 || !/^[a-z][a-z0-9._-]*$/.test(tokens[0])) continue;
      if (!hasSpecificArgument(tokens.slice(1))) continue;
      if (anchor.length < MIN_ANCHOR_CHARS) continue;
      if (!anchors.includes(anchor)) anchors.push(anchor);
    }
  }
  return anchors;
}

export interface ParsedToolObservation {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
}

/** Parse one stored tool_observation content; null when it is not a tool record. */
export function parseToolObservation(content: string): ParsedToolObservation | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.toolName !== 'string') return null;
    const toolInput = record.toolInput && typeof record.toolInput === 'object'
      ? record.toolInput as Record<string, unknown>
      : {};
    return { toolName: record.toolName, toolInput, toolOutput: record.toolOutput };
  } catch {
    return null;
  }
}

function shellCommand(toolInput: Record<string, unknown>): string | null {
  const command = toolInput.command ?? toolInput.cmd;
  if (typeof command === 'string') return command;
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) return command.join(' ');
  return null;
}

/**
 * Evaluate the tool observations that followed a lesson's delivery. Callers
 * parse each observation once and reuse it across the lessons of a session.
 */
export function observeLessonFollowThrough(
  lesson: { lessonId: string; name: string; steps: readonly string[]; validation?: readonly string[] },
  observations: ReadonlyArray<ParsedToolObservation | null>
): LessonFollowThrough {
  const anchors = lessonCommandAnchors(lesson);
  const matched = new Set<string>();
  let bodyRead = false;
  for (const observation of observations) {
    if (!observation) continue;
    if (LESSON_GET_TOOL_ALIASES.includes(observation.toolName)) {
      const target = observation.toolInput.lessonId === lesson.lessonId || observation.toolInput.name === lesson.name;
      if (target && classifyLessonGetOutput(observation.toolOutput, null) === 'found') bodyRead = true;
      continue;
    }
    if (!SHELL_TOOL_NAMES.has(observation.toolName)) continue;
    const command = shellCommand(observation.toolInput);
    if (!command) continue;
    const normalized = normalizeCommand(command);
    for (const anchor of anchors) {
      if (normalized.includes(anchor)) matched.add(anchor);
    }
  }
  return { bodyRead, commandAnchors: anchors.length, matchedAnchors: matched.size };
}

/**
 * Per lesson, since `since`: session-start listings that reached the model, and
 * how many of them were followed by a body read or reference open (as the
 * helpfulness evaluator recorded them). Feeds the session-start index order.
 *
 * A matched command is left out on purpose: lessons that mention a repo gate
 * such as `node scripts/check-max-lines.mjs` would match in most sessions and
 * hold the top of the index for reasons unrelated to the lesson.
 */
/**
 * The query label a host-mode runbook index listing is recorded under. The
 * audit classifies runbook listings by it, so a later revert does not move
 * past listings out of the runbook count.
 */
export const SESSION_START_RUNBOOK_INDEX_LABEL = '[session-start] runbook index';

export function readSessionStartLessonUsage(
  db: SQLiteDatabase,
  since: Date
): Map<string, SessionStartLessonUsage> {
  const rows = sqliteAll<{ lesson_id: string; exposures: number; engaged: number }>(
    db,
    `SELECT event_id AS lesson_id,
            COUNT(*) AS exposures,
            SUM(CASE WHEN json_valid(evidence_json) THEN
                  CASE WHEN json_extract(evidence_json, '$.lessonFollowThrough.opened') = 1 THEN 1 ELSE 0 END
                ELSE 0 END) AS engaged
     FROM memory_helpfulness
     WHERE memory_kind = 'lesson'
       AND trigger_type = 'session_start'
       AND delivery_status = 'emitted'
       AND julianday(created_at) >= julianday(?)
     GROUP BY event_id`,
    [since.toISOString()]
  );
  return new Map(rows.map((row) => [row.lesson_id, { exposures: Number(row.exposures), engaged: Number(row.engaged) }]));
}
