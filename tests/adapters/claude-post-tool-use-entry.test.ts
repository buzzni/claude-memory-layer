import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * src/hooks/post-tool-use.ts loads the storing part only for a call it
 * stores. A wiring mistake there would fail open and store nothing, so run
 * the entry itself.
 */

const fixture = vi.hoisted(() => ({ input: '', run: null as null | (() => Promise<string>) }));
const capture = vi.hoisted(() => vi.fn(async () => '{"stored":true}'));

vi.mock('../../src/adapters/claude/hooks/hook-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/adapters/claude/hooks/hook-runtime.js')>(),
  readStdin: vi.fn(async () => fixture.input),
  runHook: vi.fn(async (_options: unknown, run: () => Promise<string>) => { fixture.run = run; })
}));

vi.mock('../../src/adapters/claude/hooks/post-tool-use.js', () => ({ captureToolObservation: capture }));

beforeEach(() => {
  vi.resetModules();
  capture.mockClear();
  fixture.run = null;
});

async function runEntry(input: Record<string, unknown>): Promise<string> {
  fixture.input = JSON.stringify(input);
  await import('../../src/hooks/post-tool-use.js');
  expect(fixture.run).not.toBeNull();
  return fixture.run!();
}

describe('PostToolUse hook entry', () => {
  it('hands a call it stores to the handler file', async () => {
    const input = { session_id: 's', tool_name: 'Edit', tool_input: {}, tool_response: {} };
    expect(await runEntry(input)).toBe('{"stored":true}');
    expect(capture).toHaveBeenCalledWith(input);
  });

  it('answers a call it drops without loading the handler', async () => {
    expect(await runEntry({ session_id: 's', tool_name: 'Read', tool_input: {}, tool_response: { content: 'x' } })).toBe('{}');
    expect(capture).not.toHaveBeenCalled();
  });
});
