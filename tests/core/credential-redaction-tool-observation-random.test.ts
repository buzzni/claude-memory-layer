import { describe, expect, it } from 'vitest';

import { redactText, redactToolObservation } from '../../src/core/operations/credential-redaction.js';

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

const FRAGMENTS: Array<() => string> = [
  tracked, tracked, tracked,
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
    () => ({ toolName: 'Grep', toolInput: { pattern: text() }, toolOutput: [text(), text(), text()], success: true, metadata: { n: 0 } })
  ])();
  // A number past 2^53, which parsing and serializing the row again would round.
  return JSON.stringify(row).replace('"n":0', `"n":${BIG}`);
}

/** The row with every string value replaced: its keys, numbers and layout. */
const skeleton = (json: string) => json.replace(/"(?:[^"\\]|\\.)*"(\s*:)?/g, (match, colon) => (colon ? match : 'S'));

describe('redactToolObservation against redacting the row as one text (#290)', () => {
  it('never shows what redacting the row as one text masked, keeps the row valid JSON and is idempotent', () => {
    const revealed: Array<{ original: string; redacted: string }> = [];
    let mixed = 0;
    for (let i = 0; i < 1500; i++) {
      nextTracked = FIRST_TRACKED;
      const original = randomRow();
      const whole = redactText(original);
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
    expect(mixed).toBeGreaterThan(500);
  });
});
