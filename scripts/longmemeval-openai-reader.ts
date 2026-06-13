#!/usr/bin/env tsx

interface LongMemEvalReaderContext {
  id: string;
  rank: number;
  content: string;
}

interface LongMemEvalReaderPayload {
  question_id: string;
  question: string;
  category?: string;
  contexts: LongMemEvalReaderContext[];
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
    text?: string | null;
  }>;
  error?: {
    message?: string;
  };
}

class ReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReaderError';
  }
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_CONTEXT_CHAR_LIMIT = 24_000;

void main().catch((error) => {
  if (error instanceof ReaderError) {
    process.stderr.write(`${error.message}\n`);
  } else if (error instanceof Error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  } else {
    process.stderr.write(`${String(error)}\n`);
  }
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(helpText());
    return;
  }

  const apiKey = readEnv('LONGMEMEVAL_READER_API_KEY') ?? readEnv('OPENAI_API_KEY');
  if (!apiKey) {
    throw new ReaderError('LONGMEMEVAL_READER_API_KEY or OPENAI_API_KEY is required');
  }

  const payload = parsePayload(await readStdin());
  const baseUrl = readEnv('LONGMEMEVAL_READER_BASE_URL') ?? DEFAULT_BASE_URL;
  const model = readEnv('LONGMEMEVAL_READER_MODEL') ?? DEFAULT_MODEL;
  const maxTokens = parsePositiveInteger(readEnv('LONGMEMEVAL_READER_MAX_TOKENS'), DEFAULT_MAX_TOKENS, 'LONGMEMEVAL_READER_MAX_TOKENS');
  const contextCharLimit = parsePositiveInteger(readEnv('LONGMEMEVAL_READER_CONTEXT_CHAR_LIMIT'), DEFAULT_CONTEXT_CHAR_LIMIT, 'LONGMEMEVAL_READER_CONTEXT_CHAR_LIMIT');

  const response = await fetch(`${trimTrailingSlashes(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: buildMessages(payload, contextCharLimit)
    })
  });

  const responseText = await response.text();
  const responseJson = parseOpenAiResponse(responseText);
  if (!response.ok) {
    const detail = redactKnownSecrets(responseJson.error?.message ?? responseText.slice(0, 500), [apiKey]);
    throw new ReaderError(`OpenAI-compatible reader request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }

  const hypothesis = extractHypothesis(responseJson).trim();
  if (!hypothesis) {
    throw new ReaderError('OpenAI-compatible reader response did not contain a hypothesis');
  }
  process.stdout.write(`${hypothesis}\n`);
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { raw += chunk; });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(raw));
  });
}

function parsePayload(raw: string): LongMemEvalReaderPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ReaderError(`Reader stdin must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new ReaderError('Reader stdin must be a JSON object');
  }
  const questionId = parsed.question_id;
  const question = parsed.question;
  const contexts = parsed.contexts;
  if (typeof questionId !== 'string' || questionId.trim() === '') {
    throw new ReaderError('Reader payload requires non-empty string question_id');
  }
  if (typeof question !== 'string' || question.trim() === '') {
    throw new ReaderError('Reader payload requires non-empty string question');
  }
  if (!Array.isArray(contexts)) {
    throw new ReaderError('Reader payload requires contexts array');
  }

  return {
    question_id: questionId,
    question,
    ...(typeof parsed.category === 'string' ? { category: parsed.category } : {}),
    contexts: contexts.map((context, index) => parseContext(context, index))
  };
}

function parseContext(context: unknown, index: number): LongMemEvalReaderContext {
  if (!isRecord(context)) {
    throw new ReaderError(`Reader payload context ${index + 1} must be an object`);
  }
  const id = context.id;
  const rank = context.rank;
  const content = context.content;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ReaderError(`Reader payload context ${index + 1} requires non-empty string id`);
  }
  if (typeof rank !== 'number' || !Number.isFinite(rank)) {
    throw new ReaderError(`Reader payload context ${index + 1} requires numeric rank`);
  }
  if (typeof content !== 'string') {
    throw new ReaderError(`Reader payload context ${index + 1} requires string content`);
  }
  return { id, rank, content };
}

function buildMessages(payload: LongMemEvalReaderPayload, contextCharLimit: number): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        'Answer only from the retrieved LongMemEval context.',
        'If the retrieved context does not contain enough evidence, answer exactly: I do not know.',
        'Return only the final concise hypothesis text. Do not include citations, markdown, or explanation.'
      ].join(' ')
    },
    {
      role: 'user',
      content: buildUserPrompt(payload, contextCharLimit)
    }
  ];
}

function buildUserPrompt(payload: LongMemEvalReaderPayload, contextCharLimit: number): string {
  const lines = [
    `Question ID: ${payload.question_id}`,
    ...(payload.category ? [`Category: ${payload.category}`] : []),
    `Question: ${payload.question}`,
    '',
    'Retrieved Contexts:'
  ];
  let usedChars = 0;
  for (const context of [...payload.contexts].sort((a, b) => a.rank - b.rank)) {
    if (usedChars >= contextCharLimit) break;
    const remaining = contextCharLimit - usedChars;
    const content = context.content.length > remaining
      ? `${context.content.slice(0, Math.max(0, remaining - 16))}\n[truncated]`
      : context.content;
    usedChars += content.length;
    lines.push(`[${context.rank}] ${context.id}`);
    lines.push(content);
    lines.push('');
  }
  if (payload.contexts.length === 0) {
    lines.push('[no retrieved contexts]');
  }
  return lines.join('\n');
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ReaderError(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOpenAiResponse(responseText: string): OpenAiChatResponse {
  try {
    return JSON.parse(responseText) as OpenAiChatResponse;
  } catch (error) {
    throw new ReaderError(`OpenAI-compatible reader response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractHypothesis(response: OpenAiChatResponse): string {
  const firstChoice = response.choices?.[0];
  return firstChoice?.message?.content ?? firstChoice?.text ?? '';
}

function redactKnownSecrets(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length < 2) continue;
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function helpText(): string {
  return `LongMemEval OpenAI-compatible reader wrapper\n\nReads one JSON payload from stdin:\n  {"question_id":"...","question":"...","contexts":[{"id":"...","rank":1,"content":"..."}]}\n\nEnvironment:\n  LONGMEMEVAL_READER_API_KEY or OPENAI_API_KEY    Required API key\n  LONGMEMEVAL_READER_BASE_URL                     Optional OpenAI-compatible base URL (default: ${DEFAULT_BASE_URL})\n  LONGMEMEVAL_READER_MODEL                        Optional model (default: ${DEFAULT_MODEL})\n  LONGMEMEVAL_READER_MAX_TOKENS                   Optional positive integer (default: ${DEFAULT_MAX_TOKENS})\n  LONGMEMEVAL_READER_CONTEXT_CHAR_LIMIT           Optional positive integer (default: ${DEFAULT_CONTEXT_CHAR_LIMIT})\n\nWrites only the hypothesis text to stdout.\n`;
}
