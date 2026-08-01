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
  + '(?![A-Za-z_$][\\w.$]*\\s*\\()';

const SENSITIVE_PATTERNS = [
  // Credential-bearing URLs/connection strings with userinfo before the host.
  // Redact the whole URI so usernames, credentials, hosts, paths, and query
  // params do not leak either.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>/@]+@[^\s'"`<>]+/gi,
  // Two guards keep source code out of these rules. Without them a stored
  // discussion of real code gets mangled — `getAccessToken: () => …` became
  // `getAccess[REDACTED] => …` on live data.
  //
  // The leading lookbehind rejects camelCase identifiers (`getAccessToken:`),
  // while underscore/dash forms (`access_token=…`) still match through the
  // optional prefix group. The trailing guard rejects values that are plainly
  // code rather than a secret: a type annotation, an arrow function, or an
  // opening bracket.
  new RegExp(`(?<![A-Za-z0-9])(?:[\\w.-]+[-_])?password\\s*[:=]\\s*${NOT_A_SECRET_VALUE}['"]?[^\\s'"]+`, 'gi'),
  new RegExp(`(?<![A-Za-z0-9])(?:[\\w.-]+[-_])?api[-_]?key\\s*[:=]\\s*${NOT_A_SECRET_VALUE}['"]?[^\\s'"]+`, 'gi'),
  new RegExp(`(?<![A-Za-z0-9])(?:[\\w.-]+[-_])?secret\\s*[:=]\\s*${NOT_A_SECRET_VALUE}['"]?[^\\s'"]+`, 'gi'),
  new RegExp(`(?<![A-Za-z0-9])(?:[\\w.-]+[-_])?token\\s*[:=]\\s*${NOT_A_SECRET_VALUE}['"]?[^\\s'"]+`, 'gi'),
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
  /AWS[_-]?SECRET[_-]?ACCESS[_-]?KEY\s*[:=]\s*['"]?[^\s'"]+/gi,
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

const CLI_SECRET_OPTION_PATTERNS = [
  /(--(?:[a-z0-9]+[-_])*(?:password|secret|api[-_]?key|token|bearer)(?:[-_][a-z0-9]+)*(?:\s+|=))(?:"[^"]*"|'[^']*'|[^\s'"`<>]+)/gi
];

const URL_FOLLOWING_SECRET_PATTERN = /((?:https?:\/\/[^\s'"`<>]+)\s*\r?\n\s*)([A-Za-z0-9!@#$%^&*._+\-~:=/]{6,})(?=\s*(?:\r?\n|$))/gi;

function looksLikePastedSecret(value: string): boolean {
  // Reduce false positives for benign status words pasted after URLs while still
  // catching common dashboard passwords such as alpha-numeric throwaway secrets.
  return value.length >= 8 && /(?:\d|[^A-Za-z0-9])/.test(value);
}

function maskUrlFollowingSecret(value: string): { content: string; count: number } {
  let count = 0;
  const content = value.replace(URL_FOLLOWING_SECRET_PATTERN, (_match, prefix: string, secret: string) => {
    if (!looksLikePastedSecret(secret)) return `${prefix}${secret}`;
    count++;
    return `${prefix}[REDACTED]`;
  });
  return { content, count };
}

function maskCliSecretOptions(value: string): { content: string; count: number } {
  let count = 0;
  let filtered = value;
  for (const pattern of CLI_SECRET_OPTION_PATTERNS) {
    pattern.lastIndex = 0;
    filtered = filtered.replace(pattern, (_match, prefix: string) => {
      count++;
      return `${prefix}[REDACTED]`;
    });
  }
  return { content: filtered, count };
}

function maskSensitiveString(value: string): string {
  let filtered = maskCliSecretOptions(value).content;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    filtered = filtered.replace(pattern, '[REDACTED]');
  }
  return filtered;
}

/**
 * Apply privacy filter to content
 */
export function applyPrivacyFilter(
  content: string,
  config: Config['privacy']
): FilterResult {
  let filtered = content;
  let privateTagCount = 0;
  let patternMatchCount = 0;
  const hasUnmatchedTags = hasUnmatchedOpenTag(content);

  // 1. Private tag filtering
  if (config.privateTags?.enabled !== false) {
    const tagResult = parsePrivateTagsSafe(filtered, {
      formats: config.privateTags?.supportedFormats || ['xml'],
      marker: config.privateTags?.marker || '[PRIVATE]'
    });
    filtered = tagResult.filtered;
    privateTagCount = tagResult.stats.count;
  }

  // 2. CLI option filtering (`--password value`, `--password=value`, etc.)
  const cliResult = maskCliSecretOptions(filtered);
  filtered = cliResult.content;
  patternMatchCount += cliResult.count;

  // 3. Contextual paste filtering (URL followed by a password-looking line)
  const urlSecretResult = maskUrlFollowingSecret(filtered);
  filtered = urlSecretResult.content;
  patternMatchCount += urlSecretResult.count;

  // 4. Built-in sensitive pattern filtering
  for (const pattern of SENSITIVE_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    const matches = filtered.match(pattern);
    if (matches) {
      patternMatchCount += matches.length;
      filtered = filtered.replace(pattern, '[REDACTED]');
    }
  }

  // 3. Custom pattern filtering from config
  //
  // This mirrors the built-in keyword rules, so it needs the same value guard.
  // Without it the config list silently re-introduced every false positive the
  // built-ins had been taught to avoid — `token = json.dumps(payload)` was
  // still being rewritten to `[REDACTED]` through this loop alone.
  for (const patternStr of config.excludePatterns || []) {
    try {
      const regex = new RegExp(
        `(^|[^\\w-])(${patternStr})\\s*[:=]\\s*${NOT_A_SECRET_VALUE}['"]?[^\\s'"]+`,
        'gi'
      );
      const matches = filtered.match(regex);
      if (matches) {
        patternMatchCount += matches.length;
        filtered = filtered.replace(regex, '$1[REDACTED]');
      }
    } catch {
      // Invalid regex pattern, skip
    }
  }

  // 4. Clean up consecutive markers
  filtered = filtered.replace(/(\[PRIVATE\]\s*)+/g, '[PRIVATE]\n');
  filtered = filtered.replace(/(\[REDACTED\]\s*)+/g, '[REDACTED] ');

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
 */
export function maskSensitiveInput(
  input: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

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
      result[key] = maskSensitiveString(value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = maskSensitiveInput(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item => {
        if (typeof item === 'string') {
          return isSensitiveKey ? '[REDACTED]' : maskSensitiveString(item);
        }
        return typeof item === 'object' && item !== null
          ? maskSensitiveInput(item as Record<string, unknown>)
          : item;
      });
    } else {
      result[key] = value;
    }
  }

  return result;
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
