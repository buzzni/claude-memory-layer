/**
 * Render-time sanitizer for recalled memory text.
 *
 * Most stored memories come from tool output and transcripts, so recalled text
 * is untrusted. Every path that hands recalled text to an agent (the hook
 * context envelope and the MCP tool result) passes it through
 * sanitizeRecallText right before it leaves the process. Stored data is never
 * rewritten; this only changes what is rendered.
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
 * - Unicode tag characters, which can carry invisible ASCII. This also drops
 *   the tag sequence of subdivision flags, which then render as a plain black flag.
 * ZWNJ goes as well; Persian or Indic text loses only a shaping hint, not meaning.
 */
const INVISIBLE_OR_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;

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

/** `<`, any run of whitespace or slashes, then a tag name. */
const TAG_OPENING = /<([\s/]*)([A-Za-z][\w:.-]*)/g;

function neutralizeWrapperTag(match: string, _lead: string, name: string): string {
  const lowered = name.toLowerCase();
  return WRAPPER_TAG_NAMES.has(lowered) || lowered.startsWith(TOOL_CALL_TAG_PREFIX)
    ? `&lt;${match.slice(1)}`
    : match;
}

/** Strip invisible/control characters and defuse injection-wrapper tags. Idempotent. */
export function sanitizeRecallText(text: string): string {
  return text
    .replace(INVISIBLE_OR_CONTROL, '')
    .replace(STRAY_ZWJ, '')
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
 * Code-fence a multi-line memory with a backtick run longer than any run inside
 * it (CommonMark), so the content cannot close the fence and continue as
 * surrounding output.
 */
export function fenceRecallBlock(text: string): string {
  let longestRun = 0;
  for (const run of text.match(/`+/g) ?? []) longestRun = Math.max(longestRun, run.length);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${text}\n${fence}`;
}
