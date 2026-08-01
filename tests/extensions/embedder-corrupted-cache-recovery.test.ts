import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { clearModelCacheDirectory, isCorruptedModelCacheError } from '../../src/extensions/vector/embedder.js';

describe('isCorruptedModelCacheError', () => {
  it('recognizes the real ONNX load failure text', () => {
    // The exact message observed on a real machine after a global npm
    // install left a truncated model file behind.
    const real = new Error(
      'Load model from /path/to/model.onnx failed:Protobuf parsing failed.'
    );
    expect(isCorruptedModelCacheError(real)).toBe(true);
  });

  it('recognizes other onnxruntime/protobuf failure shapes', () => {
    expect(isCorruptedModelCacheError(new Error('INVALID_PROTOBUF: bad data'))).toBe(true);
    expect(isCorruptedModelCacheError(new Error('OnnxRuntimeError: something broke'))).toBe(true);
  });

  it('does not treat an ordinary missing-file or network error as corruption', () => {
    // These must surface as-is: clearing a cache directory would not fix
    // a network outage, and could delete a model that simply isn't
    // downloaded yet for an unrelated reason.
    expect(isCorruptedModelCacheError(new Error('fetch failed'))).toBe(false);
    expect(isCorruptedModelCacheError(new Error('ENOENT: no such file or directory'))).toBe(false);
    expect(isCorruptedModelCacheError(new Error('getaddrinfo ENOTFOUND huggingface.co'))).toBe(false);
  });
});

describe('clearModelCacheDirectory', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function withCacheDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cml-embedder-cache-'));
    tempDirs.push(dir);
    return dir;
  }

  it('deletes only the named model directory', async () => {
    const cacheDir = withCacheDir();
    const target = join(cacheDir, 'Xenova', 'multilingual-e5-small', 'onnx');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'model.onnx'), 'truncated');

    const sibling = join(cacheDir, 'Xenova', 'other-model');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'config.json'), '{}');

    const result = await clearModelCacheDirectory('Xenova/multilingual-e5-small', cacheDir);

    expect(result).toBe(true);
    expect(existsSync(join(cacheDir, 'Xenova', 'multilingual-e5-small'))).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  it('is a safe no-op-with-false-return when the model directory does not exist', async () => {
    const cacheDir = withCacheDir();
    const result = await clearModelCacheDirectory('Xenova/never-downloaded', cacheDir);
    // fs.rm with force:true does not error on a missing path, so this
    // reports success — there is simply nothing left to clear.
    expect(result).toBe(true);
  });

  it('refuses to delete outside the resolved cache directory', async () => {
    const cacheDir = withCacheDir();
    const outside = mkdtempSync(join(tmpdir(), 'cml-embedder-outside-'));
    tempDirs.push(outside);
    writeFileSync(join(outside, 'do-not-delete.txt'), 'x');

    // A model name is always a repo id like "org/model"; this simulates a
    // pathological value trying to escape the cache directory.
    const escaping = `../${outside.split('/').pop()}`;
    const result = await clearModelCacheDirectory(escaping, cacheDir);

    expect(result).toBe(false);
    expect(existsSync(join(outside, 'do-not-delete.txt'))).toBe(true);
  });

  it('returns false when no cache directory is available', async () => {
    const result = await clearModelCacheDirectory('Xenova/multilingual-e5-small', '');
    expect(result).toBe(false);
  });
});
