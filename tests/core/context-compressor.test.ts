import { describe, expect, it } from 'vitest';

import {
  ContextCompressor,
  detectContextContentType,
  summarizeCompressionTelemetry
} from '../../src/core/context-compressor.js';

describe('ContextCompressor', () => {
  it('routes log-like tool output to signal-preserving compression with per-source metadata', () => {
    const noisyLog = [
      ...Array.from({ length: 35 }, (_, index) => `heartbeat ${index}: cache warm`),
      'ERROR payment sync failed after retry budget exhausted',
      'Traceback: src/payments/sync.ts:42 root cause frame',
      'Resolved by retrying with the new vector outbox lock',
      'tail status: smoke ready'
    ].join('\n');

    const compressor = new ContextCompressor();
    const result = compressor.compress(noisyLog, {
      mode: 'safe',
      source: 'hermes',
      metadata: { eventType: 'tool_observation', contentType: 'text/x-log' }
    });

    expect(result.metadata).toMatchObject({
      mode: 'safe',
      source: 'hermes',
      contentType: 'log',
      strategy: 'log_signal',
      originalChars: noisyLog.length,
      signalCount: 3
    });
    expect(result.metadata.compressedChars).toBe(result.text.length);
    expect(result.metadata.compressedChars).toBeLessThan(result.metadata.originalChars);
    expect(result.metadata.omittedLines).toBeGreaterThan(20);
    expect(result.text).toContain('ERROR payment sync failed');
    expect(result.text).toContain('Traceback: src/payments/sync.ts:42');
    expect(result.text).toContain('tail status: smoke ready');
    expect(result.text).not.toContain('heartbeat 34');
  });

  it('routes markdown memory cards to outline compression instead of log heuristics', () => {
    const markdown = [
      '# Goal',
      'Improve context-pack compression in claude-memory-layer.',
      '',
      'This paragraph is intentionally verbose and low-signal filler that should not dominate the compressed preview.',
      '',
      '## Decisions',
      '- Decision: keep Headroom as an optional benchmark only.',
      '- Constraint: privacy filtering must run before compression.',
      '',
      '## Next Actions',
      '- Next: add a native ContextCompressor seam.',
      '- Verify: run focused MCP context-pack tests.'
    ].join('\n');

    const compressor = new ContextCompressor();
    const result = compressor.compress(markdown, {
      mode: 'safe',
      source: 'codex',
      metadata: { contentType: 'text/markdown' }
    });

    expect(result.metadata).toMatchObject({
      source: 'codex',
      contentType: 'markdown',
      strategy: 'markdown_outline'
    });
    expect(result.text).toContain('# Goal');
    expect(result.text).toContain('## Decisions');
    expect(result.text).toContain('- Decision: keep Headroom as an optional benchmark only.');
    expect(result.text).toContain('- Next: add a native ContextCompressor seam.');
    expect(result.text).not.toContain('intentionally verbose and low-signal filler');
  });

  it('detects content type from explicit metadata, event type, and content cues', () => {
    expect(detectContextContentType('plain text', { contentType: 'text/markdown' })).toBe('markdown');
    expect(detectContextContentType('INFO ok\nERROR failed', { eventType: 'tool_observation' })).toBe('log');
    expect(detectContextContentType('diff --git a/a.ts b/a.ts\n+added', {})).toBe('diff');
    expect(detectContextContentType('function run() {\n  return 1;\n}', {})).toBe('code');
    expect(detectContextContentType('A short conversation summary.', {})).toBe('plain');
  });

  it('treats text/plain tool observations as logs when signal lines would otherwise be dropped', () => {
    const toolOutput = [
      ...Array.from({ length: 18 }, (_, index) => `progress ${index}: ok`),
      'ERROR text/plain tool output failed in the middle',
      'Traceback: middle frame should remain visible',
      'tail: final status'
    ].join('\n');

    const compressor = new ContextCompressor();
    const result = compressor.compress(toolOutput, {
      mode: 'safe',
      source: 'tool',
      metadata: { eventType: 'tool_observation', contentType: 'text/plain' }
    });

    expect(result.metadata.contentType).toBe('log');
    expect(result.metadata.strategy).toBe('log_signal');
    expect(result.text).toContain('ERROR text/plain tool output failed in the middle');
    expect(result.text).toContain('Traceback: middle frame should remain visible');
    expect(result.text).not.toContain('progress 17: ok');
  });

  it('reports no-signal log omittedLines based on emitted head and tail lines', () => {
    const noSignalLog = Array.from({ length: 20 }, (_, index) => `progress ${index}: ok`).join('\n');

    const compressor = new ContextCompressor();
    const result = compressor.compress(noSignalLog, {
      mode: 'safe',
      source: 'tool',
      metadata: { contentType: 'text/x-log' }
    });

    expect(result.metadata.strategy).toBe('log_signal');
    expect(result.text).toContain('Head: progress 0: ok | progress 1: ok');
    expect(result.text).toContain('Tail: progress 18: ok | progress 19: ok');
    expect(result.metadata.omittedLines).toBe(16);
    expect(result.text).toContain('omittedLines=16');
  });

  it('compresses diff, code, and markdown fixtures deterministically with re-expand source refs', () => {
    const fixtures = [
      {
        contentType: 'text/x-diff',
        signal: '+export function preserveSourceRefs() {',
        content: [
          'diff --git a/src/context.ts b/src/context.ts',
          '--- a/src/context.ts',
          '+++ b/src/context.ts',
          '@@ -1,5 +1,7 @@',
          '-export function oldPreview() {',
          '+export function preserveSourceRefs() {',
          '+  return "mem-source-ref";',
          ...Array.from({ length: 35 }, (_, index) => ` context filler ${index}`)
        ].join('\n')
      },
      {
        contentType: 'text/typescript',
        signal: 'export function preserveSourceRefs()',
        content: [
          'import { generateCitationId } from "./citation-generator.js";',
          'export interface CompressionInput { sourceRef: string; }',
          'export function preserveSourceRefs() {',
          '  return "mem-source-ref";',
          '}',
          ...Array.from({ length: 35 }, (_, index) => `const lowSignal${index} = ${index};`)
        ].join('\n')
      },
      {
        contentType: 'text/markdown',
        signal: '- Decision: preserve citation IDs in compressed previews.',
        content: [
          '# Compression Plan',
          'Long intro paragraph that should not dominate the compressed preview.',
          '## Decisions',
          '- Decision: preserve citation IDs in compressed previews.',
          '- Constraint: privacy filtering runs before compression.',
          '## Next',
          '- Next: expand full source via mem-source-ref.',
          ...Array.from({ length: 35 }, (_, index) => `low signal paragraph ${index}`)
        ].join('\n')
      }
    ];

    const compressor = new ContextCompressor();

    for (const fixture of fixtures) {
      const first = compressor.compress(fixture.content, {
        mode: 'safe',
        source: 'hermes',
        sourceRef: 'mem:abc123',
        metadata: { contentType: fixture.contentType }
      });
      const second = compressor.compress(fixture.content, {
        mode: 'safe',
        source: 'hermes',
        sourceRef: 'mem:abc123',
        metadata: { contentType: fixture.contentType }
      });

      expect(first.text).toEqual(second.text);
      expect(first.text).toContain('sourceRef=mem:abc123');
      expect(first.text).toContain('expand=mem-source-ref');
      expect(first.text).toContain(fixture.signal);
      expect(first.metadata.sourceRefPreserved).toBe(true);
      expect(first.metadata.omittedLines).toBeGreaterThan(0);
      expect(first.metadata.compressedChars).toBeLessThan(first.metadata.originalChars);
    }
  });

  it('keeps non-compressed mode backward compatible while retaining source-ref metadata', () => {
    const content = 'ERROR keep the original text exactly as it was provided';

    const compressor = new ContextCompressor();
    const result = compressor.compress(content, {
      mode: 'off',
      source: 'hermes',
      sourceRef: 'mem:abc123',
      metadata: { contentType: 'text/x-log' }
    });

    expect(result.text).toBe(content);
    expect(result.text).not.toContain('expand=mem-source-ref');
    expect(result.metadata).toMatchObject({
      mode: 'off',
      source: 'hermes',
      contentType: 'log',
      strategy: 'none',
      sourceRef: 'mem:abc123',
      sourceRefPreserved: false,
      originalChars: content.length,
      compressedChars: content.length,
      savedChars: 0,
      omittedLines: 0
    });
  });

  it('summarizes aggregate compression telemetry without raw content', () => {
    const compressor = new ContextCompressor();
    const log = Array.from({ length: 30 }, (_, index) => `noise ${index}`).concat('ERROR important').join('\n');
    const markdown = ['# Plan', '- Decision: native compressor', '- Next: telemetry'].join('\n');

    const first = compressor.compress(log, {
      mode: 'safe',
      source: 'hermes',
      metadata: { eventType: 'tool_observation' }
    });
    const second = compressor.compress(markdown, {
      mode: 'safe',
      source: 'codex',
      metadata: { contentType: 'markdown' }
    });

    const summary = summarizeCompressionTelemetry([first.metadata, second.metadata]);

    expect(summary.totalItems).toBe(2);
    expect(summary.totalOriginalChars).toBe(first.metadata.originalChars + second.metadata.originalChars);
    expect(summary.totalCompressedChars).toBe(first.metadata.compressedChars + second.metadata.compressedChars);
    expect(summary.totalSavedChars).toBe(first.metadata.savedChars + second.metadata.savedChars);
    expect(summary.totalSavedChars).toBe(summary.bySource.reduce((sum, item) => sum + item.savedChars, 0));
    expect(summary.sourceRefsPreserved).toBe(0);
    expect(summary.totalOmittedLines).toBe(first.metadata.omittedLines + second.metadata.omittedLines);
    expect(summary.bySource).toEqual([
      expect.objectContaining({ source: 'codex', items: 1 }),
      expect.objectContaining({ source: 'hermes', items: 1 })
    ]);
    expect(summary.byStrategy).toEqual([
      expect.objectContaining({ strategy: 'log_signal', items: 1 }),
      expect.objectContaining({ strategy: 'markdown_outline', items: 1 })
    ]);
    expect(JSON.stringify(summary)).not.toContain('ERROR important');
    expect(JSON.stringify(summary)).not.toContain('Decision: native compressor');
  });
});
