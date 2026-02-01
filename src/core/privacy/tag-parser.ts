/**
 * Private Tag Parser
 * Parses and removes <private> tags from content
 */

export interface PrivateSection {
  start: number;
  end: number;
  content: string;
  format: 'xml' | 'bracket' | 'comment';
}

export interface ParseResult {
  filtered: string;
  sections: PrivateSection[];
  stats: {
    count: number;
    totalLength: number;
  };
}

export interface ParseOptions {
  formats: Array<'xml' | 'bracket' | 'comment'>;
  marker: string;
}

// Tag patterns for different formats
const TAG_PATTERNS: Record<string, RegExp> = {
  xml: /<private>([\s\S]*?)<\/private>/gi,
  bracket: /\[private\]([\s\S]*?)\[\/private\]/gi,
  comment: /<!--\s*private\s*-->([\s\S]*?)<!--\s*\/private\s*-->/gi
};

/**
 * Parse and remove private tags from text
 */
export function parsePrivateTags(
  text: string,
  options: ParseOptions
): ParseResult {
  const sections: PrivateSection[] = [];
  let filtered = text;

  // Find all private sections for each format
  for (const format of options.formats) {
    const pattern = TAG_PATTERNS[format];
    if (!pattern) continue;

    // Reset lastIndex for global regex
    pattern.lastIndex = 0;

    let match;
    while ((match = pattern.exec(text)) !== null) {
      sections.push({
        start: match.index,
        end: match.index + match[0].length,
        content: match[1],
        format: format as PrivateSection['format']
      });
    }
  }

  // Remove all tags and replace with marker
  for (const format of options.formats) {
    const pattern = TAG_PATTERNS[format];
    if (!pattern) continue;

    // Need to create new regex for replacement (global flag issues)
    const replacePattern = new RegExp(pattern.source, 'gi');

    filtered = filtered.replace(replacePattern, (_match, content: string) => {
      // Empty tags are completely removed
      if (!content.trim()) return '';
      return options.marker;
    });
  }

  return {
    filtered,
    sections,
    stats: {
      count: sections.length,
      totalLength: sections.reduce((sum, s) => sum + s.content.length, 0)
    }
  };
}

/**
 * Parse private tags safely, protecting code blocks
 */
export function parsePrivateTagsSafe(
  text: string,
  options: ParseOptions
): ParseResult {
  // 1. Extract and protect code blocks
  const codeBlocks: string[] = [];
  const textWithPlaceholders = text.replace(
    /```[\s\S]*?```/g,
    (match) => {
      codeBlocks.push(match);
      return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    }
  );

  // Also protect inline code
  const inlineCode: string[] = [];
  const textWithAllPlaceholders = textWithPlaceholders.replace(
    /`[^`]+`/g,
    (match) => {
      inlineCode.push(match);
      return `__INLINE_CODE_${inlineCode.length - 1}__`;
    }
  );

  // 2. Parse private tags
  const result = parsePrivateTags(textWithAllPlaceholders, options);

  // 3. Restore inline code
  result.filtered = result.filtered.replace(
    /__INLINE_CODE_(\d+)__/g,
    (_, idx) => inlineCode[Number(idx)]
  );

  // 4. Restore code blocks
  result.filtered = result.filtered.replace(
    /__CODE_BLOCK_(\d+)__/g,
    (_, idx) => codeBlocks[Number(idx)]
  );

  return result;
}

/**
 * Check if text has unclosed private tags
 */
export function hasUnmatchedOpenTag(text: string): boolean {
  // Check for opening tags without closing
  const openXml = (text.match(/<private>/gi) || []).length;
  const closeXml = (text.match(/<\/private>/gi) || []).length;

  const openBracket = (text.match(/\[private\]/gi) || []).length;
  const closeBracket = (text.match(/\[\/private\]/gi) || []).length;

  return openXml !== closeXml || openBracket !== closeBracket;
}
