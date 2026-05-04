import { readTranscriptTailEntries, type ClaudeTranscriptEntry, type ReadTranscriptTailOptions } from './transcript-reader.js';

export interface SessionSummaryEvent {
  eventType?: string;
  content?: string;
}

function isTextContentBlock(value: unknown): value is { type: string; text: string } {
  return typeof value === 'object'
    && value !== null
    && (value as { type?: unknown }).type === 'text'
    && typeof (value as { text?: unknown }).text === 'string';
}

/** Extract assistant text messages from parsed Claude transcript entries. */
export function extractAssistantTextMessages(entries: ClaudeTranscriptEntry[]): string[] {
  const messages: string[] = [];

  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    const textParts = content
      .filter(isTextContentBlock)
      .map((block) => block.text)
      .filter(Boolean);

    if (textParts.length > 0) {
      messages.push(textParts.join('\n'));
    }
  }

  return messages;
}

/** Read a Claude transcript tail and reconstruct assistant text messages. */
export async function extractAssistantMessages(
  transcriptPath: string,
  options?: ReadTranscriptTailOptions
): Promise<string[]> {
  const entries = await readTranscriptTailEntries(transcriptPath, options);
  return extractAssistantTextMessages(entries);
}

/** Generate a simple deterministic summary from stored session events. */
export function generateSessionSummary(events: SessionSummaryEvent[]): string {
  const userPrompts = events.filter((event) => event.eventType === 'user_prompt');
  const responses = events.filter((event) => event.eventType === 'agent_response');

  const parts: string[] = [];
  parts.push(`Session with ${userPrompts.length} user prompts and ${responses.length} responses.`);

  if (userPrompts.length > 0) {
    parts.push('Topics discussed:');
    for (const prompt of userPrompts.slice(0, 3)) {
      const content = prompt.content ?? '';
      const topic = content.slice(0, 100).replace(/\n/g, ' ');
      parts.push(`- ${topic}${content.length > 100 ? '...' : ''}`);
    }
  }

  return parts.join('\n');
}
