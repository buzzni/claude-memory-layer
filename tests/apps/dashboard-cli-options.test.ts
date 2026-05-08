import { describe, expect, it } from 'vitest';

import { resolveDashboardCommandOptions } from '../../src/apps/cli/dashboard-command.js';

describe('dashboard CLI option resolution', () => {
  it('defaults to localhost bind without a dashboard password', () => {
    expect(resolveDashboardCommandOptions({ port: '37777' })).toEqual({
      port: 37777,
      host: 'localhost',
      password: undefined,
      dashboardUrl: 'http://localhost:37777'
    });
  });

  it('supports explicit 0.0.0.0 bind and password options', () => {
    expect(resolveDashboardCommandOptions({ port: '38888', bind: '0.0.0.0', password: 'pw' })).toEqual({
      port: 38888,
      host: '0.0.0.0',
      password: 'pw',
      dashboardUrl: 'http://localhost:38888'
    });
  });

  it('also supports --host as an alias for --bind', () => {
    expect(resolveDashboardCommandOptions({ port: '38888', host: '0.0.0.0' }).host).toBe('0.0.0.0');
  });

  it('lets an explicit --host override Commander\'s default --bind value', () => {
    expect(resolveDashboardCommandOptions({ port: '38888', bind: 'localhost', host: '0.0.0.0' }).host).toBe('0.0.0.0');
  });

  it('rejects unsupported bind values', () => {
    expect(() => resolveDashboardCommandOptions({ bind: '192.168.0.10' })).toThrow(/Invalid dashboard host/);
  });

  it('rejects unsupported --host alias values even when Commander supplies the default --bind value', () => {
    expect(() => resolveDashboardCommandOptions({ bind: 'localhost', host: '192.168.0.10' })).toThrow(/Invalid dashboard host/);
  });
});
