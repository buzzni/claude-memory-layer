/**
 * Dev/test separation for lesson-recall evaluation data.
 *
 * Every fixture belongs to one split, registered by content hash in
 * benchmarks/lesson-recall/splits.json. Tuning reads dev only; test data is
 * read by an explicit final-report run and never calibrated on.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type EvalSplit = 'dev' | 'test';
/** A case by its prompt text, or by the prompt hash when the text stays outside this repository. */
export type EvalCase = { id: string; query: string } | { id: string; promptHash: string };
export interface SplitManifest {
  version: 1;
  fixtures: Array<{ file: string; sha256: string; split: EvalSplit; external?: { cases: Array<{ id: string; promptHash: string }> }; basis: string }>;
}

const MANIFEST_PATH = fileURLToPath(new URL('../benchmarks/lesson-recall/splits.json', import.meta.url));

export function loadSplitManifest(path = MANIFEST_PATH): SplitManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as SplitManifest;
}

/** Hash of a prompt with case, Unicode width and whitespace differences removed. */
export function promptHash(text: string): string {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/** Ids of cases that sit in both splits, matched by case id or by normalized prompt. */
export function findSplitOverlaps(cases: Record<EvalSplit, readonly EvalCase[]>): string[] {
  const hashOf = (item: EvalCase) => ('promptHash' in item ? item.promptHash : promptHash(item.query));
  const devIds = new Set(cases.dev.map((item) => item.id));
  const devByPrompt = new Map(cases.dev.map((item) => [hashOf(item), item.id]));
  const overlapping = new Set<string>();
  for (const item of cases.test) {
    const devTwin = devByPrompt.get(hashOf(item));
    if (devIds.has(item.id)) overlapping.add(item.id);
    if (devTwin !== undefined) { overlapping.add(devTwin); overlapping.add(item.id); }
  }
  return [...overlapping];
}

export function fixtureSplit(bytes: Buffer | string, manifest: SplitManifest = loadSplitManifest()): EvalSplit | undefined {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return manifest.fixtures.find((fixture) => fixture.sha256 === sha256)?.split;
}

export function assertSplitAccess(split: EvalSplit | undefined, fixturePath: string, options: { finalReport: boolean; calibrating?: boolean }): void {
  if (!split) throw new Error(`${fixturePath} has no registered split; add it to benchmarks/lesson-recall/splits.json as dev or test`);
  if (split === 'dev') return;
  if (options.calibrating) throw new Error(`${fixturePath} is test split; calibrating on it is never allowed, use a dev fixture`);
  if (!options.finalReport) throw new Error(`${fixturePath} is test split; tuning runs read dev only. Pass --final-report for a final report run`);
}

/** Resolve a fixture's split from its bytes and refuse reads the split does not allow. */
export function guardFixtureRead(fixturePath: string, options: { finalReport: boolean; calibrating?: boolean }): EvalSplit {
  const split = fixtureSplit(readFileSync(resolve(fixturePath)));
  assertSplitAccess(split, fixturePath, options);
  return split!;
}
