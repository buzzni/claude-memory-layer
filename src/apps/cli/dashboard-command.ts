import { normalizeDashboardHost } from '../server/index.js';

export interface DashboardCommandInput {
  port?: string;
  bind?: string;
  host?: string;
  password?: string;
}

export interface ResolvedDashboardCommandOptions {
  port: number;
  host: 'localhost' | '0.0.0.0';
  password?: string;
  dashboardUrl: string;
}

function parseDashboardPort(portOption: string | undefined): number {
  const normalized = (portOption ?? '37777').trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error('Invalid --port: expected a positive integer');
  }
  const port = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('Invalid --port: expected a TCP port between 1 and 65535');
  }
  return port;
}

function normalizeDashboardCommandHost(hostOption: string | undefined): 'localhost' | '0.0.0.0' {
  return normalizeDashboardHost(hostOption) === '0.0.0.0' ? '0.0.0.0' : 'localhost';
}

export function resolveDashboardCommandOptions(options: DashboardCommandInput): ResolvedDashboardCommandOptions {
  const port = parseDashboardPort(options.port);
  const host = normalizeDashboardCommandHost(options.host ?? options.bind ?? 'localhost');

  return {
    port,
    host,
    password: options.password,
    dashboardUrl: `http://localhost:${port}`
  };
}
