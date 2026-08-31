import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveExistingStore, type ExistingStoreStatus } from '../../core/registry/existing-store.js';
import { resolveCanonicalRepoIdentity, type RepoIdentityKind } from '../../core/registry/repo-identity.js';

export type ProjectBootstrapCheckId =
  | 'canonical_identity'
  | 'existing_store'
  | 'claude_hooks'
  | 'mcp_command'
  | 'bootstrap_instruction';

export interface ProjectBootstrapCheck {
  id: ProjectBootstrapCheckId;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  remediation?: string;
}

export interface ProjectBootstrapHealthReport {
  schemaVersion: 'project-bootstrap-health-v1';
  mode: 'read-only';
  projectHash: string;
  identityKind: RepoIdentityKind;
  storeStatus: ExistingStoreStatus;
  checks: ProjectBootstrapCheck[];
}

export interface ProjectBootstrapHealthOptions {
  projectPath: string;
  homeDir?: string;
}

export function inspectProjectBootstrapHealth(
  options: ProjectBootstrapHealthOptions
): ProjectBootstrapHealthReport {
  const projectPath = path.resolve(options.projectPath);
  const homeDir = options.homeDir ?? os.homedir();
  const identity = resolveCanonicalRepoIdentity(projectPath);
  const store = resolveExistingStore(projectPath, { homeDir });
  const settingsText = readText(path.join(homeDir, '.claude', 'settings.json'));
  const settings = parseJsonObject(settingsText);
  const projectMcp = parseJsonObject(readText(path.join(projectPath, '.mcp.json')));
  const bootstrapText = [
    readText(path.join(projectPath, 'AGENTS.md')),
    readText(path.join(projectPath, 'CLAUDE.md'))
  ].join('\n');
  const hasHooks = hasClaudeMemoryHook(settings?.hooks, 'SessionStart', /session[-_]?start/i)
    || hasClaudeMemoryHook(settings?.hooks, 'UserPromptSubmit', /user[-_]?prompt[-_]?submit/i);
  const hasMcp = hasClaudeMemoryMcp(projectMcp?.mcpServers)
    || hasClaudeMemoryMcp(settings?.mcpServers);
  const hasBootstrap = /mem-context-pack/i.test(bootstrapText)
    && /\btopK\s*[=:]\s*5(?!\d)/i.test(bootstrapText)
    && /\brecentLimit\s*[=:]\s*30(?!\d)/i.test(bootstrapText)
    && /\bsessionLimit\s*[=:]\s*5(?!\d)/i.test(bootstrapText);

  return {
    schemaVersion: 'project-bootstrap-health-v1',
    mode: 'read-only',
    projectHash: identity.projectHash,
    identityKind: identity.kind,
    storeStatus: store.status,
    checks: [
      {
        id: 'canonical_identity',
        status: 'pass',
        detail: `resolved:${identity.kind}`
      },
      {
        id: 'existing_store',
        status: store.status === 'existing' ? 'pass' : store.status === 'missing' ? 'warn' : 'fail',
        detail: store.reason ?? store.status,
        ...(store.status === 'missing' ? { remediation: 'Run an ordinary captured project session before expecting project memory.' } : {})
      },
      {
        id: 'claude_hooks',
        status: hasHooks ? 'pass' : 'warn',
        detail: hasHooks ? 'configured' : 'not_detected',
        ...(!hasHooks ? { remediation: 'Review hook installation; this check does not install or edit settings.' } : {})
      },
      {
        id: 'mcp_command',
        status: hasMcp ? 'pass' : 'warn',
        detail: hasMcp ? 'configured' : 'not_detected',
        ...(!hasMcp ? { remediation: 'Configure the claude-memory-layer MCP command explicitly.' } : {})
      },
      {
        id: 'bootstrap_instruction',
        status: hasBootstrap ? 'pass' : 'warn',
        detail: hasBootstrap ? 'canonical_parameters_detected' : 'canonical_parameters_not_detected',
        ...(!hasBootstrap ? { remediation: 'Copy the canonical project bootstrap snippet into AGENTS.md or CLAUDE.md.' } : {})
      }
    ]
  };
}

export function formatProjectBootstrapHealth(report: ProjectBootstrapHealthReport): string {
  return [
    `Project bootstrap health (read-only): ${report.projectHash}`,
    `Identity: ${report.identityKind}`,
    `Store: ${report.storeStatus}`,
    ...report.checks.map((check) => `- ${check.id}: ${check.status} (${check.detail})`),
    'No hooks, configuration, instructions, or project storage were changed.'
  ].join('\n');
}

function readText(file: string): string {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hasClaudeMemoryHook(
  hooksValue: unknown,
  eventName: string,
  expectedHookName: RegExp
): boolean {
  if (!hooksValue || typeof hooksValue !== 'object' || Array.isArray(hooksValue)) return false;
  const eventValue = (hooksValue as Record<string, unknown>)[eventName];
  return findCommandStrings(eventValue).some((command) => {
    const normalized = command.replace(/\\/g, '/');
    return /claude-memory-layer/i.test(normalized) && expectedHookName.test(normalized);
  });
}

function findCommandStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(findCommandStrings);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.command === 'string' ? [record.command] : []),
    ...Object.entries(record)
      .filter(([key]) => key !== 'command')
      .flatMap(([, nested]) => findCommandStrings(nested))
  ];
}

function hasClaudeMemoryMcp(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).some(([serverName, server]) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
    const record = server as Record<string, unknown>;
    const command = typeof record.command === 'string' ? record.command : '';
    const args = Array.isArray(record.args)
      ? record.args.filter((item): item is string => typeof item === 'string')
      : [];
    const invocation = [command, ...args].join(' ').replace(/\\/g, '/');
    if (/claude-memory-layer/i.test(invocation)) return true;
    return /memory/i.test(serverName)
      && /(?:^|[\s/])(?:\.\/)?(?:dist|src)\/(?:extensions\/)?mcp\/index\.(?:js|ts)(?:\s|$)/i.test(invocation);
  });
}
