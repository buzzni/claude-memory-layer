#!/usr/bin/env tsx
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { computePrecisionRecallAtK, summarizeReplayMetrics } from '../src/core/retrieval-benchmark.js';

interface Fixture {
  name: string;
  description: string;
  ks: number[];
  queries: Array<{ queryId: string; query: string; expectedIds: string[]; expectedRelevance?: Record<string, number> }>;
  memories: Array<{ id: string; content: string }>;
}

const fixturePath = process.argv[2] || path.join('benchmarks', 'replay', 'anonymized-real-sessions.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as Fixture;
const inputs = fixture.queries.map((query) => ({
  queryId: query.queryId,
  expectedIds: query.expectedIds,
  expectedRelevance: query.expectedRelevance,
  retrievedIds: rankByTokenOverlap(query.query, fixture.memories).map((memory) => memory.id)
}));
const perQuery = computePrecisionRecallAtK(inputs, fixture.ks);
const summary = summarizeReplayMetrics(perQuery, fixture.ks);

console.log(JSON.stringify({ name: fixture.name, description: fixture.description, summary, perQuery }, null, 2));

function rankByTokenOverlap(query: string, memories: Fixture['memories']): Fixture['memories'] {
  const queryTokens = tokenize(query);
  return [...memories]
    .map((memory) => ({ memory, score: overlap(queryTokens, tokenize(memory.content)) }))
    .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id))
    .map((row) => row.memory);
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9가-힣\s]/g, ' ').split(/\s+/).filter((token) => token.length >= 2));
}

function overlap(a: Set<string>, b: Set<string>): number {
  let hits = 0;
  for (const token of a) if (b.has(token)) hits += 1;
  return hits;
}
