/**
 * Render-time sanitizer for recalled memory text.
 *
 * Most stored memories come from tool output and transcripts, so recalled text
 * is untrusted. Every path that hands recalled text to an agent (the hook
 * context envelope, the MCP tool result, the dashboard chat prompt) passes it
 * through sanitizeRecallText right before it leaves the process. Stored data
 * is never rewritten; this only changes what is rendered.
 *
 * Covered: characters a reader cannot see that reorder, hide, or smuggle text
 * (bidi controls, zero-width and other invisible format characters, Unicode
 * tag characters, variation-selector runs, C0/C1 controls); tags that close or
 * open a host injection wrapper, including ones split by a removed invisible
 * character or opened with a fullwidth or small `<`; and, through the helpers
 * below, one memory posing as framing or as a sibling memory.
 *
 * Not covered: plain-language instructions inside a memory (the surrounding
 * "data, not instructions" framing handles those); confusable letters such as
 * Cyrillic or fullwidth letters inside a tag name; markup other than the known
 * wrapper tags. Identifiers are sanitized like any other text, so an id that
 * carried an invisible character no longer resolves. Real ids are generated
 * or validated and cannot contain one, so that case fails closed.
 *
 * Every pattern here is a single character class or a fixed-shape token with
 * no nested or adjacent overlapping quantifiers, so cost is linear in the input.
 */

import { HARNESS_BOILERPLATE_MARKERS } from './harness-boilerplate.js';

/**
 * Characters that change what a reader sees without being visible themselves:
 * - C0/C1 controls except \t and \n (\r goes too; CRLF becomes LF)
 * - bidi embeddings, overrides, isolates and the Arabic letter mark (Trojan Source)
 * - zero-width space/non-joiner, LRM/RLM, word joiner and invisible operators,
 *   deprecated format controls, BOM, soft hyphen, Mongolian vowel separator,
 *   interlinear annotation controls
 * - combining grapheme joiner, which can split a tag name without showing
 * - Unicode tag characters, which can carry invisible ASCII. This also drops
 *   the tag sequence of subdivision flags, which then render as a plain black flag.
 * - variation selectors other than the emoji/text presentation pair: in runs
 *   after a visible character they can encode arbitrary bytes. CJK and math
 *   variants fall back to the base glyph.
 * ZWNJ goes as well; Persian or Indic text loses only a shaping hint, not meaning.
 */
const INVISIBLE_OR_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0D\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/** One emoji/text presentation selector is meaningful; a run of them only carries bits. */
const REPEATED_PRESENTATION_SELECTOR = /(?<=[\uFE0E\uFE0F])[\uFE0E\uFE0F]/gu;

/**
 * ZWJ is kept only between two pictographs (after an optional skin-tone
 * modifier or VS16), where it just selects a combined emoji glyph such as
 * woman technologist (U+1F469 U+200D U+1F4BB).
 * Anywhere else it is invisible and can split a word to slip past filters.
 * Both lookarounds inspect one code point, so this stays linear.
 */
const STRAY_ZWJ = /(?<![\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F])\u200D|\u200D(?!\p{Extended_Pictographic})/gu;

/**
 * Wrapper tags hosts put around injected context or use for out-of-band
 * instructions. A recalled `</system-reminder>` could otherwise end the
 * wrapper early and let the rest of the memory read as host text.
 */
const WRAPPER_TAG_NAMES: ReadonlySet<string> = new Set([
  ...HARNESS_BOILERPLATE_MARKERS
    .filter((marker) => marker.startsWith('<') && marker.endsWith('>'))
    .map((marker) => marker.slice(1, -1)),
  'system',
  'role-context',
  'user-prompt-submit-hook',
  'user_instructions',
  'environment_context',
  'function_calls',
  'function_results'
]);
const TOOL_CALL_TAG_PREFIX = 'antml:';

/** `<` (or its fullwidth/small form), any run of whitespace or slashes, then a tag name. */
const TAG_OPENING = /[<\uFE64\uFF1C]([\s/\uFF0F]*)([A-Za-z][\w:.-]*)/g;

function neutralizeWrapperTag(match: string, _lead: string, name: string): string {
  const lowered = name.toLowerCase();
  return WRAPPER_TAG_NAMES.has(lowered) || lowered.startsWith(TOOL_CALL_TAG_PREFIX)
    ? `&lt;${match.slice(1)}`
    : match;
}

/**
 * Strip invisible/control characters and defuse injection-wrapper tags.
 * Idempotent: each step runs after the removals that could join what it
 * matches (a ZWJ next to a removed space, a selector run, a split tag name).
 */
export function sanitizeRecallText(text: string): string {
  return text
    .replace(INVISIBLE_OR_CONTROL, '')
    .replace(STRAY_ZWJ, '')
    .replace(REPEATED_PRESENTATION_SELECTOR, '')
    .replace(TAG_OPENING, neutralizeWrapperTag);
}

/**
 * Collapse a memory onto one line (line breaks become ` / `, the separator the
 * session-start excerpts already use), so inside a one-item-per-line list a
 * memory cannot start a heading or a sibling item of its own.
 */
export function singleLineRecallText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' / ');
}

/**
 * Indent every line after the first, keeping relative indentation, so a
 * multi-line memory stays inside its list item: its own headings, bullets and
 * code fences cannot start at the left margin, and the next item at the margin
 * ends anything it left open.
 */
export function indentContinuationLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line, index) => (index === 0 || line.length === 0 ? line : `${indent}${line}`))
    .join('\n');
}

/**
 * Code-fence a multi-line memory with a backtick run longer than any run inside
 * it (CommonMark), so the content cannot close the fence and continue as
 * surrounding output. The content is sanitized first: the fence must be sized
 * on the text that is finally rendered, or removing an invisible character
 * later could join two backtick runs into a closing fence.
 */
export function fenceRecallBlock(text: string): string {
  const content = sanitizeRecallText(text);
  let longestRun = 0;
  for (const run of content.match(/`+/g) ?? []) longestRun = Math.max(longestRun, run.length);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${content}\n${fence}`;
}
