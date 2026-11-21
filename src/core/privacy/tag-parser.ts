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

interface TagPair {
  open: RegExp;
  close: RegExp;
}

// Opening and closing tag of each format
const TAG_PATTERNS: Record<string, TagPair> = {
  xml: { open: /<private>/, close: /<\/private>/ },
  bracket: { open: /\[private\]/, close: /\[\/private\]/ },
  comment: { open: /<!--\s*private\s*-->/, close: /<!--\s*\/private\s*-->/ }
};

/**
 * The outermost private sections of one tag format. Tags nest: a section ends
 * at the closing tag that balances its opening tag, not at the first one, or
 * the text between an inner and the outer closing tag would be kept. When the
 * outer tag is never closed, the section still runs to the last closing tag
 * after it, so the inner sections stay masked. A closing tag with no opening
 * tag before it is left as text.
 */
function findSections(text: string, tags: TagPair): Array<Omit<PrivateSection, 'format'>> {
  const sections: Array<Omit<PrivateSection, 'format'>> = [];
  const tagPattern = new RegExp(`(${tags.open.source})|${tags.close.source}`, 'gi');
  let depth = 0;
  let start = 0;
  let contentStart = 0;
  let lastClose: RegExpExecArray | undefined;
  const endAt = (close: RegExpExecArray) => ({
    start,
    end: close.index + close[0].length,
    content: text.slice(contentStart, close.index)
  });

  for (const match of text.matchAll(tagPattern)) {
    if (match[1] !== undefined) {
      if (depth === 0) {
        start = match.index;
        contentStart = match.index + match[0].length;
        lastClose = undefined;
      }
      depth++;
    } else if (depth > 0) {
      depth--;
      lastClose = match;
      if (depth === 0) sections.push(endAt(match));
    }
  }
  if (depth > 0 && lastClose) sections.push(endAt(lastClose));

  return sections;
}

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
    const tags = TAG_PATTERNS[format];
    if (!tags) continue;

    for (const section of findSections(text, tags)) {
      sections.push({ ...section, format: format as PrivateSection['format'] });
    }
  }

  // Remove all tags and replace with marker
  for (const format of options.formats) {
    const tags = TAG_PATTERNS[format];
    if (!tags) continue;

    let replaced = '';
    let cursor = 0;
    for (const section of findSections(filtered, tags)) {
      // Empty tags are completely removed
      replaced += filtered.slice(cursor, section.start) + (section.content.trim() ? options.marker : '');
      cursor = section.end;
    }
    filtered = replaced + filtered.slice(cursor);
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
