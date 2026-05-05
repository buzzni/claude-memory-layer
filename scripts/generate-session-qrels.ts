#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import {
  buildSessionQrelsFixtureFromJsonl,
  collectClaudeSessionJsonlFiles,
  summarizeSessionQrelsFixture,
  type SessionQrelsNoMatchQueryInput
} from '../src/core/session-qrels.js';

const args = process.argv.slice(2);

void main(args);

async function main(argv: string[]): Promise<void> {
  const sessions: string[] = [];
  const sessionDirs: string[] = [];
  let outPath = '';
  let summaryOutPath = '';
  let name = 'session-qrels-fixture';
  let ks = [1, 3, 5];
  let maxQueries: number | undefined;
  let maxFiles: number | undefined;
  let minBytes = 0;
  let redactContent = false;
  let includeSubagents = false;
  const noMatchQueries: SessionQrelsNoMatchQueryInput[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--session') {
      const value = argv[++i];
      if (value) sessions.push(value);
    } else if (arg === '--sessions-dir' || arg === '--session-dir') {
      const value = argv[++i];
      if (value) sessionDirs.push(value);
    } else if (arg === '--out') {
      outPath = argv[++i] ?? '';
    } else if (arg === '--summary-out') {
      summaryOutPath = argv[++i] ?? '';
    } else if (arg === '--name') {
      name = argv[++i] ?? name;
    } else if (arg === '--ks') {
      ks = (argv[++i] ?? '').split(',').map((value) => Number(value.trim())).filter(Number.isFinite);
    } else if (arg === '--max-queries') {
      const parsed = Number(argv[++i]);
      maxQueries = Number.isFinite(parsed) ? parsed : undefined;
    } else if (arg === '--max-files') {
      const parsed = Number(argv[++i]);
      maxFiles = Number.isFinite(parsed) ? parsed : undefined;
    } else if (arg === '--min-bytes') {
      const parsed = Number(argv[++i]);
      minBytes = Number.isFinite(parsed) ? parsed : minBytes;
    } else if (arg === '--redact-content') {
      redactContent = true;
    } else if (arg === '--include-subagents') {
      includeSubagents = true;
    } else if (arg === '--no-match-query' || arg === '--negative-query') {
      const query = argv[++i];
      if (query) noMatchQueries.push({ query });
    } else if (arg === '--no-match-forbidden-ids' || arg === '--negative-forbidden-ids') {
      const value = argv[++i] ?? '';
      const forbiddenIds = value.split(',').map((id) => id.trim()).filter(Boolean);
      const last = noMatchQueries[noMatchQueries.length - 1];
      if (last) last.forbiddenIds = forbiddenIds;
    } else if (!arg.startsWith('--')) {
      sessions.push(arg);
    }
  }

  for (const sessionDir of sessionDirs) {
    const discovered = await collectClaudeSessionJsonlFiles(expandUserPath(sessionDir), {
      includeSubagents,
      maxFiles,
      minBytes
    });
    sessions.push(...discovered);
  }

  const uniqueSessions = Array.from(new Set(sessions.map(expandUserPath)));

  if (uniqueSessions.length === 0) {
    console.error('Usage: tsx scripts/generate-session-qrels.ts --session <claude.jsonl> [--session <more.jsonl>] [--sessions-dir ~/.claude/projects] [--max-files 50] [--out fixture.json] [--summary-out summary.json] [--ks 1,3,5] [--redact-content] [--no-match-query "query" --no-match-forbidden-ids id1,id2]');
    process.exit(2);
  }

  if (!redactContent) {
    console.error('WARNING: generated qrels include raw user prompts and assistant responses. Review before committing or sharing, or pass --redact-content for shareable metadata.');
  }

  const generatedAt = new Date().toISOString();
  const jsonl = (await Promise.all(uniqueSessions.map((session) => readFile(session, 'utf8')))).join('\n');
  const fixture = buildSessionQrelsFixtureFromJsonl(jsonl, {
    name,
    ks,
    maxQueries,
    redactContent,
    sourceFileCount: uniqueSessions.length,
    rawContentIncluded: !redactContent,
    generatedAt,
    noMatchQueries
  });
  const output = `${JSON.stringify(fixture, null, 2)}\n`;
  const summary = summarizeSessionQrelsFixture(fixture);

  if (outPath) {
    await mkdir(path.dirname(expandUserPath(outPath)), { recursive: true });
    await writeFile(expandUserPath(outPath), output, 'utf8');
  } else {
    process.stdout.write(output);
  }

  if (summaryOutPath) {
    await mkdir(path.dirname(expandUserPath(summaryOutPath)), { recursive: true });
    await writeFile(expandUserPath(summaryOutPath), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }

  console.error(`Generated ${summary.queryCount} qrels from ${uniqueSessions.length} Claude JSONL file(s).`);
}

function expandUserPath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return path.join(homedir(), value.slice(2));
  return value;
}
