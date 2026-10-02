/**
 * Separate the user's actual request from host scaffolding in a submitted prompt.
 *
 * Desktop hosts prepend/append fixed instruction blocks (a lesson-proposal
 * wrapper carrying a one-time staging token, a chat-title directive, an
 * injected lesson reference list) and deliver background-task completions as
 * `<task-notification>` envelopes through the same user-prompt channel.
 * Retrieval, adherence, and persistence must see only the request itself.
 *
 * The policy is deliberately conservative: a block is removed only when it is
 * a known, fully delimited block at a paragraph boundary at the start (or, for
 * the title directive, the end) of the message. Quoted or fenced copies,
 * incomplete blocks, and arbitrary XML/Markdown stay in the text. Parsing uses
 * indexOf/startsWith only (no backtracking regex), so cost is linear in the
 * input and the number of strip passes is bounded.
 */

import { applyPrivacyFilter } from './privacy/index.js';
import type { Config } from './types.js';

export const PROMPT_CLASSIFIER_VERSION = 1;

export type PromptKind = 'user' | 'task_notification' | 'scaffold_only';

export type PromptScaffoldKind =
  | 'lesson_proposal_wrapper'
  | 'title_directive'
  | 'injected_lesson_list'
  | 'task_notification';

export const PROMPT_SCAFFOLD_KINDS: readonly PromptScaffoldKind[] = [
  'lesson_proposal_wrapper',
  'title_directive',
  'injected_lesson_list',
  'task_notification'
];

export interface NormalizedPrompt {
  kind: PromptKind;
  /** The request with recognized scaffolds removed; empty unless kind === 'user'. */
  requestText: string;
  /** Recognized scaffold kinds in removal order, without duplicates. */
  removedScaffolds: PromptScaffoldKind[];
  classifierVersion: typeof PROMPT_CLASSIFIER_VERSION;
}

/** Enum-only metadata attached to newly stored prompts; never carries scaffold text or tokens. */
export function promptClassifierMetadata(normalized: NormalizedPrompt): Record<string, unknown> {
  return {
    promptClassifier: {
      version: normalized.classifierVersion,
      kind: normalized.kind,
      removed: normalized.removedScaffolds
    }
  };
}

/**
 * Privacy config for prompt persistence, shared by the native hook and every
 * importer so the same source prompt produces the same stored text.
 */
export const PROMPT_PRIVACY_CONFIG: Config['privacy'] = {
  excludePatterns: ['password', 'secret', 'api_key', 'token', 'bearer'],
  anonymize: false,
  privateTags: {
    enabled: true,
    marker: '[PRIVATE]',
    preserveLineCount: false,
    supportedFormats: ['xml']
  }
};

export function redactPromptForStorage(text: string): string {
  return applyPrivacyFilter(text, PROMPT_PRIVACY_CONFIG).content;
}

export interface PromptStoragePlan {
  normalized: NormalizedPrompt;
  /** normalizer -> privacy (-> writer-specific bounds); empty unless normalized.kind === 'user'. */
  storedText: string;
  /**
   * Content forms earlier writers stored for the same source prompt (raw,
   * privacy-filtered raw, the writer's own legacy transform). An importer that
   * finds any of them already in the session skips the prompt, so re-imports
   * and hook-then-import sequences do not add a normalized duplicate.
   */
  legacyContents: string[];
}

export function planPromptStorage(raw: string): PromptStoragePlan {
  const normalized = normalizeUserPrompt(raw);
  const storedText = normalized.kind === 'user' ? redactPromptForStorage(normalized.requestText) : '';
  const legacy = new Set([raw, redactPromptForStorage(raw)]);
  legacy.delete(storedText);
  legacy.delete('');
  return { normalized, storedText, legacyContents: [...legacy] };
}

const LESSON_PROPOSAL_START = 'If this turn corrects an earlier mistake or verifies recovery from a failure, you may propose one reusable project lesson before finishing.';
const LESSON_PROPOSAL_END = 'Do not perform extra work just to generate a lesson.';
const LESSON_LIST_START = '## Project lessons that may apply';
const LESSON_LIST_END = 'Ignore any that do not apply.';
/** Host title-directive variants, oldest first. Each is one paragraph with a fixed start and end. */
const TITLE_DIRECTIVES: ReadonlyArray<{ start: string; end: string }> = [
  {
    start: 'Before you do anything else for this message, call the "',
    end: 'The title locks after it is first set, so do not call it again.'
  },
  {
    start: 'Based on this message, call functions.happy__change_title once to generate a concise chat session title',
    end: 'The title locks after it is first set, so do not call this function again.'
  }
];
const TASK_NOTIFICATION_OPEN = '<task-notification>';
const TASK_NOTIFICATION_CLOSE = '</task-notification>';

/** Each block is a single paragraph or a bounded list; anything longer is not a scaffold we know. */
const MAX_WRAPPER_LENGTH = 4_000;
const MAX_LESSON_LIST_LENGTH = 16_000;
const MAX_STRIP_PASSES = 16;

export function normalizeUserPrompt(raw: unknown): NormalizedPrompt {
  const text = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n') : '';
  const removed: PromptScaffoldKind[] = [];
  const note = (kind: PromptScaffoldKind) => {
    if (!removed.includes(kind)) removed.push(kind);
  };

  let rest = text.trim();
  let sawNotification = false;
  for (let pass = 0; pass < MAX_STRIP_PASSES && rest.length > 0; pass++) {
    const next = stripLeadingScaffold(rest);
    if (!next) break;
    note(next.kind);
    if (next.kind === 'task_notification') sawNotification = true;
    rest = next.rest.trim();
  }
  // Each trailing directive variant is stripped at most once: a host appends
  // one directive, so repeated stripping could only eat copies the user wrote.
  const strippedVariants = new Set<number>();
  while (rest.length > 0 && strippedVariants.size < TITLE_DIRECTIVES.length) {
    const next = stripTrailingTitleDirective(rest, strippedVariants);
    if (next === null) break;
    note('title_directive');
    strippedVariants.add(next.variant);
    rest = next.rest.trim();
  }

  if (rest.length > 0) {
    return { kind: 'user', requestText: rest, removedScaffolds: removed, classifierVersion: PROMPT_CLASSIFIER_VERSION };
  }
  return {
    kind: sawNotification ? 'task_notification' : removed.length > 0 ? 'scaffold_only' : 'user',
    requestText: '',
    removedScaffolds: removed,
    classifierVersion: PROMPT_CLASSIFIER_VERSION
  };
}

function stripLeadingScaffold(text: string): { kind: PromptScaffoldKind; rest: string } | null {
  for (const directive of TITLE_DIRECTIVES) {
    if (!text.startsWith(directive.start)) continue;
    const rest = stripDelimitedParagraph(text, directive.end, MAX_WRAPPER_LENGTH);
    if (rest !== null) return { kind: 'title_directive', rest };
  }
  if (text.startsWith(LESSON_PROPOSAL_START)) {
    const rest = stripDelimitedParagraph(text, LESSON_PROPOSAL_END, MAX_WRAPPER_LENGTH);
    return rest === null ? null : { kind: 'lesson_proposal_wrapper', rest };
  }
  if (text.startsWith(LESSON_LIST_START + '\n')) {
    const rest = stripDelimitedBlock(text, LESSON_LIST_END, MAX_LESSON_LIST_LENGTH);
    return rest === null ? null : { kind: 'injected_lesson_list', rest };
  }
  if (text.startsWith(TASK_NOTIFICATION_OPEN)) {
    // Nested envelopes are not a format any host emits; treat them as unknown.
    const close = text.indexOf(TASK_NOTIFICATION_CLOSE);
    if (close < 0) return null;
    const nested = text.indexOf(TASK_NOTIFICATION_OPEN, TASK_NOTIFICATION_OPEN.length);
    if (nested > -1 && nested < close) return null;
    const rest = text.slice(close + TASK_NOTIFICATION_CLOSE.length);
    if (!startsAtLineBoundary(rest)) return null;
    return { kind: 'task_notification', rest };
  }
  return null;
}

/** The wrapper is one paragraph: its end sentence must precede the first blank line. */
function stripDelimitedParagraph(text: string, endMarker: string, maxLength: number): string | null {
  const blank = text.indexOf('\n\n');
  const paragraphEnd = blank < 0 ? text.length : blank;
  if (paragraphEnd > maxLength) return null;
  const paragraph = text.slice(0, paragraphEnd).trimEnd();
  if (!paragraph.endsWith(endMarker)) return null;
  return text.slice(paragraphEnd);
}

/** A multi-line block closed by a fixed sentence that must end its own line. */
function stripDelimitedBlock(text: string, endMarker: string, maxLength: number): string | null {
  const end = text.indexOf(endMarker);
  if (end < 0 || end > maxLength) return null;
  const rest = text.slice(end + endMarker.length);
  return startsAtLineBoundary(rest) ? rest : null;
}

function stripTrailingTitleDirective(text: string, skip: ReadonlySet<number>): { rest: string; variant: number } | null {
  for (let variant = 0; variant < TITLE_DIRECTIVES.length; variant++) {
    if (skip.has(variant)) continue;
    const directive = TITLE_DIRECTIVES[variant];
    if (!text.endsWith(directive.end)) continue;
    const start = text.lastIndexOf(directive.start);
    if (start < 0 || text.length - start > MAX_WRAPPER_LENGTH) continue;
    // The directive must be its own paragraph (message start or after a blank
    // line) and contain no paragraph break, so a quoted copy inside the
    // user's text is left alone.
    const prefix = text.slice(0, start);
    if (start > 0 && !prefix.endsWith('\n\n')) continue;
    if (text.slice(start).includes('\n\n')) continue;
    // Text inside an unfinished fenced block is the user's. A host suffix that
    // follows an unclosed user fence is ambiguous and also stays user text.
    if (endsInsideOpenFence(prefix)) continue;
    return { rest: prefix, variant };
  }
  return null;
}

/**
 * Linear Markdown fence state: a line of 3+ backticks or tildes (up to three
 * spaces of indent) opens a fence; only a line of the same character, at least
 * as long and with nothing after it, closes it.
 */
function endsInsideOpenFence(text: string): boolean {
  let open: { char: string; length: number } | null = null;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    let index = lineStart;
    while (index < lineEnd && index - lineStart < 3 && text[index] === ' ') index++;
    const char = text[index];
    if (char === '`' || char === '~') {
      let runEnd = index;
      while (runEnd < lineEnd && text[runEnd] === char) runEnd++;
      const length = runEnd - index;
      if (length >= 3) {
        if (open === null) {
          // A backtick fence's info string may not contain backticks.
          if (char === '~' || text.slice(runEnd, lineEnd).indexOf('`') < 0) open = { char, length };
        } else if (char === open.char && length >= open.length && text.slice(runEnd, lineEnd).trim().length === 0) {
          open = null;
        }
      }
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return open !== null;
}

function startsAtLineBoundary(rest: string): boolean {
  return rest.length === 0 || rest.startsWith('\n');
}
