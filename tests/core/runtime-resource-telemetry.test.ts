import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LEGACY_RUNTIME_VERSION,
  RuntimeResourceTelemetry,
  collectRuntimeResourceReport,
  opaqueBackendId
} from '../../src/core/runtime-resource-telemetry.js';

const temporaryDirs: string[] = [];

function temporaryDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cml-runtime-telemetry-'));
  temporaryDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('runtime resource telemetry', () => {
  it('persists privacy-safe load, use, cold/hot retrieval, and release events', () => {
    const directory = temporaryDir();
    let now = Date.parse('2026-08-12T00:00:00.000Z');
    const telemetry = new RuntimeResourceTelemetry({
      telemetryDir: directory,
      now: () => now,
      pid: 101,
      ppid: 50,
      version: '2.3.0'
    });

    telemetry.registerProcess('mcp');
    now += 25;
    telemetry.recordModelLoad('embedder-1', opaqueBackendId('private/model-name'), 25);
    now += 5;
    telemetry.recordModelActivity();
    telemetry.recordRetrieval('cold', 30, true);
    now += 10;
    telemetry.recordRetrieval('hot', 10, false);
    telemetry.recordModelRelease('embedder-1', 'idle-timeout');

    const snapshot = telemetry.getSnapshot();
    expect(snapshot).toMatchObject({
      pid: 101,
      version: '2.3.0',
      client: 'mcp',
      model: {
        loaded: false,
        loadCount: 1,
        releaseCount: 1,
        lastReleaseReason: 'idle-timeout',
        useCount: 1
      },
      retrieval: {
        cold: { count: 1, failedCount: 0, totalMs: 30 },
        hot: { count: 1, failedCount: 1, totalMs: 10 }
      }
    });

    const persisted = JSON.stringify(snapshot);
    expect(persisted).toContain('sha256:');
    expect(persisted).not.toContain('private/model-name');
    expect(existsSync(path.join(directory, 'process-101.json'))).toBe(true);
  });

  it('groups instrumented and legacy processes without returning commands or paths', () => {
    const directory = temporaryDir();
    const telemetry = new RuntimeResourceTelemetry({
      telemetryDir: directory,
      pid: 101,
      ppid: 50,
      version: '2.3.0'
    });
    telemetry.registerProcess('mcp');
    telemetry.recordModelLoad('embedder-1', opaqueBackendId('model'), 40);
    telemetry.recordRetrieval('cold', 100, true);

    const report = collectRuntimeResourceReport({
      platform: 'darwin',
      telemetryDir: directory,
      localSnapshot: telemetry.getSnapshot(),
      now: () => Date.parse('2026-08-12T01:00:00.000Z'),
      readProcessTable: () => [
        '101 50 102400 /private/bin/node /private/dist/mcp/index.js --secret token-value',
        '102 1 204800 /private/bin/node /private/hooks/semantic-daemon.js',
        '103 50 4096 /private/bin/unrelated --secret other-value'
      ].join('\n')
    });

    expect(report.observation).toMatchObject({
      supported: true,
      processCount: 2,
      rssMiB: 300
    });
    expect(report.observation.groups).toEqual([
      expect.objectContaining({
        version: '2.3.0',
        client: 'mcp',
        processCount: 1,
        modelLoadedCount: 1,
        modelStateUnavailableCount: 0,
        coldRetrievalCount: 1
      }),
      expect.objectContaining({
        version: LEGACY_RUNTIME_VERSION,
        client: 'semantic-daemon',
        processCount: 1,
        orphanCount: 0,
        modelStateUnavailableCount: 1
      })
    ]);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('/private');
    expect(serialized).not.toContain('token-value');
    expect(serialized).not.toContain('other-value');
    expect(serialized).not.toContain('"pid"');
    expect(serialized).not.toContain('"ppid"');
  });

  it('degrades unsupported process metrics explicitly instead of reporting zero', () => {
    const telemetry = new RuntimeResourceTelemetry({ persist: false, pid: 201, ppid: 1 });
    const report = collectRuntimeResourceReport({
      platform: 'win32',
      localSnapshot: telemetry.getSnapshot()
    });

    expect(report.observation).toEqual({
      supported: false,
      platform: 'win32',
      reason: 'unsupported-platform',
      processCount: null,
      rssMiB: null,
      groups: []
    });
  });

  it('keeps read-only observation from creating a missing telemetry directory', () => {
    const root = temporaryDir();
    const missingDirectory = path.join(root, 'missing');
    const telemetry = new RuntimeResourceTelemetry({ persist: false });

    const report = collectRuntimeResourceReport({
      platform: 'linux',
      telemetryDir: missingDirectory,
      localSnapshot: telemetry.getSnapshot(),
      readProcessTable: () => ''
    });

    expect(report.observation.supported).toBe(true);
    expect(report.observation.processCount).toBe(0);
    expect(existsSync(missingDirectory)).toBe(false);
  });
});
