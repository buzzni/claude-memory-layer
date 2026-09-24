/**
 * Citation Generator
 * Generates unique, short citation IDs for memory references
 */

import { createHash } from 'crypto';

const ID_LENGTH = 6;
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a citation ID from an event ID using SHA256
 */
export function generateCitationId(eventId: string): string {
  const hash = createHash('sha256')
    .update(eventId)
    .digest();

  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    id += CHARSET[hash[i] % CHARSET.length];
  }

  return id;
}

/**
 * Generate a unique citation ID with collision handling
 */
export async function generateUniqueCitationId(
  eventId: string,
  existsCheck: (id: string) => Promise<boolean>
): Promise<string> {
  let id = generateCitationId(eventId);
  let attempt = 0;

  while (await existsCheck(id) && attempt < 10) {
    // Add salt and regenerate
    id = generateCitationId(`${eventId}:${attempt}`);
    attempt++;
  }

  if (attempt >= 10) {
    throw new Error('Failed to generate unique citation ID after 10 attempts');
  }

  return id;
}

/**
 * Format a citation ID for display
 */
export function formatCitationId(citationId: string): string {
  return `[mem:${citationId}]`;
}

/**
 * Parse a citation ID from formatted string
 */
export function parseCitationId(formatted: string): string | null {
  const match = formatted.match(/\[?mem:([A-Za-z0-9]{6})\]?/);
  return match ? match[1] : null;
}
