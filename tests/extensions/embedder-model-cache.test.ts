/**
 * Regression: the model cache lived inside the package's node_modules, so
 * every reinstall deleted the ~470MB model. Afterwards several processes (the
 * semantic daemon, the periodic maintenance run, MCP servers) each downloaded
 * it straight into the same file. The first one to finish read a file the
 * others were still rewriting, got "Protobuf parsing failed", deleted the
 * cache directory under them, and the cycle repeated — observed as a daemon
 * with every retrieval failing while the model was downloaded over and over.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configureTransformersCache,
  Embedder,
  resolveModelCacheDir
} from '../../src/extensions/vector/embedder.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cml-model-cache-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const loadedPipeline = async () => ({ data: new Float32Array([0.5, 0.5]) });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('model cache location', () => {
  it('lives in the memory root, which a package reinstall does not touch', () => {
    const home = tempDir();
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);

    expect(resolveModelCacheDir()).toBe(join(home, '.claude-code', 'memory', 'models'));
  });

  it('points the transformers backend at that directory', () => {
    const transformers = { pipeline: () => undefined, env: { cacheDir: '/pkg/node_modules/@huggingface/transformers/.cache/' } };

    configureTransformersCache(transformers, '/home/u/.claude-code/memory/models');

    expect(transformers.env.cacheDir).toBe('/home/u/.claude-code/memory/models');
  });
});

describe('model load serialization', () => {
  it('never lets two embedders load into the same cache at once', async () => {
    const modelCacheDir = tempDir();
    const firstLoad = deferred();
    let active = 0;
    let maxActive = 0;
    const loadPipeline = (gate?: Promise<void>) => async () => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return loadedPipeline;
    };
    const first = new Embedder('fixture/model', { loadPipeline: loadPipeline(firstLoad.promise), modelCacheDir });
    const second = new Embedder('fixture/model', { loadPipeline: loadPipeline(), modelCacheDir });

    const firstReady = first.initialize();
    const secondReady = second.initialize();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(second.isReady()).toBe(false);
    firstLoad.resolve();
    await Promise.all([firstReady, secondReady]);

    expect(maxActive).toBe(1);
    expect(first.isReady() && second.isReady()).toBe(true);
  });

  it('fails the load instead of racing when the cache stays busy', async () => {
    const modelCacheDir = tempDir();
    const firstLoad = deferred();
    const first = new Embedder('fixture/model', {
      loadPipeline: async () => async () => { await firstLoad.promise; return loadedPipeline; },
      modelCacheDir
    });
    const secondFactory = vi.fn(async () => loadedPipeline);
    const second = new Embedder('fixture/model', {
      loadPipeline: async () => secondFactory,
      modelCacheDir,
      modelLoadLockWaitMs: 20
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const firstReady = first.initialize();
    await expect(second.initialize()).rejects.toThrow(/model cache is busy/i);
    expect(secondFactory).not.toHaveBeenCalled();
    // A busy cache says nothing about the model, so it must not send the
    // waiter off to download the fallback model instead.
    expect(warn).not.toHaveBeenCalled();

    firstLoad.resolve();
    await firstReady;
  });

  it('releases the cache after a failed load so the next attempt can run', async () => {
    const modelCacheDir = tempDir();
    const failing = new Embedder('fixture/model', {
      loadPipeline: async () => async () => { throw new Error('fetch failed'); },
      modelCacheDir
    });
    await expect(failing.initialize()).rejects.toThrow('fetch failed');

    const next = new Embedder('fixture/model', { loadPipeline: async () => async () => loadedPipeline, modelCacheDir });
    await next.initialize();

    expect(next.isReady()).toBe(true);
  });

  it('clears a corrupted model and reloads it while still holding the cache', async () => {
    const modelCacheDir = tempDir();
    const modelDir = join(modelCacheDir, 'fixture', 'model', 'onnx');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'model.onnx'), 'truncated');
    let otherLoads = 0;
    const other = new Embedder('fixture/model', {
      loadPipeline: async () => async () => { otherLoads += 1; return loadedPipeline; },
      modelCacheDir
    });
    let attempts = 0;
    let otherReady: Promise<void> | undefined;
    const recovering = new Embedder('fixture/model', {
      loadPipeline: async () => async () => {
        attempts += 1;
        if (attempts === 1) {
          otherReady = other.initialize();
          throw new Error('Load model from /cache/model.onnx failed:Protobuf parsing failed.');
        }
        // The retry runs before anyone else was let in to start a download.
        expect(otherLoads).toBe(0);
        expect(existsSync(join(modelCacheDir, 'fixture', 'model'))).toBe(false);
        return loadedPipeline;
      },
      modelCacheDir
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await recovering.initialize();
    await otherReady;

    expect(attempts).toBe(2);
    expect(otherLoads).toBe(1);
  });
});
