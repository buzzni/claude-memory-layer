#!/usr/bin/env tsx
import { readFile, writeFile } from 'node:fs/promises';
import { buildSessionQrelsFixtureFromJsonl } from '../src/core/session-qrels.js';

const args = process.argv.slice(2);
const sessions: string[] = [];
let outPath = '';
let name = 'session-qrels-fixture';
let ks = [1, 3, 5];
let maxQueries: number | undefined;
let redactContent = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--session') {
    const value = args[++i];
    if (value) sessions.push(value);
  } else if (arg === '--out') {
    outPath = args[++i] ?? '';
  } else if (arg === '--name') {
    name = args[++i] ?? name;
  } else if (arg === '--ks') {
    ks = (args[++i] ?? '').split(',').map((value) => Number(value.trim())).filter(Number.isFinite);
  } else if (arg === '--max-queries') {
    const parsed = Number(args[++i]);
    maxQueries = Number.isFinite(parsed) ? parsed : undefined;
  } else if (arg === '--redact-content') {
    redactContent = true;
  } else if (!arg.startsWith('--')) {
    sessions.push(arg);
  }
}

if (sessions.length === 0) {
  console.error('Usage: tsx scripts/generate-session-qrels.ts --session <claude.jsonl> [--session <more.jsonl>] [--out fixture.json] [--ks 1,3,5] [--redact-content]');
  process.exit(2);
}

if (!redactContent) {
  console.error('WARNING: generated qrels include raw user prompts and assistant responses. Review before committing or sharing, or pass --redact-content for shareable metadata.');
}

const jsonl = (await Promise.all(sessions.map((session) => readFile(session, 'utf8')))).join('\n');
const fixture = buildSessionQrelsFixtureFromJsonl(jsonl, { name, ks, maxQueries, redactContent });
const output = `${JSON.stringify(fixture, null, 2)}\n`;

if (outPath) {
  await writeFile(outPath, output, 'utf8');
} else {
  process.stdout.write(output);
}
