import { describe, expect, it } from 'vitest';
import * as os from 'os';

import { machineFingerprint } from '../../src/core/machine-id.js';

describe('machineFingerprint', () => {
  it('is a stable hash that does not reveal the machine id or hostname', () => {
    const fingerprint = machineFingerprint();
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(machineFingerprint()).toBe(fingerprint);
    expect(fingerprint).not.toContain(os.hostname().toLowerCase());
  });
});
