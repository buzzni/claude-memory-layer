/**
 * Privacy Module
 * Exports privacy-related utilities
 */

export {
  parsePrivateTags,
  parsePrivateTagsSafe,
  hasUnmatchedOpenTag,
  type PrivateSection,
  type ParseResult,
  type ParseOptions
} from './tag-parser.js';

export {
  applyPrivacyFilter,
  maskSensitiveInput,
  truncateOutput,
  type FilterResult
} from './filter.js';
