import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

interface ReaderRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface MockRequest {
  url: string | undefined;
  method: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

function runReader(input: unknown, env: Record<string, string> = {}): Promise<ReaderRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'scripts/longmemeval-openai-reader.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LONGMEMEVAL_READER_API_KEY: '',
        OPENAI_API_KEY: '',
        ...env
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(`${typeof input === 'string' ? input : JSON.stringify(input)}\n`, 'utf8');
  });
}

async function startMockOpenAiServer(requests: MockRequest[]): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { raw += chunk; });
    req.on('end', () => {
      requests.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: JSON.parse(raw) as Record<string, unknown>
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [
          { message: { content: ' jasmine tea\n' } }
        ]
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function startMockOpenAiErrorServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'provider rejected key dk' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe('LongMemEval OpenAI-compatible reader wrapper', () => {
  it('fails closed before network when no API key is configured', async () => {
    const result = await runReader({
      question_id: 'q_reader_1',
      question: 'Which tea did the user prefer?',
      contexts: [{ id: 'mem1', rank: 1, content: 'The user likes jasmine tea.' }]
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('LONGMEMEVAL_READER_API_KEY or OPENAI_API_KEY is required');
  });

  it('redacts configured API keys from provider error text before writing stderr', async () => {
    const { server, baseUrl } = await startMockOpenAiErrorServer();
    try {
      const result = await runReader({
        question_id: 'q_reader_error',
        question: 'Which tea did the user prefer?',
        contexts: [{ id: 'mem_answer', rank: 1, content: 'User said: I prefer jasmine tea.' }]
      }, {
        LONGMEMEVAL_READER_API_KEY: 'dk',
        LONGMEMEVAL_READER_BASE_URL: baseUrl
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('OpenAI-compatible reader request failed with HTTP 401');
      expect(result.stderr).toContain('[REDACTED]');
      expect(result.stderr).not.toContain('dk');
    } finally {
      await closeServer(server);
    }
  });

  it('posts retrieved contexts to an OpenAI-compatible chat endpoint and prints only the hypothesis', async () => {
    const requests: MockRequest[] = [];
    const { server, baseUrl } = await startMockOpenAiServer(requests);
    try {
      const result = await runReader({
        question_id: 'q_reader_1',
        question: 'Which tea did the user prefer?',
        category: 'single-session-user',
        contexts: [
          { id: 'mem_answer', rank: 1, content: 'User said: I prefer jasmine tea.' },
          { id: 'mem_noise', rank: 2, content: 'Unrelated calendar discussion.' }
        ]
      }, {
        LONGMEMEVAL_READER_API_KEY: 'dk',
        LONGMEMEVAL_READER_BASE_URL: baseUrl,
        LONGMEMEVAL_READER_MODEL: 'reader-mini'
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('jasmine tea\n');
      expect(requests).toHaveLength(1);
      const request = requests[0];
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/v1/chat/completions');
      expect(request.headers.authorization).toBe('Bearer dk');
      expect(request.body.model).toBe('reader-mini');
      expect(request.body.temperature).toBe(0);
      const messages = request.body.messages as Array<{ role: string; content: string }>;
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('Answer only from the retrieved LongMemEval context');
      expect(messages[1].content).toContain('Question ID: q_reader_1');
      expect(messages[1].content).toContain('[1] mem_answer');
      expect(messages[1].content).toContain('I prefer jasmine tea');
    } finally {
      await closeServer(server);
    }
  });

  it('passes temporal target and reference-date guidance to OpenAI-compatible readers', async () => {
    const requests: MockRequest[] = [];
    const { server, baseUrl } = await startMockOpenAiServer(requests);
    try {
      const result = await runReader({
        question_id: 'q_reader_temporal_openai',
        question: 'How many weeks ago did I meet up with my aunt and receive the crystal chandelier?',
        category: 'temporal-reasoning',
        temporalDateBoost: {
          referenceDate: '2023-04-01',
          targetDate: '2023-03-04',
          toleranceDays: 0,
          entityTerms: ['aunt', 'crystal chandelier']
        },
        contexts: [
          { id: 'chandelier', rank: 1, content: '[2023-03-04] session answer\nuser: I got a stunning crystal chandelier from my aunt today.' }
        ]
      }, {
        LONGMEMEVAL_READER_API_KEY: 'dk',
        LONGMEMEVAL_READER_BASE_URL: baseUrl
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(requests).toHaveLength(1);
      const messages = requests[0].body.messages as Array<{ role: string; content: string }>;
      expect(messages[1].content).toContain('Temporal target date: 2023-03-04; reference date: 2023-04-01; tolerance: ±0 days.');
      expect(messages[1].content).toContain('Treat the reference date as the current/today date for relative-time questions; never use the real current system date.');
      expect(messages[1].content).toContain('Temporal entity terms: aunt, crystal chandelier.');
      expect(messages[1].content).not.toContain('4 weeks ago is the answer');
    } finally {
      await closeServer(server);
    }
  });
});
