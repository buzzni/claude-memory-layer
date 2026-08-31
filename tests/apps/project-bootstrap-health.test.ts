import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  formatProjectBootstrapHealth,
  inspectProjectBootstrapHealth
} from '../../src/apps/cli/project-bootstrap-health.js';
import { snapshotMemoryRoot } from '../helpers/memory-root-snapshot.js';

describe('project bootstrap health', () => {
  it('detects canonical bootstrap configuration without changing storage or config', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-bootstrap-health-'));
    const homeDir = path.join(root, 'home');
    const projectPath = path.join(root, 'project');
    mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ command: 'claude-memory-layer hook session-start' }] },
      mcpServers: { memory: { command: 'claude-memory-layer', args: ['mcp'] } }
    }));
    writeFileSync(path.join(projectPath, 'AGENTS.md'), [
      'Use mem-context-pack with an absolute projectPath.',
      'topK=5 recentLimit=30 sessionLimit=5 refreshLatest=false'
    ].join('\n'));
    const memoryRoot = path.join(homeDir, '.claude-code', 'memory');
    const before = snapshotMemoryRoot(memoryRoot);

    const report = inspectProjectBootstrapHealth({ projectPath, homeDir });

    expect(report.mode).toBe('read-only');
    expect(report.storeStatus).toBe('missing');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'claude_hooks', status: 'pass' }),
      expect.objectContaining({ id: 'mcp_command', status: 'pass' }),
      expect.objectContaining({ id: 'bootstrap_instruction', status: 'pass' })
    ]));
    expect(snapshotMemoryRoot(memoryRoot)).toEqual(before);
    expect(formatProjectBootstrapHealth(report)).toContain('No hooks, configuration, instructions, or project storage were changed.');
  });

  it('returns stable warning check ids when optional setup is absent', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-bootstrap-health-missing-'));
    const projectPath = path.join(root, 'project');
    mkdirSync(projectPath, { recursive: true });
    const report = inspectProjectBootstrapHealth({ projectPath, homeDir: path.join(root, 'home') });
    expect(report.checks.map((check) => check.id)).toEqual([
      'canonical_identity',
      'existing_store',
      'claude_hooks',
      'mcp_command',
      'bootstrap_instruction'
    ]);
    expect(report.checks.filter((check) => check.status === 'warn').length).toBeGreaterThan(0);
  });

  it('does not accept larger parameter values that merely start with the canonical digits', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-bootstrap-health-prefix-'));
    const homeDir = path.join(root, 'home');
    const projectPath = path.join(root, 'project');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(path.join(projectPath, 'AGENTS.md'), [
      'Use mem-context-pack.',
      'topK=50 recentLimit=300 sessionLimit=50'
    ].join('\n'));

    const report = inspectProjectBootstrapHealth({ projectPath, homeDir });
    expect(report.checks.find((check) => check.id === 'bootstrap_instruction'))
      .toMatchObject({ status: 'warn', detail: 'canonical_parameters_not_detected' });
  });

  it('does not mistake an MCP-only settings entry for installed Claude hooks', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-bootstrap-health-sections-'));
    const homeDir = path.join(root, 'home');
    const projectPath = path.join(root, 'project');
    mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify({
      mcpServers: { memory: { command: 'claude-memory-layer', args: ['mcp'] } }
    }));

    const report = inspectProjectBootstrapHealth({ projectPath, homeDir });
    expect(report.checks.find((check) => check.id === 'mcp_command'))
      .toMatchObject({ status: 'pass' });
    expect(report.checks.find((check) => check.id === 'claude_hooks'))
      .toMatchObject({ status: 'warn', detail: 'not_detected' });
  });

  it('does not combine an unrelated capture event with a CML hook on another event', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-bootstrap-health-mixed-hooks-'));
    const homeDir = path.join(root, 'home');
    const projectPath = path.join(root, 'project');
    mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node /other/session-start.js' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'claude-memory-layer hook session-end' }] }]
      }
    }));

    const report = inspectProjectBootstrapHealth({ projectPath, homeDir });
    expect(report.checks.find((check) => check.id === 'claude_hooks'))
      .toMatchObject({ status: 'warn', detail: 'not_detected' });
  });

  it('does not accept a named but non-executable memory MCP entry', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-bootstrap-health-mcp-shape-'));
    const homeDir = path.join(root, 'home');
    const projectPath = path.join(root, 'project');
    mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(path.join(projectPath, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'claude-memory-layer-disabled': {
          command: 'node',
          args: ['/opt/other/server.js'],
          description: 'mem-context-pack documentation placeholder'
        }
      }
    }));

    const report = inspectProjectBootstrapHealth({ projectPath, homeDir });
    expect(report.checks.find((check) => check.id === 'mcp_command'))
      .toMatchObject({ status: 'warn', detail: 'not_detected' });
  });

  it('recognizes the supported custom-name node entrypoint form', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cml-bootstrap-health-custom-mcp-'));
    const homeDir = path.join(root, 'home');
    const projectPath = path.join(root, 'project');
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(path.join(projectPath, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'code-memory': { command: 'node', args: ['/opt/custom/dist/mcp/index.js'] }
      }
    }));

    const report = inspectProjectBootstrapHealth({ projectPath, homeDir });
    expect(report.checks.find((check) => check.id === 'mcp_command'))
      .toMatchObject({ status: 'pass', detail: 'configured' });
  });
});
