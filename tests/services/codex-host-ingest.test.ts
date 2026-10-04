import { describe, expect, it, vi } from 'vitest';
import { importCodexCompletedTurns, type CodexCompletedImportDeps } from '../../src/services/codex-host-ingest.js';

function fixture() {
  const service = {
    initialize: vi.fn(async () => {}), shutdown: vi.fn(async () => {}), startSession: vi.fn(async () => {}),
    hasSessionUserPrompt: vi.fn(async () => false),
    storeUserPrompt: vi.fn(async () => ({ success: true, isDuplicate: false })),
    storeAgentResponse: vi.fn(async () => ({ success: true, isDuplicate: false })),
  };
  const transcript = { sessionId: 'thread', cwd: '/repo', turns: [{ turnId: 'turn', cwd: '/repo/worktree',
    userMessages: ['Fix the data import and verify its regression tests.'], assistantResponse: 'The import now succeeds; regression tests passed.',
    startedAt: '2026-10-04T00:00:00Z', completedAt: '2026-10-04T00:01:00Z' }] };
  const deps = { readTranscript: vi.fn(async () => transcript),
    hashProjectPath: vi.fn((p: string) => p.startsWith('/repo') ? 'project' : 'other'),
    createService: vi.fn(async () => service), writeStatus: vi.fn(),
  };
  const input = { projectPath: '/repo', transcriptPath: '/tmp/rollout.jsonl', sessionId: 'thread', throughTurnId: 'turn' };
  return { deps, service, transcript, input };
}

describe('Codex host completed-turn import', () => {
  it('imports completed user work with original clocks, closes its lightweight service, and leaves the session live', async () => {
    const { deps, service, input } = fixture();
    const result = await importCodexCompletedTurns(input, deps as unknown as CodexCompletedImportDeps);
    expect(result).toEqual({ importedPrompts: 1, importedResponses: 1, skippedDuplicates: 0, completedTurns: 1 });
    expect(service.storeUserPrompt).toHaveBeenCalledWith('thread', expect.stringContaining('Fix the data import'), expect.objectContaining({ source: 'codex', turnId: 'turn', originalTimestamp: '2026-10-04T00:00:00Z' }));
    expect(service.storeAgentResponse).toHaveBeenCalledWith('thread', expect.stringContaining('regression tests passed'), expect.objectContaining({ ingestClient: 'codex-host', originalTimestamp: '2026-10-04T00:01:00Z' }));
    expect(service.shutdown).toHaveBeenCalledOnce();
    expect(deps.writeStatus).toHaveBeenCalledWith('/repo', expect.objectContaining({ status: 'success', importedPrompts: 1, importedResponses: 1 }));
  });

  it('does not open storage for an unfinished target or mismatched project', async () => {
    const { deps, input, transcript } = fixture();
    deps.readTranscript.mockRejectedValueOnce(new Error('incomplete_turn'));
    await expect(importCodexCompletedTurns(input, deps as unknown as CodexCompletedImportDeps)).rejects.toThrow('incomplete_turn');
    transcript.turns[0].cwd = '/foreign';
    await expect(importCodexCompletedTurns(input, deps as unknown as CodexCompletedImportDeps)).rejects.toThrow('project_mismatch');
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it('does not initialize storage when no completed turns exist', async () => {
    const { deps, input, transcript } = fixture();
    transcript.turns = [];
    expect(await importCodexCompletedTurns(input, deps as unknown as CodexCompletedImportDeps)).toEqual({ importedPrompts: 0, importedResponses: 0, skippedDuplicates: 0, completedTurns: 0 });
    expect(deps.createService).not.toHaveBeenCalled();
  });

  it('keeps retries idempotent and preserves legacy normalized prompt deduplication', async () => {
    const { deps, service, input, transcript } = fixture();
    transcript.turns[0].userMessages[0] = 'If this turn corrects an earlier mistake or verifies recovery from a failure, you may propose one reusable project lesson before finishing. token="private-marker". Do not perform extra work just to generate a lesson.\n\nFix the import.';
    service.hasSessionUserPrompt.mockResolvedValue(true);
    service.storeAgentResponse.mockResolvedValue({ success: true, isDuplicate: true });
    const result = await importCodexCompletedTurns(input, deps as unknown as CodexCompletedImportDeps);
    expect(result).toMatchObject({ importedPrompts: 0, importedResponses: 0, skippedDuplicates: 2 });
    expect(service.storeUserPrompt).not.toHaveBeenCalled();
  });

  it('does not store automatic-only turns as assistant evidence', async () => {
    const { deps, service, input, transcript } = fixture();
    transcript.turns[0].userMessages = ['<task-notification>Background task finished.</task-notification>'];
    await importCodexCompletedTurns(input, deps as unknown as CodexCompletedImportDeps);
    expect(service.storeUserPrompt).not.toHaveBeenCalled();
    expect(service.storeAgentResponse).not.toHaveBeenCalled();
  });

  it('filters private assistant text before truncation and persistence', async () => {
    const { deps, service, input, transcript } = fixture();
    transcript.turns[0].assistantResponse = 'Import fixed.\n<private>fixture-private-response</private>\napi_key=fixture-credential';
    await importCodexCompletedTurns(input, deps as unknown as CodexCompletedImportDeps);
    expect(service.storeAgentResponse).toHaveBeenCalledWith('thread', expect.stringContaining('Import fixed.'), expect.any(Object));
    const stored = JSON.stringify(service.storeAgentResponse.mock.calls);
    expect(stored).not.toContain('fixture-private-response');
    expect(stored).not.toContain('fixture-credential');
  });

  it('skips separate Codex setup messages but keeps an actual request alongside them', async () => {
    const { deps, service, input, transcript } = fixture();
    const env = '<environment_context>\n<cwd>/repo</cwd>\n</environment_context>';
    const agents = '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nProject guidance.\n</INSTRUCTIONS>';
    transcript.turns[0].userMessages = [env, `${agents}${env}`];
    await importCodexCompletedTurns(input, deps as unknown as CodexCompletedImportDeps);
    expect(service.storeUserPrompt).not.toHaveBeenCalled();
    expect(service.storeAgentResponse).not.toHaveBeenCalled();
    transcript.turns[0].userMessages.push(`${env}\n\nExplain this environment and fix the import.`);
    await importCodexCompletedTurns(input, deps as unknown as CodexCompletedImportDeps);
    expect(service.storeUserPrompt).toHaveBeenCalledOnce();
    expect(service.storeUserPrompt).toHaveBeenCalledWith('thread', expect.stringContaining('Explain this environment'), expect.any(Object));
  });

  it('reports shutdown failure safely without trying to close the same service twice', async () => {
    const { deps, service, input } = fixture();
    service.shutdown.mockRejectedValueOnce(new Error('private filesystem error'));
    await expect(importCodexCompletedTurns(input, deps as unknown as CodexCompletedImportDeps)).rejects.toThrow('import_failed');
    expect(service.shutdown).toHaveBeenCalledOnce();
    expect(deps.writeStatus).toHaveBeenCalledWith('/repo', expect.objectContaining({ status: 'failed', reason: 'import_failed' }));
  });

  it('closes on append failure and never exposes raw error content in status or exceptions', async () => {
    const { deps, service, input } = fixture();
    service.storeAgentResponse.mockRejectedValue(new Error('private transcript content at /private/path'));
    await expect(importCodexCompletedTurns(input, deps as unknown as CodexCompletedImportDeps)).rejects.toThrow('import_failed');
    expect(service.shutdown).toHaveBeenCalledOnce();
    expect(JSON.stringify(deps.writeStatus.mock.calls)).not.toContain('private transcript');
    expect(deps.writeStatus).toHaveBeenCalledWith('/repo', expect.objectContaining({ status: 'failed', reason: 'import_failed' }));
  });

  it('does not turn diagnostic write failure into lost durable work', async () => {
    const { deps, input } = fixture();
    deps.writeStatus.mockImplementation(() => { throw new Error('status path denied'); });
    await expect(importCodexCompletedTurns(input, deps as unknown as CodexCompletedImportDeps)).resolves.toMatchObject({ importedResponses: 1 });
  });
});
