import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { handleToolCall } from '../../src/extensions/mcp/handlers.js';

/**
 * R4 call path: `mem-lesson-candidates` must report the shadow evaluation
 * alongside the mined candidates, in shadow mode, with nothing promoted.
 */

const originalHome = process.env.HOME;
const roots: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('mem-lesson-candidates shadow evaluation (specs R4)', () => {
  it('returns a shadow evaluation section that promotes nothing', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-mcp-shadow-'));
    roots.push(root);
    const homeDir = path.join(root, 'home');
    mkdirSync(homeDir);
    process.env.HOME = homeDir;

    const result = await handleToolCall('mem-lesson-candidates', {
      projectPath: path.join(root, 'project')
    });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(String(result.content[0]?.text ?? '{}'));
    expect(payload.operation).toBe('mem-lesson-candidates');
    expect(payload.shadowEvaluation).toMatchObject({
      mode: 'shadow',
      evaluated: 0,
      shadowCandidates: 0,
      blocked: 0
    });
    expect(payload.shadowEvaluation.generatorVersion).toMatch(/^derived-evidence-/);
    expect(payload.shadowEvaluation.note).toMatch(/no candidate here is retrievable/i);
    // Every candidate returned carries its shadow verdict; with no mined
    // candidates the list is empty rather than absent.
    expect(Array.isArray(payload.candidates)).toBe(true);
  });
});
