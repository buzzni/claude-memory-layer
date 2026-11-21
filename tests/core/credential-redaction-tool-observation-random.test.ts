import { describe, expect, it } from 'vitest';

import { redactText, redactToolObservation } from '../../src/core/operations/credential-redaction.js';
import { applyPrivacyFilter } from '../../src/core/privacy/filter.js';

/**
 * Random tool_observation rows, compared with redacting the row as one text
 * (what the repair did before #290). Values mix tags that open in one value
 * and close in another, nested tags, backticks and code fences, credentials,
 * escapes and markers left by an earlier run. Plain text is written in CJK
 * characters, each used once per row, so whether one was masked is exact.
 */

let seed = 290;
function random(): number {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
const alnum = (n: number) => Array.from({ length: n }, () => pick([...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'])).join('');

const FIRST_TRACKED = 0x4e00;
let nextTracked = FIRST_TRACKED;
const tracked = () => Array.from({ length: 1 + Math.floor(random() * 4) }, () => String.fromCharCode(nextTracked++)).join('');

/** A tag assembled from a tag split by another, `depth` times: each pass of the filter takes one level apart. */
function assembledTag(depth: number): string {
  let tag = '<private>';
  for (let i = 0; i < depth; i++) tag = tag.replace('<private>', '<pri<private></private>vate>');
  return tag;
}

const FRAGMENTS: Array<() => string> = [
  tracked, tracked, tracked, () => assembledTag(1 + Math.floor(random() * 14)),
  () => ' ', () => '\n', () => '\t', () => '"', () => '\\', () => "'",
  () => '<private>', () => '</private>', () => '<private>', () => '</private>', () => '<PRIVATE>',
  () => '`', () => '```', () => '`code`',
  () => 'password=', () => 'api_key: ', () => 'token=', () => '--token ', () => '--password=', () => 'secret: ',
  () => `Bearer ${alnum(20)}`, () => `ghp_${alnum(36)}`, () => `sk-ant-${alnum(24)}`, () => `accessToken: "${alnum(14)}`,
  () => '-----BEGIN PRIVATE KEY-----', () => '-----END PRIVATE KEY-----', () => 'https://user:pw@host/',
  () => '[PRIVATE]', () => '[REDACTED]', () => 'echo ', () => '='
];
const text = () => Array.from({ length: Math.floor(random() * 9) }, () => pick(FRAGMENTS)()).join('');

const BIG = '12345678901234567890';
function randomRow(): string {
  const row = pick([
    () => ({ toolName: 'Bash', toolInput: { command: text(), description: text() }, toolOutput: text(), success: true, metadata: { n: 0 } }),
    () => ({ toolName: 'Edit', toolInput: { old_string: text(), new_string: text() }, toolOutput: { stdout: text(), stderr: text() }, success: false, metadata: { n: 0 } }),
    () => ({ toolName: 'Grep', toolInput: { pattern: text() }, toolOutput: [text(), text(), text()], success: true, metadata: { n: 0 } }),
    () => ({ toolName: 'Glob', toolInput: { pattern: text() }, toolOutput: Array.from({ length: 20 + Math.floor(random() * 60) }, text), success: true, metadata: { n: 0 } })
  ])();
  // A number past 2^53, which parsing and serializing the row again would round.
  return JSON.stringify(row).replace('"n":0', `"n":${BIG}`);
}

/**
 * One pass of the repair's filter over the row as one text: what the repair
 * did before #290. redactText now repeats it until nothing changes (#308),
 * and a later pass over a row the first one broke pairs tags across values.
 */
const redactRowOnce = (row: string) => applyPrivacyFilter(row, {
  excludePatterns: ['password', 'secret', 'api_key', 'token', 'bearer'],
  anonymize: false,
  privateTags: { enabled: true, marker: '[PRIVATE]', preserveLineCount: false, supportedFormats: ['xml'] }
}, { maskUnclosed: false }).content;

/** The row with every string value replaced: its keys, numbers and layout. */
const skeleton = (json: string) => json.replace(/"(?:[^"\\]|\\.)*"(\s*:)?/g, (match, colon) => (colon ? match : 'S'));

/** Every private-use character, from `skip` on: what the repair marks values with. */
function privateUseCharacters(skip = 0): string {
  let text = '';
  for (const [from, to] of [[0xe000, 0xf8ff], [0xf0000, 0xffffd], [0x100000, 0x10fffd]]) {
    for (let code = from; code <= to; code++) text += String.fromCodePoint(code);
  }
  return Array.from(text).slice(skip).join('');
}

describe('redactToolObservation against redacting the row as one text (#290)', () => {
  it('never shows what redacting the row as one text masked, keeps the row valid JSON and is idempotent', () => {
    const revealed: Array<{ original: string; redacted: string }> = [];
    let mixed = 0;
    for (let i = 0; i < 600; i++) {
      nextTracked = FIRST_TRACKED;
      const original = randomRow();
      const whole = redactRowOnce(original);
      const redacted = redactToolObservation(original);

      expect(() => JSON.parse(redacted)).not.toThrow();
      expect(skeleton(redacted)).toBe(skeleton(original));
      expect(redactToolObservation(redacted)).toBe(redacted);
      for (let code = FIRST_TRACKED; code < nextTracked; code++) {
        const char = String.fromCharCode(code);
        if (!whole.includes(char) && redacted.includes(char)) {
          revealed.push({ original, redacted });
          break;
        }
      }
      try {
        JSON.parse(whole);
      } catch {
        mixed++;
      }
    }

    expect(revealed).toEqual([]);
    // The rows are hard enough: redacting them as one text breaks the JSON of most.
    expect(mixed).toBeGreaterThan(200);
  });

  it('handles a row with more string values than characters to mark them', () => {
    const row = JSON.stringify(['echo <private>x</private> done', ...Array(68734).fill('')]);
    const redacted = redactToolObservation(row);

    expect(JSON.parse(redacted)[0]).toBe('echo [PRIVATE] done');
    expect(JSON.parse(redacted)).toHaveLength(68735);
    expect(redactToolObservation(redacted)).toBe(redacted);
  });

  it('marks the values a group at a time when the row leaves few characters to mark with', () => {
    // Four free characters: two values per group.
    const row = JSON.stringify({
      toolName: 'Bash', toolInput: { command: 'echo <private>a', d: 'b</private> c', e: 'token=zz' }, toolOutput: 'x <private>y</private>', extra: privateUseCharacters(4)
    });
    const redacted = JSON.parse(redactToolObservation(row));

    expect(redacted.toolInput).toEqual({ command: 'echo [PRIVATE]', d: '[PRIVATE] c', e: '[REDACTED]' });
    expect(redacted.toolOutput).toBe('x [PRIVATE]');
    expect(redacted.toolName).toBe('Bash');
  });

  it('masks every value but the tool name of a row that holds every character to mark with', () => {
    const row = JSON.stringify({ toolName: 'Bash', toolInput: { command: 'echo <private>x</private> done' }, toolOutput: privateUseCharacters() });
    const redacted = redactToolObservation(row);

    expect(JSON.parse(redacted)).toEqual({ toolName: 'Bash', toolInput: { command: '[PRIVATE]' }, toolOutput: '[PRIVATE]' });
    expect(redactToolObservation(redacted)).toBe(redacted);
  });

  it('masks a value that still changes after the last pass, keeping the tool name', () => {
    const row = JSON.stringify({ toolName: 'Bash', toolOutput: `${assembledTag(20)}secret-value</private>` });
    const redacted = redactToolObservation(row);

    expect(JSON.parse(redacted)).toEqual({ toolName: 'Bash', toolOutput: '[PRIVATE]' });
    expect(redactToolObservation(redacted)).toBe(redacted);
  });

  it('masks the tool name too when filtering the row as one text masked it', () => {
    const row = JSON.stringify({ toolInput: { command: 'echo <private>a' }, toolName: 'Bash</private>', toolOutput: privateUseCharacters() });
    expect(redactText(row)).not.toContain('Bash');

    expect(JSON.parse(redactToolObservation(row))).toEqual({ toolInput: { command: '[PRIVATE]' }, toolName: '[PRIVATE]', toolOutput: '[PRIVATE]' });
  });
});
