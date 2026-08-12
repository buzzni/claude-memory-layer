import { describe, expect, it } from 'vitest';

import {
  formatRuntimeResourceJsonReport,
  formatRuntimeResourceReport
} from '../../src/apps/cli/runtime-resource-command.js';
import { RuntimeResourceTelemetry, collectRuntimeResourceReport } from '../../src/core/runtime-resource-telemetry.js';

describe('runtime resource command output', () => {
  it('renders aggregate model/process status in text and JSON without process identities', () => {
    const telemetry = new RuntimeResourceTelemetry({ persist: false, pid: 101, ppid: 50, version: '2.3.0' });
    const report = collectRuntimeResourceReport({
      platform: 'darwin',
      localSnapshot: telemetry.getSnapshot(),
      readProcessTable: () => '101 50 102400 node /safe/dist/mcp/index.js'
    });

    const text = formatRuntimeResourceReport(report);
    const json = formatRuntimeResourceJsonReport(report);

    expect(text).toContain('Runtime resource status');
    expect(text).toContain('Aggregate RSS: 100 MiB');
    expect(json).toContain('"processCount": 1');
    expect(json).not.toContain('"pid"');
    expect(json).not.toContain('"ppid"');
    expect(json).not.toContain('/safe');
  });
});
