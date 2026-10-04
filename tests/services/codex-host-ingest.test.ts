import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importCodexCompletedTurns, readCodexCompletedTurns, type CodexCompletedImportDeps } from '../../src/services/codex-host-ingest.js';
import { createCodexSessionHistoryImporter } from '../../src/services/codex-session-history-importer.js';
import { hashProjectPath } from '../../src/core/registry/project-path.js';
import { createSQLiteDatabase, sqliteAll, sqliteClose } from '../../src/core/sqlite-wrapper.js';

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
  it.each([1, 1000])('keeps persisted original/derived source clocks consistent for native time scale %s', async (scale) => {
    const root = await mkdtemp(join(tmpdir(), 'cml-host-clock-'));
    const store = join(root, 'store');
    const file = join(root, 'rollout.jsonl');
    const startedAt = '2025-01-01T00:00:00.000Z';
    const completedAt = '2025-01-01T00:00:01.000Z';
    const message = (role: string, text: string) => ({ type: 'response_item', payload: {
      type: 'message', role, content: [{ type: 'input_text', text }], ...(role === 'assistant' ? { phase: 'final_answer' } : {})
    } });
    try {
      await writeFile(file, [
        { type: 'session_meta', payload: { id: 'clock-thread', cwd: root } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'clock-turn', started_at: Date.parse(startedAt) / scale } },
        message('user', 'Verify source clock persistence.'), message('assistant', 'Source clock persistence verified.'),
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'clock-turn', completed_at: Date.parse(completedAt) / scale } }
      ].map(row => JSON.stringify(row)).join('\n'));
      const { MemoryService, DISABLED_SHARED_STORE_CONFIG } = await import('../../src/services/memory-service.js');
      const deps: CodexCompletedImportDeps = { readTranscript: readCodexCompletedTurns, hashProjectPath, writeStatus: () => {},
        createService: async () => new MemoryService({ storagePath: store, projectPath: root, projectHash: hashProjectPath(root),
          lightweightMode: true, analyticsEnabled: false, sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG }) };
      const input = { projectPath: root, transcriptPath: file, sessionId: 'clock-thread', throughTurnId: 'clock-turn' };
      await importCodexCompletedTurns(input, deps);
      expect(await importCodexCompletedTurns(input, deps)).toMatchObject({ importedPrompts: 0, importedResponses: 0, skippedDuplicates: 2 });
      const db = createSQLiteDatabase(join(store, 'events.sqlite'), { readonly: true });
      try {
        const rows = sqliteAll<{ event_type: string; metadata: string }>(db, 'SELECT event_type, metadata FROM events');
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          const metadata = JSON.parse(row.metadata);
          const expected = row.event_type === 'user_prompt' ? startedAt : completedAt;
          expect(metadata.originalTimestamp).toBe(expected);
          expect(metadata.ingest.occurredAt).toBe(expected);
          expect(metadata.ingest.sourceLagMs).toBe(Date.parse(metadata.ingest.ingestedAt) - Date.parse(expected));
        }
      } finally { sqliteClose(db); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not replay a complete host turn through the legacy importer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cml-host-legacy-'));
    const store = join(root, 'store');
    const file = join(root, 'rollout.jsonl');
    const message = (role: string, text: string, phase?: string) => ({ type: 'response_item', payload: {
      type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
      ...(phase ? { phase } : {})
    } });
    const records = [
      { type: 'session_meta', payload: { id: 'host-legacy-thread', cwd: root } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nfixture\n</INSTRUCTIONS>\n<environment_context>\n<cwd>/repo</cwd>\n</environment_context>' }] } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'native-turn', started_at: 1_790_000_000 } },
      message('user', 'Keep only one durable completed turn.'),
      message('assistant', 'The completed turn is already stored by the host.', 'final_answer'),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'native-turn', completed_at: 1_790_000_001 } }
    ];
    try {
      await writeFile(file, records.map(row => JSON.stringify(row)).join('\n'));
      const { MemoryService, DISABLED_SHARED_STORE_CONFIG } = await import('../../src/services/memory-service.js');
      const deps: CodexCompletedImportDeps = {
        readTranscript: readCodexCompletedTurns,
        hashProjectPath,
        writeStatus: () => {},
        createService: async () => new MemoryService({ storagePath: store, projectPath: root,
          projectHash: hashProjectPath(root), lightweightMode: true, analyticsEnabled: false,
          sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG })
      };
      const input = { projectPath: root, transcriptPath: file, sessionId: 'host-legacy-thread', throughTurnId: 'native-turn' };
      await importCodexCompletedTurns(input, deps);

      const service = new MemoryService({ storagePath: store, projectPath: root,
        projectHash: hashProjectPath(root), lightweightMode: true, analyticsEnabled: false,
        sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG });
      try {
        const legacy = await createCodexSessionHistoryImporter(service, { sessionsDir: root });
        const result = await legacy.importSessionFile(file, { force: true });
        expect(result.importedPrompts).toBe(0);
        expect(result.importedResponses).toBe(0);
        const events = await service.getSessionHistory('host-legacy-thread');
        expect(events).toHaveLength(2);
        expect(events.map(event => event.metadata?.ingestClient)).toEqual(['codex-host', 'codex-host']);
      } finally {
        await service.shutdown();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
