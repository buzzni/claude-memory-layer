/**
 * Privacy Filter
 * Combines pattern-based filtering with private tag parsing
 */

import { parsePrivateTagsSafe, hasUnmatchedOpenTag } from './tag-parser.js';
import type { Config } from '../types.js';

export interface FilterResult {
  content: string;
  metadata: {
    hasPrivateTags: boolean;
    privateTagCount: number;
    patternMatchCount: number;
    originalLength: number;
    filteredLength: number;
    hasUnmatchedTags: boolean;
  };
}

// Sensitive data patterns
/**
 * Rejects values that are code rather than a credential: an already-redacted
 * marker, a type annotation, an arrow function, or an opening bracket.
 */
const NOT_A_SECRET_VALUE =
  '(?!\\[REDACTED\\])(?![({\\[]|=>|\\s*$)'
  // The optional quote matters: `apiKey: "string"` is still a type, not a key.
  + '(?![\'"]?(?:string|number|boolean|any|unknown|void|never|null|undefined|true|false'
  + '|Promise|Record|Array|Partial|Readonly)\\b)'
  // `token = json.dumps(...)` assigns in code: the secret would be the result
  // of the call, not this expression.
  + '(?![A-Za-z_$][\\w.$]*\\s*\\()'
  // `var token = ++fitRetryToken` — a credential literal never starts with a
  // unary/increment operator, so this is unambiguously a variable reference.
  + '(?!\\+\\+|--|!|~)'
  // `const TOKEN = process.env.TOKEN || randomBytes(32)…` reads the variable
  // rather than containing it — a very common Node.js pattern in this kind of
  // codebase, and unambiguous because a literal secret is never spelled
  // `process.env.<NAME>`.
  + '(?!process\\.env\\.)';

/**
 * A credential value: a run of `chars`. With `stop`, it stops at a marker. The
 * tag pass runs first, so `token=abc<private>…` reaches these rules as
 * `token=abc[PRIVATE: unclosed]`, and a value that ran on into the marker
 * left a stray `unclosed]` behind (#304). It stops only where the value would
 * end after the marker anyway, at a character it cannot hold or the end: in
 * `token=abc[PRIVATE]def` the `def` is still part of the value, and keeping
 * the marker would store it. A value that is only such a marker is empty, so
 * the rule still redacts what comes before it: the userinfo of
 * `postgres://admin:pw@[PRIVATE]`.
 */
const secretValue = (chars: string, stop: boolean): string => {
  if (!stop) return `${chars}+`;
  const endingMarker = `\\[(?:PRIVATE|REDACTED)(?:: unclosed)?\\](?!${chars})`;
  return `(?:(?:(?!${endingMarker})${chars})+|(?=${endingMarker}))`;
};

/**
 * A credential rule: each match keeps its first `keep(match)` characters and
 * the rest becomes `[REDACTED]`; undefined leaves the match as it is.
 */
interface Rule {
  pattern: RegExp;
  keep: (match: RegExpMatchArray) => number | undefined;
}

const redactWhole = (pattern: RegExp): Rule => ({ pattern, keep: () => 0 });
const keepFirstGroup = (pattern: RegExp): Rule => ({ pattern, keep: (match) => match[1].length });

const sensitivePatterns = (stop: boolean): RegExp[] => [
  // Credential-bearing URLs/connection strings with userinfo before the host.
  // Redact the whole URI so usernames, credentials, hosts, paths, and query
  // params do not leak either.
  new RegExp(`\\b[a-z][a-z0-9+.-]*://[^\\s'"\`<>/@]+@${secretValue('[^\\s\'"`<>]', stop)}`, 'gi'),
  // Two guards keep source code out of these rules. Without them a stored
  // discussion of real code gets mangled — `getAccessToken: () => …` became
  // `getAccess[REDACTED] => …` on live data.
  //
  // The leading lookbehind rejects camelCase identifiers (`getAccessToken:`),
  // while underscore/dash forms (`access_token=…`) still match through the
  // optional prefix group. The trailing guard rejects values that are plainly
  // code rather than a secret: a type annotation, an arrow function, or an
  // opening bracket.
  new RegExp(`(?<![A-Za-z0-9])(?:[\\w.-]+[-_])?password\\s*[:=]\\s*${NOT_A_SECRET_VALUE}['"]?${secretValue(`[^\\s'"]`, stop)}`, 'gi'),
  new RegExp(`(?<![A-Za-z0-9])(?:[\\w.-]+[-_])?api[-_]?key\\s*[:=]\\s*${NOT_A_SECRET_VALUE}['"]?${secretValue(`[^\\s'"]`, stop)}`, 'gi'),
  new RegExp(`(?<![A-Za-z0-9])(?:[\\w.-]+[-_])?secret\\s*[:=]\\s*${NOT_A_SECRET_VALUE}['"]?${secretValue(`[^\\s'"]`, stop)}`, 'gi'),
  new RegExp(`(?<![A-Za-z0-9])(?:[\\w.-]+[-_])?token\\s*[:=]\\s*${NOT_A_SECRET_VALUE}['"]?${secretValue(`[^\\s'"]`, stop)}`, 'gi'),
  // camelCase keys are excluded above because `accessToken: () => …` is code.
  // But `accessToken: "eyJhbGciOi…"` is a real credential, and the difference
  // is the value, not the key. A quoted, long, secret-shaped literal is the
  // one camelCase form worth redacting.
  /[A-Za-z0-9_.-]*(?:password|secret|token|api[-_]?key)\s*[:=]\s*['"][A-Za-z0-9._\-+/=]{12,}['"]/gi,
  // "Bearer token", "Bearer JWT" and friends are how documentation names the
  // scheme, not a secret. On a real store the loose form matched 29 such
  // phrases against a single actual token, so the word after Bearer must not be
  // one of those nouns and the value has to be long enough to be a credential.
  /bearer\s+(?!token\b|jwt\b|auth\b|authentication\b|access\b|scheme\b|header\b|prefix\b)[a-zA-Z0-9\-_.]{16,}/gi,
  /AWS[_-]?ACCESS[_-]?KEY[_-]?ID\s*[:=]\s*['"]?[A-Z0-9]+/gi,
  new RegExp(`AWS[_-]?SECRET[_-]?ACCESS[_-]?KEY\\s*[:=]\\s*['"]?${secretValue(`[^\\s'"]`, stop)}`, 'gi'),
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
  /ghp_[a-zA-Z0-9]{36}/g,  // GitHub Personal Access Token
  /sk-[a-zA-Z0-9]{48}/g,   // OpenAI API Key
  // Vendor-prefixed tokens. The `token\s*[:=]` rule above only fires when a
  // token is introduced with a colon or equals sign, so a key pasted as prose
  // ("hugging face token hf_… Invalid token") slipped through untouched. These
  // prefixes are distinctive enough to match on their own.
  /\bhf_[a-zA-Z0-9]{30,}/g,            // Hugging Face access token
  /\bgh[opsu]_[a-zA-Z0-9]{36,}/g,      // GitHub OAuth/server/user tokens
  /\bgithub_pat_[a-zA-Z0-9_]{50,}/g,   // GitHub fine-grained PAT
  /\bsk-ant-[a-zA-Z0-9_-]{20,}/g,      // Anthropic API key
  /\bglpat-[a-zA-Z0-9_-]{20,}/g,       // GitLab personal access token
  /\bxox[abprs]-[a-zA-Z0-9-]{10,}/g,   // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g,             // AWS access key id
];

const cliSecretOptionPattern = (stop: boolean): RegExp => new RegExp(
  `(--(?:[a-z0-9]+[-_])*(?:password|secret|api[-_]?key|token|bearer)(?:[-_][a-z0-9]+)*(?:\\s+|=))`
    + `(?:"[^"]*"|'[^']*'|${secretValue('[^\\s\'"`<>]', stop)})`,
  'gi'
);

const URL_FOLLOWING_SECRET_PATTERN = /((?:https?:\/\/[^\s'"`<>]+)\s*\r?\n\s*)([A-Za-z0-9!@#$%^&*._+\-~:=/]{6,})(?=\s*(?:\r?\n|$))/gi;

function looksLikePastedSecret(value: string): boolean {
  // Reduce false positives for benign status words pasted after URLs while still
  // catching common dashboard passwords such as alpha-numeric throwaway secrets.
  return value.length >= 8 && /(?:\d|[^A-Za-z0-9])/.test(value);
}

/** Contextual paste filtering (a URL followed by a password-looking line). */
const URL_FOLLOWING_SECRET: Rule = {
  pattern: URL_FOLLOWING_SECRET_PATTERN,
  keep: (match) => (looksLikePastedSecret(match[2]) ? match[1].length : undefined)
};

/** The built-in rules, values stopping at a marker or running on through it. */
const builtInRules = (stop: boolean) => ({
  cli: keepFirstGroup(cliSecretOptionPattern(stop)),
  sensitive: sensitivePatterns(stop).map(redactWhole)
});
const BUILT_IN = { stopping: builtInRules(true), through: builtInRules(false) };

/**
 * A config pattern mirrors the built-in keyword rules, so it needs the same
 * value guard. Without it the config list silently re-introduced every false
 * positive the built-ins had been taught to avoid — `token = json.dumps(payload)`
 * was still being rewritten to `[REDACTED]` through this rule alone. An
 * invalid pattern is skipped.
 */
function excludeRules(patterns: string[], stop: boolean): Rule[] {
  const rules: Rule[] = [];
  for (const patternStr of patterns) {
    try {
      rules.push(keepFirstGroup(new RegExp(
        `(^|[^\\w-])(${patternStr})\\s*[:=]\\s*${NOT_A_SECRET_VALUE}['"]?${secretValue(`[^\\s'"]`, stop)}`,
        'gi'
      )));
    } catch {
      // Invalid regex pattern, skip
    }
  }
  return rules;
}

interface Redacted {
  text: string;
  count: number;
  /** When tracked: where each character is in the text the rules started from, -1 for a marker they put in. */
  from?: Int32Array;
}

const INSERTED = '[REDACTED]';

/** Undefined when `stopsAt` says a match takes in a marker a stopping value could stop at. */
function applyRule(state: Redacted, { pattern, keep }: Rule, stopsAt?: (start: number, end: number) => boolean): Redacted | undefined {
  pattern.lastIndex = 0;
  let text = '';
  const kept: Array<[number, number]> = [];
  let cursor = 0;
  for (const match of state.text.matchAll(pattern)) {
    if (stopsAt?.(match.index!, match.index! + match[0].length)) return undefined;
    const length = keep(match);
    if (length === undefined) continue;
    const end = match.index! + length;
    text += state.text.slice(cursor, end) + INSERTED;
    kept.push([cursor, end]);
    cursor = match.index! + match[0].length;
  }
  if (kept.length === 0) return state;
  text += state.text.slice(cursor);
  if (!state.from) return { text, count: state.count + kept.length };

  const from = new Int32Array(text.length);
  let at = 0;
  for (const [start, end] of kept) {
    from.set(state.from.subarray(start, end), at);
    at += end - start;
    from.fill(-1, at, at + INSERTED.length);
    at += INSERTED.length;
  }
  from.set(state.from.subarray(cursor), at);
  return { text, count: state.count + kept.length, from };
}

function applyRulesTracked({ text, count }: Redacted, rules: Rule[]): Redacted {
  const from = new Int32Array(text.length);
  for (let i = 0; i < from.length; i++) from[i] = i;
  let state: Redacted = { text, count, from };
  for (const rule of rules) state = applyRule(state, rule)!;
  return state;
}

const MARKER = /\[(?:PRIVATE|REDACTED)(?:: unclosed)?\]/g;
/** What a stopping value stops at, in any case. */
const MARKER_ANY_CASE = /\[(?:PRIVATE|REDACTED)(?:: unclosed)?\]/gi;

/**
 * Whether a range holds one of `starts`, where markers start. A rule whose
 * values stop at a marker matches where the other one does, and as far,
 * unless its match takes in the start of one: the two differ only in a
 * lookahead for it.
 */
function startsIn(starts: number[]): (start: number, end: number) => boolean {
  let next = 0;
  // Matches come in order, so each looks on from where the last one did.
  return (start, end) => {
    while (next < starts.length && starts[next] < start) next++;
    return next < starts.length && starts[next] < end;
  };
}

/**
 * Whether the rules with values stopping at a marker (`stopping`) left hidden
 * every character of `text` that they hid with values running on through
 * markers (`through`), apart from markers they kept whole. A piece of a
 * marker is text like any other.
 */
function stoppingHidesAll(text: string, stopping: Redacted, through: Redacted): boolean {
  const shownBy = ({ from }: Redacted) => {
    const at = new Uint8Array(text.length);
    for (const i of from!) if (i >= 0) at[i] = 1;
    return at;
  };
  const shownStopping = shownBy(stopping);
  const shownThrough = shownBy(through);
  for (const match of text.matchAll(MARKER)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (shownStopping.subarray(start, end).every((isShown) => isShown === 1)) shownThrough.fill(1, start, end);
  }
  return shownStopping.every((isShown, i) => !isShown || shownThrough[i] === 1);
}

/**
 * The credential rules, with values stopping at a marker when that hides all
 * they hid before #304, apart from markers. A kept marker changes what the
 * rules after it see: a config pattern can start a match in it that takes the
 * next marker apart (`[a-z_]+` in `a[PRIVATE: unclosed]>[PRIVATE: unclosed]x`),
 * or have used a marker's text as its key (`[a-z\]]+` takes `PRIVATE]` in
 * `[PRIVATE]=hunter2`). No placeholder keeps an arbitrary config pattern from
 * matching, and hiding the marker from it would lose the second case, so the
 * two results are compared character by character instead, and where stopping
 * would show more, the marker is given up.
 */
function redactCredentials(text: string, rules: (stop: boolean) => Rule[]): { content: string; count: number } {
  const stoppingRules = rules(true);
  const throughRules = rules(false);
  // The two runs are the same rule by rule until a stopping rule's match takes
  // in a marker. Most text never gets there, so it is redacted once.
  let state: Redacted = { text, count: 0 };
  let markerStarts: number[] | undefined;
  for (let i = 0; i < throughRules.length; i++) {
    let stopsAt: ((start: number, end: number) => boolean) | undefined;
    if (stoppingRules[i].pattern.source !== throughRules[i].pattern.source) {
      markerStarts ??= Array.from(state.text.matchAll(MARKER_ANY_CASE), (match) => match.index!);
      if (markerStarts.length > 0) stopsAt = startsIn(markerStarts);
    }
    const next = applyRule(state, throughRules[i], stopsAt);
    if (!next) {
      // The runs part here. A marker an earlier rule put in counts as text
      // from here on unless kept whole, which only asks more of stopping.
      const stopping = applyRulesTracked(state, stoppingRules.slice(i));
      const through = applyRulesTracked(state, throughRules.slice(i));
      const kept = stopping.text === through.text || stoppingHidesAll(state.text, stopping, through) ? stopping : through;
      return { content: kept.text, count: kept.count };
    }
    if (next !== state) markerStarts = undefined;
    state = next;
  }
  return { content: state.text, count: state.count };
}

function maskSensitiveString(value: string): string {
  return redactCredentials(value, (stop) => {
    const { cli, sensitive } = stop ? BUILT_IN.stopping : BUILT_IN.through;
    return [cli, ...sensitive];
  }).content;
}

/**
 * Apply privacy filter to content
 *
 * `collapseMarkers: false` skips the final cleanup that merges each run of
 * markers and the whitespace after it, so the lines and indentation around a
 * masked part are kept as they were.
 *
 * `maskUnclosed: false` keeps the text after an unclosed private tag, as the
 * filter did before #269; when tags inside it are closed, it is masked up to
 * the last closing tag. Only for re-filtering rows stored before then, which
 * are not masked retroactively; every storage path keeps the default. The tag
 * is flagged in hasUnmatchedTags either way.
 *
 * `nestTags: false` ends a private section at its first closing tag, as the
 * filter did before #288. Only for recognizing rows stored before then.
 */
export function applyPrivacyFilter(
  content: string,
  config: Config['privacy'],
  options: { collapseMarkers?: boolean; maskUnclosed?: boolean; nestTags?: boolean } = {}
): FilterResult {
  let filtered = content;
  let privateTagCount = 0;
  let patternMatchCount = 0;
  let hasUnmatchedTags = hasUnmatchedOpenTag(content);

  // 1. Private tag filtering
  if (config.privateTags?.enabled !== false) {
    const tagResult = parsePrivateTagsSafe(filtered, {
      formats: config.privateTags?.supportedFormats || ['xml'],
      marker: config.privateTags?.marker || '[PRIVATE]',
      maskUnclosed: options.maskUnclosed,
      nestTags: options.nestTags
    });
    filtered = tagResult.filtered;
    privateTagCount = tagResult.stats.count;
    // hasUnmatchedOpenTag misses an unclosed xml tag evened out by a stray
    // closing tag, and the comment format entirely.
    hasUnmatchedTags ||= tagResult.unclosed;
  }

  // 2. Credential rules: CLI options (`--password value`), a URL followed by
  // a password-looking line, the built-in patterns, then the config patterns.
  const exclude = {
    stopping: excludeRules(config.excludePatterns || [], true),
    through: excludeRules(config.excludePatterns || [], false)
  };
  const credentials = redactCredentials(filtered, (stop) => {
    const { cli, sensitive } = stop ? BUILT_IN.stopping : BUILT_IN.through;
    return [cli, URL_FOLLOWING_SECRET, ...sensitive, ...(stop ? exclude.stopping : exclude.through)];
  });
  filtered = credentials.content;
  patternMatchCount += credentials.count;

  // 3. Clean up consecutive markers
  if (options.collapseMarkers !== false) {
    filtered = filtered.replace(/(\[PRIVATE\]\s*)+/g, '[PRIVATE]\n');
    filtered = filtered.replace(/(\[REDACTED\]\s*)+/g, '[REDACTED] ');
  }

  return {
    content: filtered,
    metadata: {
      hasPrivateTags: privateTagCount > 0,
      privateTagCount,
      patternMatchCount,
      originalLength: content.length,
      filteredLength: filtered.length,
      hasUnmatchedTags
    }
  };
}

/**
 * Mask sensitive data in tool input (recursively)
 *
 * With a privacy config, every string value goes through the full
 * `applyPrivacyFilter` (`<private>` tags included) instead of the credential
 * patterns alone, so stored tool input is masked the way tool output is. The
 * markers are not collapsed: tool input is often code (an Edit's
 * `new_string`), and merging a marker with the newline after it would pull
 * the next line of code onto a redacted comment.
 */
export function maskSensitiveInput(
  input: Record<string, unknown>,
  privacyConfig?: Config['privacy']
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const maskString = (value: string): string =>
    privacyConfig
      ? applyPrivacyFilter(value, privacyConfig, { collapseMarkers: false }).content
      : maskSensitiveString(value);

  for (const [key, value] of Object.entries(input)) {
    // Check if key suggests sensitive data
    const sensitiveKeys = ['password', 'secret', 'key', 'token', 'auth', 'credential'];
    const isSensitiveKey = sensitiveKeys.some(k =>
      key.toLowerCase().includes(k)
    );

    if (isSensitiveKey && typeof value === 'string') {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      // Apply pattern filtering to string values
      result[key] = maskString(value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = maskSensitiveInput(value as Record<string, unknown>, privacyConfig);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item => {
        if (typeof item === 'string') {
          return isSensitiveKey ? '[REDACTED]' : maskString(item);
        }
        return typeof item === 'object' && item !== null
          ? maskSensitiveInput(item as Record<string, unknown>, privacyConfig)
          : item;
      });
    } else {
      result[key] = value;
    }
  }

  return result;
}

// What the filter and the truncation put in place of text: the private
// markers, the credential marker and the truncation notices.
const CUT = /\.\.\.\[truncated\]|\.\.\. \[\d+ (?:lines|characters) truncated\] \.\.\./;
const HIDDEN_TEXT = new RegExp(`\\[PRIVATE(?:: unclosed)?\\]|\\[REDACTED\\]|${CUT.source}`, 'g');

/**
 * Whether `stored` shows all the text `current` shows, in the same order: each
 * piece of `current` between markers and whitespace is found in the text of
 * `stored` between its markers, after the piece before it and never across a
 * marker. A marker is not text: `D` is not shown by `[REDACTED]`. Nor is the
 * text next to a cut in `stored`, which can be part of a marker (`[PR` before
 * `...[truncated]`). An older form of a message can hide text the current
 * form shows (a credential pattern running past a closing tag, a cut at the
 * length limit), so a row in that form alone does not prove the message is
 * stored.
 */
export function showsAllTextOf(stored: string, current: string): boolean {
  // Text and markers alternate: text at even indexes, markers at odd ones.
  const parts = stored.split(new RegExp(`(${HIDDEN_TEXT.source})`));
  const shown = parts.filter((_, i) => i % 2 === 0)
    .map((text, i) => (CUT.test(parts[2 * i - 1] ?? '') || CUT.test(parts[2 * i + 1] ?? '') ? '' : text));
  let part = 0;
  let at = 0;
  for (const piece of current.split(HIDDEN_TEXT).flatMap((text) => text.split(/\s+/))) {
    if (!piece) continue;
    let found = shown[part].indexOf(piece, at);
    while (found === -1 && ++part < shown.length) {
      at = 0;
      found = shown[part].indexOf(piece);
    }
    if (found === -1) return false;
    at = found + piece.length;
  }
  return true;
}

/**
 * Truncate output with head + tail strategy
 */
export function truncateOutput(
  output: string,
  options: { maxLength?: number; maxLines?: number }
): string {
  const { maxLength = 10000, maxLines = 100 } = options;

  // Split into lines
  const lines = output.split('\n');

  // Apply line limit first
  if (lines.length > maxLines) {
    const headLines = Math.ceil(maxLines / 2);
    const tailLines = Math.floor(maxLines / 2);
    const head = lines.slice(0, headLines);
    const tail = lines.slice(-tailLines);
    const truncatedLines = [
      ...head,
      `\n... [${lines.length - maxLines} lines truncated] ...\n`,
      ...tail
    ];
    output = truncatedLines.join('\n');
  }

  // Apply character limit
  if (output.length > maxLength) {
    const headChars = Math.ceil(maxLength / 2);
    const tailChars = Math.floor(maxLength / 2);
    output = output.slice(0, headChars) +
      `\n... [${output.length - maxLength} characters truncated] ...\n` +
      output.slice(-tailChars);
  }

  return output;
}
