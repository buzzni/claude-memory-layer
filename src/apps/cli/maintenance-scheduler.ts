import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const MAINTENANCE_LABEL = 'com.claude-memory-layer.maintenance';
export const DEFAULT_MAINTENANCE_INTERVAL_SECONDS = 300;
export const MIN_MAINTENANCE_INTERVAL_SECONDS = 60;

export type MaintenancePlatform = 'darwin' | 'linux';

export interface MaintenanceSchedulerPaths {
  platform: MaintenancePlatform;
  definitionPaths: string[];
  logPath: string;
}

export interface MaintenanceSchedulerStatus {
  platform: MaintenancePlatform;
  installed: boolean;
  active: boolean;
  definitionPaths: string[];
  logPath: string;
}

export interface MaintenanceSchedulerOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  intervalSeconds?: number;
  nodePath: string;
  cliPath: string;
  uid?: number;
}

export interface MaintenanceSchedulerDeps {
  execFileSync?: typeof execFileSync;
}

export function parseMaintenanceInterval(value: string | number | undefined): number {
  if (value === undefined) return DEFAULT_MAINTENANCE_INTERVAL_SECONDS;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isSafeInteger(parsed)
    || parsed < MIN_MAINTENANCE_INTERVAL_SECONDS
    || parsed > 86400) {
    throw new Error(`maintenance interval must be between ${MIN_MAINTENANCE_INTERVAL_SECONDS} and 86400 seconds`);
  }
  return parsed;
}

export function resolveMaintenancePlatform(platform: NodeJS.Platform = process.platform): MaintenancePlatform {
  if (platform === 'darwin' || platform === 'linux') return platform;
  throw new Error(`maintenance scheduling is not supported on ${platform}; use "claude-memory-layer maintenance run" from your scheduler`);
}

export function getMaintenanceSchedulerPaths(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir()
): MaintenanceSchedulerPaths {
  const supported = resolveMaintenancePlatform(platform);
  const logPath = path.join(homeDir, '.claude-code', 'memory', 'logs', 'maintenance.log');
  if (supported === 'darwin') {
    return {
      platform: supported,
      definitionPaths: [path.join(homeDir, 'Library', 'LaunchAgents', `${MAINTENANCE_LABEL}.plist`)],
      logPath
    };
  }
  return {
    platform: supported,
    definitionPaths: [
      path.join(homeDir, '.config', 'systemd', 'user', 'claude-memory-layer-maintenance.service'),
      path.join(homeDir, '.config', 'systemd', 'user', 'claude-memory-layer-maintenance.timer')
    ],
    logPath
  };
}

export function buildLaunchdPlist(input: {
  nodePath: string;
  cliPath: string;
  intervalSeconds: number;
  logPath: string;
}): string {
  const args = [input.nodePath, input.cliPath, 'maintenance', 'run', '--quiet'];
  const argXml = args.map((arg) => `      <string>${escapeXml(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${MAINTENANCE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${input.intervalSeconds}</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(input.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(input.logPath)}</string>
  </dict>
</plist>
`;
}

export function buildSystemdUnits(input: {
  nodePath: string;
  cliPath: string;
  intervalSeconds: number;
}): { service: string; timer: string } {
  const execStart = [input.nodePath, input.cliPath, 'maintenance', 'run', '--quiet']
    .map(systemdQuote)
    .join(' ');
  return {
    service: `[Unit]
Description=Claude Memory Layer maintenance

[Service]
Type=oneshot
ExecStart=${execStart}
Nice=10

[Install]
WantedBy=default.target
`,
    timer: `[Unit]
Description=Run Claude Memory Layer maintenance periodically

[Timer]
OnBootSec=2min
OnUnitActiveSec=${input.intervalSeconds}s
RandomizedDelaySec=30s
Persistent=true
Unit=claude-memory-layer-maintenance.service

[Install]
WantedBy=timers.target
`
  };
}

export function installMaintenanceScheduler(
  options: MaintenanceSchedulerOptions,
  deps: MaintenanceSchedulerDeps = {}
): MaintenanceSchedulerStatus {
  const platform = resolveMaintenancePlatform(options.platform);
  const homeDir = options.homeDir ?? os.homedir();
  const intervalSeconds = parseMaintenanceInterval(options.intervalSeconds);
  validateExecutablePath(options.nodePath, 'Node executable');
  validateExecutablePath(options.cliPath, 'CLI entrypoint');
  const paths = getMaintenanceSchedulerPaths(platform, homeDir);
  fs.mkdirSync(path.dirname(paths.logPath), { recursive: true });
  const previousDefinitions = snapshotDefinitions(paths.definitionPaths);

  if (platform === 'darwin') {
    const [plistPath] = paths.definitionPaths;
    writeAtomic(plistPath, buildLaunchdPlist({
      nodePath: path.resolve(options.nodePath),
      cliPath: path.resolve(options.cliPath),
      intervalSeconds,
      logPath: paths.logPath
    }));
    const runner = deps.execFileSync ?? execFileSync;
    const domain = launchdDomain(options.uid);
    tryExec(runner, 'launchctl', ['bootout', domain, plistPath]);
    try {
      run(runner, 'launchctl', ['bootstrap', domain, plistPath], 'Could not register the launchd maintenance job');
    } catch (error) {
      restoreDefinitions(previousDefinitions);
      if (previousDefinitions.some((definition) => definition.content !== null)) {
        tryExec(runner, 'launchctl', ['bootstrap', domain, plistPath]);
      }
      throw error;
    }
    return getMaintenanceSchedulerStatus({ platform, homeDir, uid: options.uid }, deps);
  }

  const [servicePath, timerPath] = paths.definitionPaths;
  const units = buildSystemdUnits({
    nodePath: path.resolve(options.nodePath),
    cliPath: path.resolve(options.cliPath),
    intervalSeconds
  });
  writeAtomic(servicePath, units.service);
  writeAtomic(timerPath, units.timer);
  const runner = deps.execFileSync ?? execFileSync;
  try {
    run(runner, 'systemctl', ['--user', 'daemon-reload'], systemdUnavailableMessage());
    run(runner, 'systemctl', ['--user', 'enable', path.basename(timerPath)], systemdUnavailableMessage());
    run(runner, 'systemctl', ['--user', 'restart', path.basename(timerPath)], systemdUnavailableMessage());
  } catch (error) {
    if (previousDefinitions.some((definition) => definition.content === null)) {
      tryExec(runner, 'systemctl', ['--user', 'disable', '--now', path.basename(timerPath)]);
    }
    restoreDefinitions(previousDefinitions);
    tryExec(runner, 'systemctl', ['--user', 'daemon-reload']);
    if (previousDefinitions.every((definition) => definition.content !== null)) {
      tryExec(runner, 'systemctl', ['--user', 'restart', path.basename(timerPath)]);
    }
    throw error;
  }
  return getMaintenanceSchedulerStatus({ platform, homeDir }, deps);
}

export function getMaintenanceSchedulerStatus(
  options: Pick<MaintenanceSchedulerOptions, 'platform' | 'homeDir' | 'uid'> = {},
  deps: MaintenanceSchedulerDeps = {}
): MaintenanceSchedulerStatus {
  const platform = resolveMaintenancePlatform(options.platform);
  const paths = getMaintenanceSchedulerPaths(platform, options.homeDir ?? os.homedir());
  const installed = paths.definitionPaths.every((file) => fs.existsSync(file));
  if (!installed) return { ...paths, installed: false, active: false };
  const runner = deps.execFileSync ?? execFileSync;
  const active = platform === 'darwin'
    ? tryExec(runner, 'launchctl', ['print', `${launchdDomain(options.uid)}/${MAINTENANCE_LABEL}`])
    : tryExec(runner, 'systemctl', ['--user', 'is-active', '--quiet', 'claude-memory-layer-maintenance.timer']);
  return { ...paths, installed, active };
}

export function uninstallMaintenanceScheduler(
  options: Pick<MaintenanceSchedulerOptions, 'platform' | 'homeDir' | 'uid'> = {},
  deps: MaintenanceSchedulerDeps = {}
): MaintenanceSchedulerStatus {
  const platform = resolveMaintenancePlatform(options.platform);
  const paths = getMaintenanceSchedulerPaths(platform, options.homeDir ?? os.homedir());
  const runner = deps.execFileSync ?? execFileSync;
  if (platform === 'darwin') {
    const [plistPath] = paths.definitionPaths;
    tryExec(runner, 'launchctl', ['bootout', launchdDomain(options.uid), plistPath]);
  } else {
    tryExec(runner, 'systemctl', ['--user', 'disable', '--now', 'claude-memory-layer-maintenance.timer']);
  }
  for (const file of paths.definitionPaths) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (platform === 'linux') {
    tryExec(runner, 'systemctl', ['--user', 'daemon-reload']);
  }
  return { ...paths, installed: false, active: false };
}

export function formatMaintenanceSchedulerStatus(status: MaintenanceSchedulerStatus): string {
  return [
    `Maintenance scheduler (${status.platform})`,
    `Installed: ${status.installed ? 'yes' : 'no'}`,
    `Active: ${status.active ? 'yes' : 'no'}`,
    ...status.definitionPaths.map((file) => `Definition: ${file}`),
    `Log: ${status.logPath}`
  ].join('\n');
}

function validateExecutablePath(value: string, label: string): void {
  if (!value || !path.isAbsolute(value) || !fs.existsSync(value)) {
    throw new Error(`${label} must be an existing absolute path: ${value || '(empty)'}`);
  }
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempPath = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, content, { mode: 0o644 });
  fs.renameSync(tempPath, file);
}

interface DefinitionSnapshot {
  file: string;
  content: Buffer | null;
}

function snapshotDefinitions(files: string[]): DefinitionSnapshot[] {
  return files.map((file) => ({
    file,
    content: fs.existsSync(file) ? fs.readFileSync(file) : null
  }));
}

function restoreDefinitions(definitions: DefinitionSnapshot[]): void {
  for (const definition of definitions) {
    if (definition.content === null) {
      try {
        fs.unlinkSync(definition.file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      continue;
    }
    fs.mkdirSync(path.dirname(definition.file), { recursive: true });
    const tempPath = `${definition.file}.rollback-${process.pid}`;
    fs.writeFileSync(tempPath, definition.content, { mode: 0o644 });
    fs.renameSync(tempPath, definition.file);
  }
}

function launchdDomain(uid: number | undefined): string {
  const resolved = uid ?? process.getuid?.();
  if (!Number.isSafeInteger(resolved) || (resolved ?? -1) < 0) {
    throw new Error('Could not determine the current user id for launchd');
  }
  return `gui/${resolved}`;
}

function run(
  runner: typeof execFileSync,
  command: string,
  args: string[],
  failureMessage: string
): void {
  try {
    runner(command, args, { stdio: 'ignore' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${failureMessage}: ${detail}`);
  }
}

function tryExec(runner: typeof execFileSync, command: string, args: string[]): boolean {
  try {
    runner(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function systemdQuote(value: string): string {
  if (/\r|\n/.test(value)) throw new Error('systemd command arguments must not contain newlines');
  return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

function systemdUnavailableMessage(): string {
  return 'Could not register the systemd user timer. Ensure systemd --user is available, or schedule "claude-memory-layer maintenance run" with cron';
}
