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

export {
  DEFAULT_PUBLIC_OUTPUT_SCAN_PATHS,
  formatPublicOutputScanMarkdown,
  scanPublicOutputFiles,
  type PublicOutputFinding,
  type PublicOutputScanOptions,
  type PublicOutputScanReport
} from './public-output-scanner.js';
