import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildLaunchdPlist,
  buildSystemdUnits,
  getMaintenanceSchedulerPaths,
  installMaintenanceScheduler,
  parseMaintenanceInterval,
  uninstallMaintenanceScheduler
} from '../../src/apps/cli/maintenance-scheduler.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cml-maintenance-scheduler-'));
  tempDirs.push(dir);
  return dir;
}

function makeExecutables(root: string): { nodePath: string; cliPath: string } {
  const nodePath = path.join(root, 'node');
  const cliPath = path.join(root, 'cli', 'index.js');
  writeFileSync(nodePath, 'node');
  writeFileSync(cliPath, 'cli');
  return { nodePath, cliPath };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('maintenance scheduler', () => {
  it('validates bounded scheduler intervals', () => {
    expect(parseMaintenanceInterval(undefined)).toBe(300);
    expect(parseMaintenanceInterval('600')).toBe(600);
    expect(() => parseMaintenanceInterval('invalid')).toThrow('between 60 and 86400');
    expect(() => parseMaintenanceInterval(300.5)).toThrow('between 60 and 86400');
    expect(() => parseMaintenanceInterval('59')).toThrow('between 60 and 86400');
    expect(() => parseMaintenanceInterval('86401')).toThrow('between 60 and 86400');
  });

  it('renders launchd and systemd definitions with absolute command arguments', () => {
    const plist = buildLaunchdPlist({
      nodePath: '/opt/node & tools/node',
      cliPath: '/opt/cml/index.js',
      intervalSeconds: 300,
      logPath: '/tmp/cml.log'
    });
    expect(plist).toContain('<integer>300</integer>');
    expect(plist).toContain('/opt/node &amp; tools/node');
    expect(plist).toContain('<string>maintenance</string>');
    expect(plist).toContain('<string>run</string>');
    expect(plist).toContain('<string>--quiet</string>');

    const units = buildSystemdUnits({
      nodePath: '/opt/node path/node',
      cliPath: '/opt/cml/index.js',
      intervalSeconds: 900
    });
    expect(units.service).toContain('ExecStart="/opt/node path/node" "/opt/cml/index.js" "maintenance" "run" "--quiet"');
    expect(units.timer).toContain('OnUnitActiveSec=900s');
    expect(units.timer).toContain('Persistent=true');
  });

  it('installs and uninstalls an explicit macOS LaunchAgent without touching memory data', () => {
    const homeDir = makeTempDir();
    const binDir = path.join(homeDir, 'bin');
    const cliDir = path.join(binDir, 'cli');
    requireDirectories(binDir, cliDir);
    const executable = makeExecutables(binDir);
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner = ((command: string, args: readonly string[]) => {
      calls.push({ command, args });
      if (args.includes('bootout')) throw new Error('not loaded');
      return Buffer.from('ok');
    }) as typeof import('node:child_process').execFileSync;

    const installed = installMaintenanceScheduler({
      platform: 'darwin',
      homeDir,
      intervalSeconds: 300,
      uid: 501,
      ...executable
    }, { execFileSync: runner });

    expect(installed).toMatchObject({ platform: 'darwin', installed: true, active: true });
    const [plistPath] = getMaintenanceSchedulerPaths('darwin', homeDir).definitionPaths;
    expect(readFileSync(plistPath, 'utf8')).toContain(executable.cliPath);
    expect(calls.some((call) => call.command === 'launchctl' && call.args.includes('bootstrap'))).toBe(true);

    const removed = uninstallMaintenanceScheduler({ platform: 'darwin', homeDir, uid: 501 }, { execFileSync: runner });
    expect(removed).toMatchObject({ installed: false, active: false });
    expect(existsSync(plistPath)).toBe(false);
  });

  it('installs a Linux systemd user timer and enables it without sudo', () => {
    const homeDir = makeTempDir();
    const binDir = path.join(homeDir, 'bin');
    const cliDir = path.join(binDir, 'cli');
    requireDirectories(binDir, cliDir);
    const executable = makeExecutables(binDir);
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner = ((command: string, args: readonly string[]) => {
      calls.push({ command, args });
      return Buffer.from('ok');
    }) as typeof import('node:child_process').execFileSync;

    const installed = installMaintenanceScheduler({
      platform: 'linux',
      homeDir,
      intervalSeconds: 600,
      ...executable
    }, { execFileSync: runner });

    expect(installed).toMatchObject({ platform: 'linux', installed: true, active: true });
    const [servicePath, timerPath] = getMaintenanceSchedulerPaths('linux', homeDir).definitionPaths;
    expect(readFileSync(servicePath, 'utf8')).toContain('Type=oneshot');
    expect(readFileSync(timerPath, 'utf8')).toContain('OnUnitActiveSec=600s');
    expect(calls).toContainEqual({ command: 'systemctl', args: ['--user', 'enable', 'claude-memory-layer-maintenance.timer'] });
    expect(calls).toContainEqual({ command: 'systemctl', args: ['--user', 'restart', 'claude-memory-layer-maintenance.timer'] });
    expect(calls.some((call) => call.command === 'sudo')).toBe(false);
  });

  it('restores the previous scheduler definition when OS registration fails', () => {
    const homeDir = makeTempDir();
    const binDir = path.join(homeDir, 'bin');
    const cliDir = path.join(binDir, 'cli');
    requireDirectories(binDir, cliDir);
    const executable = makeExecutables(binDir);
    const [plistPath] = getMaintenanceSchedulerPaths('darwin', homeDir).definitionPaths;
    requireDirectories(path.dirname(plistPath));
    writeFileSync(plistPath, 'PREVIOUS_PLIST');
    const runner = ((_command: string, args: readonly string[]) => {
      if (args.includes('bootstrap')) throw new Error('registration failed');
      return Buffer.from('ok');
    }) as typeof import('node:child_process').execFileSync;

    expect(() => installMaintenanceScheduler({
      platform: 'darwin',
      homeDir,
      intervalSeconds: 300,
      uid: 501,
      ...executable
    }, { execFileSync: runner })).toThrow('Could not register');
    expect(readFileSync(plistPath, 'utf8')).toBe('PREVIOUS_PLIST');
  });

  it('disables a newly enabled Linux timer when registration rolls back', () => {
    const homeDir = makeTempDir();
    const binDir = path.join(homeDir, 'bin');
    const cliDir = path.join(binDir, 'cli');
    requireDirectories(binDir, cliDir);
    const executable = makeExecutables(binDir);
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner = ((command: string, args: readonly string[]) => {
      calls.push({ command, args });
      if (args.includes('restart')) throw new Error('start failed');
      return Buffer.from('ok');
    }) as typeof import('node:child_process').execFileSync;

    expect(() => installMaintenanceScheduler({
      platform: 'linux',
      homeDir,
      intervalSeconds: 300,
      ...executable
    }, { execFileSync: runner })).toThrow('Could not register');

    const definitionPaths = getMaintenanceSchedulerPaths('linux', homeDir).definitionPaths;
    expect(definitionPaths.every((file) => !existsSync(file))).toBe(true);
    expect(calls).toContainEqual({
      command: 'systemctl',
      args: ['--user', 'disable', '--now', 'claude-memory-layer-maintenance.timer']
    });
  });
});

function requireDirectories(...dirs: string[]): void {
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
}
