import { describe, expect, it, vi } from 'vitest';

import { Embedder, type EmbeddingLifecycleTelemetry } from '../../src/extensions/vector/embedder.js';

function telemetryMock(): EmbeddingLifecycleTelemetry {
  return {
    recordModelLoad: vi.fn(),
    recordModelLoadFailure: vi.fn(),
    recordModelActivity: vi.fn(),
    recordModelRelease: vi.fn(),
    recordModelReleaseFailure: vi.fn()
  };
}

describe('Embedder lifecycle telemetry', () => {
  it('deduplicates concurrent cold loads and records load/use/release lifecycle', async () => {
    let now = 0;
    const telemetry = telemetryMock();
    const dispose = vi.fn(async () => undefined);
    const pipeline = Object.assign(
      async () => ({ data: new Float32Array([0.25, 0.75]) }),
      { dispose }
    );
    const pipelineFactory = vi.fn(async () => pipeline);
    const loadPipeline = vi.fn(async () => pipelineFactory);
    const embedder = new Embedder('fixture/model', {
      telemetry,
      now: () => now,
      loadPipeline
    });

    const first = embedder.initialize();
    const second = embedder.initialize();
    now = 25;
    await Promise.all([first, second]);

    expect(loadPipeline).toHaveBeenCalledOnce();
    expect(pipelineFactory).toHaveBeenCalledOnce();
    expect(telemetry.recordModelLoad).toHaveBeenCalledWith(
      expect.stringMatching(/^embedder-/),
      expect.stringMatching(/^sha256:/),
      25
    );

    await expect(embedder.embed('hello')).resolves.toMatchObject({ dimensions: 2 });
    expect(telemetry.recordModelActivity).toHaveBeenCalledOnce();

    await embedder.dispose('idle-timeout');
    expect(dispose).toHaveBeenCalledOnce();
    expect(telemetry.recordModelRelease).toHaveBeenCalledWith(
      expect.stringMatching(/^embedder-/),
      'idle-timeout'
    );
  });

  it('records failed model loads without exposing backend error details', async () => {
    let now = 10;
    const telemetry = telemetryMock();
    const embedder = new Embedder('fixture/model', {
      telemetry,
      now: () => now,
      loadPipeline: async () => {
        now = 45;
        throw new Error('private backend path');
      }
    });

    await expect(embedder.initialize()).rejects.toThrow('private backend path');
    expect(telemetry.recordModelLoadFailure).toHaveBeenCalledWith(35);
    expect(telemetry.recordModelLoad).not.toHaveBeenCalled();
  });
});
