/**
 * Privacy filter for text a hook reads back out of the store before showing
 * it to the model. Rows stored before prompt filtering can still carry
 * private tags, so every tag format is removed here.
 */

import { applyPrivacyFilter } from '../../../core/privacy/index.js';
import type { Config } from '../../../core/types.js';

const STORED_TEXT_PRIVACY_CONFIG: Config['privacy'] = {
  excludePatterns: ['password', 'secret', 'api_key', 'token', 'bearer'],
  anonymize: false,
  privateTags: {
    enabled: true,
    // Not '[PRIVATE]': that is also the bracket format's opening tag.
    marker: '[REDACTED]',
    preserveLineCount: false,
    supportedFormats: ['xml', 'bracket', 'comment']
  }
};
/** An opening tag left after filtering: unclosed, or cut off by a read window. */
const PRIVATE_TAG_OPENING = /<private>|\[private\]|<!--\s*private\s*-->/i;

/** Private sections removed, then anything from an opening tag left without its end. */
export function privateSafeText(text: string): string {
  const filtered = applyPrivacyFilter(text, STORED_TEXT_PRIVACY_CONFIG).content;
  const opening = filtered.search(PRIVATE_TAG_OPENING);
  return opening === -1 ? filtered : `${filtered.slice(0, opening)}[REDACTED]`;
}
