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
const SENSITIVE_PATTERNS = [
  /password\s*[:=]\s*['"]?[^\s'"]+/gi,
  /api[_-]?key\s*[:=]\s*['"]?[^\s'"]+/gi,
  /secret\s*[:=]\s*['"]?[^\s'"]+/gi,
  /token\s*[:=]\s*['"]?[^\s'"]+/gi,
  /bearer\s+[a-zA-Z0-9\-_.]+/gi,
  /AWS[_-]?ACCESS[_-]?KEY[_-]?ID\s*[:=]\s*['"]?[A-Z0-9]+/gi,
  /AWS[_-]?SECRET[_-]?ACCESS[_-]?KEY\s*[:=]\s*['"]?[^\s'"]+/gi,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
  /ghp_[a-zA-Z0-9]{36}/g,  // GitHub Personal Access Token
  /sk-[a-zA-Z0-9]{48}/g,   // OpenAI API Key
];

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

  // 2. Built-in sensitive pattern filtering
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
  for (const patternStr of config.excludePatterns || []) {
    try {
      const regex = new RegExp(
        `(${patternStr})\\s*[:=]\\s*['"]?[^\\s'"]+`,
        'gi'
      );
      const matches = filtered.match(regex);
      if (matches) {
        patternMatchCount += matches.length;
        filtered = filtered.replace(regex, '[REDACTED]');
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
      let filtered = value;
      for (const pattern of SENSITIVE_PATTERNS) {
        pattern.lastIndex = 0;
        filtered = filtered.replace(pattern, '[REDACTED]');
      }
      result[key] = filtered;
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = maskSensitiveInput(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        typeof item === 'object' && item !== null
          ? maskSensitiveInput(item as Record<string, unknown>)
          : item
      );
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
