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
  /** An opening tag had no end, so everything from it on was masked. */
  unclosed: boolean;
  stats: {
    count: number;
    totalLength: number;
  };
}

export interface ParseOptions {
  formats: Array<'xml' | 'bracket' | 'comment'>;
  marker: string;
  /** Mask from an unclosed opening tag to the end (default). */
  maskUnclosed?: boolean;
  /** End a section at the closing tag of its outer opening tag (default). */
  nestTags?: boolean;
}

type Format = PrivateSection['format'];

interface TagPair {
  open: RegExp;
  close: RegExp;
}

// Opening and closing tag of each format
const TAG_PATTERNS: Record<Format, TagPair> = {
  xml: { open: /<private>/, close: /<\/private>/ },
  bracket: { open: /\[private\]/, close: /\[\/private\]/ },
  comment: { open: /<!--\s*private\s*-->/, close: /<!--\s*\/private\s*-->/ }
};

/**
 * Formats whose unclosed opening tag masks to the end of the text. Not the
 * bracket format: its `[private]` is also the `[PRIVATE]` marker stored rows
 * carry, so failing closed on it would cut every stored row read back with
 * that format enabled at its first marker.
 */
const FAILS_CLOSED: ReadonlySet<Format> = new Set(['xml', 'comment']);

interface Span {
  start: number;
  end: number;
  content: string;
}

interface FoundSections {
  sections: Span[];
  /** Where an opening tag that is never closed starts. */
  unclosedAt?: number;
}

function findTags(text: string, tags: TagPair): IterableIterator<RegExpMatchArray> {
  return text.matchAll(new RegExp(`(${tags.open.source})|${tags.close.source}`, 'gi'));
}

function spanOf(text: string, open: RegExpMatchArray, close: RegExpMatchArray): Span {
  return {
    start: open.index!,
    end: close.index! + close[0].length,
    content: text.slice(open.index! + open[0].length, close.index)
  };
}

/**
 * Sections that end at the first closing tag after their opening tag, the way
 * this parser matched them before #288. Only kept so that nothing they mask is
 * ever revealed (see parsePrivateTags).
 */
function firstCloseSections(text: string, tags: TagPair): FoundSections {
  const sections: Span[] = [];
  let open: RegExpMatchArray | undefined;
  for (const tag of findTags(text, tags)) {
    if (!open) {
      if (tag[1] !== undefined) open = tag;
    } else if (tag[1] === undefined) {
      sections.push(spanOf(text, open, tag));
      open = undefined;
    }
  }
  return { sections };
}

/**
 * Sections that end at the closing tag balancing their opening tag, so the
 * text between an inner and the outer closing tag is masked too (#288). An
 * outer tag that is never closed still masks up to the last closing tag after
 * it. A closing tag with no opening tag before it is left as text.
 */
function nestedSections(text: string, tags: TagPair): FoundSections {
  const sections: Span[] = [];
  let depth = 0;
  let open: RegExpMatchArray | undefined;
  let lastClose: RegExpMatchArray | undefined;
  for (const tag of findTags(text, tags)) {
    if (tag[1] !== undefined) {
      if (depth === 0) {
        open = tag;
        lastClose = undefined;
      }
      depth++;
    } else if (depth > 0) {
      depth--;
      lastClose = tag;
      if (depth === 0) sections.push(spanOf(text, open!, tag));
    }
  }
  if (depth === 0) return { sections };
  if (lastClose) sections.push(spanOf(text, open!, lastClose));
  return { sections, unclosedAt: open!.index };
}

/** A masked part of the text, shown as `shown` (the marker, or nothing). */
interface Mask {
  start: number;
  end: number;
  shown: string;
}

/**
 * The masks of all lists, overlapping ones merged into one. A merged mask is
 * removed only when every mask in it was an empty section.
 */
function unionMasks(...lists: Mask[][]): Mask[] {
  const merged: Mask[] = [];
  for (const mask of lists.flat().sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && mask.start < last.end) {
      last.end = Math.max(last.end, mask.end);
      last.shown ||= mask.shown;
    } else {
      merged.push({ ...mask });
    }
  }
  return merged;
}

/**
 * The text with its masks shown, and where a position in it is in the text.
 * A position inside a marker maps to the whole masked part.
 */
function render(text: string, masks: Mask[]) {
  const parts: Array<{ at: number; start: number; end: number; masked: boolean }> = [];
  let rendered = '';
  let cursor = 0;
  const push = (piece: string, start: number, end: number, masked: boolean) => {
    if (piece) parts.push({ at: rendered.length, start, end, masked });
    rendered += piece;
  };
  for (const mask of masks) {
    push(text.slice(cursor, mask.start), cursor, mask.start, false);
    push(mask.shown, mask.start, mask.end, true);
    cursor = mask.end;
  }
  push(text.slice(cursor), cursor, text.length, false);

  const partAt = (index: number) => {
    let low = 0;
    let high = parts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (parts[mid].at <= index) low = mid;
      else high = mid - 1;
    }
    return parts[low];
  };
  return {
    text: rendered,
    startOf: (index: number) => {
      const part = partAt(index);
      return part.masked ? part.start : part.start + index - part.at;
    },
    endOf: (index: number) => {
      const part = partAt(index - 1);
      return part.masked ? part.end : part.start + index - part.at;
    }
  };
}

/**
 * Masks the sections `find` returns, one format after another: each format is
 * matched in the text the formats before it left, markers included.
 * `unclosedAt` is the earliest unclosed opening tag of a format that fails
 * closed, found by `find` or left over at the end.
 */
function maskFormats(text: string, options: ParseOptions, find: (text: string, tags: TagPair) => FoundSections) {
  let masks: Mask[] = [];
  const sections: PrivateSection[] = [];
  let unclosedAt = Infinity;

  for (const format of options.formats) {
    const tags = TAG_PATTERNS[format];
    if (!tags) continue;

    const view = render(text, masks);
    const found = find(view.text, tags);
    const added = found.sections.map((section) => ({
      start: view.startOf(section.start),
      end: view.endOf(section.end),
      shown: section.content.trim() ? options.marker : ''
    }));
    // A loop, not push(...): one argument per section overflows the stack on large texts.
    found.sections.forEach((section, i) => {
      sections.push({ start: added[i].start, end: added[i].end, content: section.content, format });
    });
    if (found.unclosedAt !== undefined && FAILS_CLOSED.has(format)) {
      unclosedAt = Math.min(unclosedAt, view.startOf(found.unclosedAt));
    }
    masks = unionMasks(masks, added);
  }

  const view = render(text, masks);
  for (const format of options.formats) {
    const index = FAILS_CLOSED.has(format) ? view.text.search(new RegExp(TAG_PATTERNS[format].open, 'i')) : -1;
    if (index !== -1) unclosedAt = Math.min(unclosedAt, view.startOf(index));
  }

  return { masks, sections, unclosedAt };
}

/**
 * Parse and remove private tags from text
 *
 * Tags nest: a section ends at the closing tag of its outer opening tag. The
 * text is also masked where sections ending at their first closing tag, as
 * before #288, would mask it. Formats are matched one after another, so a
 * longer section in one format can hide a closing tag a section of another
 * format ended at; keeping both means no input reveals what was masked before.
 * `nestTags: false` keeps only the first-closing-tag sections, as before #288.
 */
export function parsePrivateTags(
  text: string,
  options: ParseOptions
): ParseResult {
  const firstClose = maskFormats(text, options, firstCloseSections);
  const nested = options.nestTags === false ? firstClose : maskFormats(text, options, nestedSections);
  const masks = unionMasks(firstClose.masks, nested.masks);

  // An opening tag that is never closed: fail closed and mask from it to the
  // end of the text, with a marker that says why. maskUnclosed: false keeps
  // the text after it, for rows stored before #269 (see applyPrivacyFilter).
  let cut = options.maskUnclosed === false ? Infinity : Math.min(firstClose.unclosedAt, nested.unclosedAt);
  cut = masks.find((mask) => mask.start < cut && cut < mask.end)?.start ?? cut;
  const hasUnclosed = cut !== Infinity;

  const kept = masks.filter((mask) => mask.start < cut);
  let filtered = render(text.slice(0, cut), kept).text;
  if (hasUnclosed) filtered += options.marker.replace(/\]$/, ': unclosed]');

  const sections = nested.sections.filter((section) => section.start < cut);
  return {
    filtered,
    sections,
    unclosed: hasUnclosed,
    stats: {
      // Every masked part, including those only the first-closing-tag rule masks.
      count: kept.length + (hasUnclosed ? 1 : 0),
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
  // Placeholders carry a prefix the text does not contain. A fixed one could
  // be typed in the text, and restoring it would put back code that a
  // private section masked.
  let prefix: string;
  do {
    prefix = `__CML_${Math.random().toString(36).slice(2, 10)}_`;
  } while (text.includes(prefix));

  // 1. Extract and protect code blocks
  const codeBlocks: string[] = [];
  const textWithPlaceholders = text.replace(
    /```[\s\S]*?```/g,
    (match) => {
      codeBlocks.push(match);
      return `${prefix}CODE_BLOCK_${codeBlocks.length - 1}__`;
    }
  );

  // Also protect inline code
  const inlineCode: string[] = [];
  const textWithAllPlaceholders = textWithPlaceholders.replace(
    /`[^`]+`/g,
    (match) => {
      inlineCode.push(match);
      return `${prefix}INLINE_CODE_${inlineCode.length - 1}__`;
    }
  );

  // 2. Parse private tags
  const result = parsePrivateTags(textWithAllPlaceholders, options);

  // 3. Restore inline code
  result.filtered = result.filtered.replace(
    new RegExp(`${prefix}INLINE_CODE_(\\d+)__`, 'g'),
    (_, idx) => inlineCode[Number(idx)]
  );

  // 4. Restore code blocks
  result.filtered = result.filtered.replace(
    new RegExp(`${prefix}CODE_BLOCK_(\\d+)__`, 'g'),
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
