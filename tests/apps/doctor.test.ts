import { describe, expect, it } from 'vitest';

import {
  checkEmbeddingBackend,
  checkHooksInstalled,
  checkNodeVersion,
  checkPathConsistency,
  checkPluginFiles,
  checkProjectStoreAccess,
  doctorExitCode,
  findPathInstalls,
  formatDoctorReport,
  type DoctorCheckResult
} from '../../src/apps/cli/doctor.js';
import { REQUIRED_HOOK_FILES, type ClaudeSettingsWithHooks } from '../../src/apps/cli/claude-settings-hooks.js';

describe('checkNodeVersion', () => {
  it('passes on a version at or above the minimum', () => {
    expect(checkNodeVersion('v20.19.0').status).toBe('pass');
    expect(checkNodeVersion('v20.19.5').status).toBe('pass');
    expect(checkNodeVersion('v22.10.0').status).toBe('pass');
  });

  it('fails below the minimum minor within the required major', () => {
    const result = checkNodeVersion('v20.18.0');
    expect(result.status).toBe('fail');
    expect(result.fix).toBeDefined();
  });

  it('fails below the minimum major', () => {
    expect(checkNodeVersion('v18.20.0').status).toBe('fail');
  });

  it('fails on an unparseable version string', () => {
    expect(checkNodeVersion('not-a-version').status).toBe('fail');
  });
});

describe('checkPluginFiles', () => {
  it('passes when every required hook file exists', () => {
    const result = checkPluginFiles('/plugin', () => true);
    expect(result.status).toBe('pass');
  });

  it('fails and names the missing files when any are absent', () => {
    const missing = new Set([REQUIRED_HOOK_FILES[0]]);
    const result = checkPluginFiles('/plugin', (p: string) => !missing.has(p.split('/').pop() as typeof REQUIRED_HOOK_FILES[number]));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(REQUIRED_HOOK_FILES[0]);
    expect(result.fix).toContain('npm install');
  });
});

describe('checkHooksInstalled', () => {
  it('passes when all five hooks are present', () => {
    const settings: ClaudeSettingsWithHooks = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node hooks/session-start.js' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node hooks/user-prompt-submit.js' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'node hooks/post-tool-use.js' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'node hooks/stop.js' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'node hooks/session-end.js' }] }]
      }
    };
    expect(checkHooksInstalled(settings).status).toBe('pass');
  });

  it('fails and names each missing hook when settings are empty', () => {
    const result = checkHooksInstalled({});
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('SessionStart');
    expect(result.detail).toContain('SessionEnd');
    expect(result.fix).toBe('claude-memory-layer install');
  });

  it('fails when only some hooks are installed', () => {
    const result = checkHooksInstalled({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node hooks/session-start.js' }] }]
      }
    });
    expect(result.status).toBe('fail');
    expect(result.detail).not.toContain('SessionStart');
    expect(result.detail).toContain('Stop');
  });
});

describe('checkEmbeddingBackend', () => {
  it('fails when the healthcheck script could not be loaded at all', () => {
    const result = checkEmbeddingBackend('/pkg', null);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('healthcheck script');
  });

  it('fails with a repair command when the backend reports unavailable', () => {
    const result = checkEmbeddingBackend('/pkg', () => false);
    expect(result.status).toBe('fail');
    expect(result.fix).toContain('ONNXRUNTIME_NODE_INSTALL_CUDA=skip');
  });

  it('passes when the backend is available', () => {
    const result = checkEmbeddingBackend('/pkg', () => true);
    expect(result.status).toBe('pass');
  });
});

describe('findPathInstalls', () => {
  it('finds a binary present in one PATH directory', () => {
    const installs = findPathInstalls('cml', '/a:/b', {
      existsImpl: (p) => p === '/a/cml',
      realpathImpl: (p) => p
    });
    expect(installs).toEqual([{ dir: '/a', resolvedPath: '/a/cml' }]);
  });

  it('deduplicates two PATH entries that resolve to the same real file', () => {
    // /a/cml and /b/cml are both symlinks to the same real install.
    const installs = findPathInstalls('cml', '/a:/b', {
      existsImpl: () => true,
      realpathImpl: () => '/real/cml'
    });
    expect(installs).toHaveLength(1);
  });

  it('reports two entries when they resolve to genuinely different installs', () => {
    const installs = findPathInstalls('cml', '/a:/b', {
      existsImpl: () => true,
      realpathImpl: (p) => (p.startsWith('/a') ? '/real-a/cml' : '/real-b/cml')
    });
    expect(installs).toHaveLength(2);
  });

  it('skips PATH directories that do not contain the binary', () => {
    const installs = findPathInstalls('cml', '/a:/b:/c', {
      existsImpl: (p) => p === '/c/cml',
      realpathImpl: (p) => p
    });
    expect(installs.map((i) => i.dir)).toEqual(['/c']);
  });
});

describe('checkPathConsistency', () => {
  it('passes as "not found" when the binary is not on PATH at all', () => {
    const result = checkPathConsistency('cml', '/a:/b', { existsImpl: () => false });
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('not found on PATH');
  });

  it('passes when PATH resolves to exactly one install', () => {
    const result = checkPathConsistency('cml', '/a', {
      existsImpl: () => true,
      realpathImpl: () => '/real/cml'
    });
    expect(result.status).toBe('pass');
  });

  it('warns and lists every resolved path when PATH resolves to more than one install', () => {
    // This is the dual-install / stale-nvm-version hazard this check exists for.
    const result = checkPathConsistency('cml', '/old:/new', {
      existsImpl: () => true,
      realpathImpl: (p) => (p.startsWith('/old') ? '/old-install/cml' : '/new-install/cml')
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('/old-install/cml');
    expect(result.detail).toContain('/new-install/cml');
    expect(result.fix).toBeDefined();
  });
});

describe('checkProjectStoreAccess', () => {
  it('passes when the store directory already exists and is writable', () => {
    const result = checkProjectStoreAccess('/home/user/.claude-code/memory/projects/abc12345', {
      existsImpl: (p) => p === '/home/user/.claude-code/memory/projects/abc12345',
      accessImpl: () => undefined
    });
    expect(result.status).toBe('pass');
  });

  it('never asks to create anything — only checks, and terminates instead of looping when nothing exists', () => {
    // Regression guard: this check must be read-only. Verifying writability by
    // actually mkdir -p'ing the path would silently create an empty project
    // store just from running `doctor` (the exact bug class documented for
    // mem-* tools defaulting to an empty global store).
    let accessCalls = 0;
    const result = checkProjectStoreAccess('/home/user/.claude-code/memory/projects/abc12345', {
      existsImpl: () => false, // nothing on the chain up to filesystem root exists
      accessImpl: () => { accessCalls += 1; }
    });
    expect(accessCalls).toBe(1);
    expect(result.status).toBe('pass');
  });

  it('walks up to the nearest existing ancestor when the store itself does not exist yet', () => {
    const existing = new Set(['/home/user/.claude-code/memory/projects']);
    const result = checkProjectStoreAccess('/home/user/.claude-code/memory/projects/new-hash', {
      existsImpl: (p) => existing.has(p),
      accessImpl: (p) => {
        if (p !== '/home/user/.claude-code/memory/projects') throw new Error('checked the wrong path');
      }
    });
    expect(result.status).toBe('pass');
  });

  it('fails when the nearest existing ancestor is not writable', () => {
    const result = checkProjectStoreAccess('/root-owned/projects/abc12345', {
      existsImpl: (p) => p === '/root-owned',
      accessImpl: () => { throw new Error('EACCES'); }
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('/root-owned');
  });
});

describe('formatDoctorReport and doctorExitCode', () => {
  const passing: DoctorCheckResult = { name: 'a', status: 'pass', detail: 'ok' };
  const warning: DoctorCheckResult = { name: 'bb', status: 'warn', detail: 'careful', fix: 'do X' };
  const failing: DoctorCheckResult = { name: 'c', status: 'fail', detail: 'broken', fix: 'do Y' };

  it('exits 0 when nothing failed, even with warnings', () => {
    expect(doctorExitCode([passing, warning])).toBe(0);
  });

  it('exits 1 when anything failed', () => {
    expect(doctorExitCode([passing, warning, failing])).toBe(1);
  });

  it('renders every check name, detail, and fix suggestion', () => {
    const report = formatDoctorReport([passing, warning, failing]);
    expect(report).toContain('a:');
    expect(report).toContain('ok');
    expect(report).toContain('bb:');
    expect(report).toContain('careful');
    expect(report).toContain('Fix: do X');
    expect(report).toContain('c:');
    expect(report).toContain('broken');
    expect(report).toContain('Fix: do Y');
  });

  it('summarizes failed and passed states', () => {
    expect(formatDoctorReport([failing])).toContain('1 check(s) failed');
    expect(formatDoctorReport([passing])).toContain('All checks passed');
    expect(formatDoctorReport([passing, warning])).toContain('1 warning(s)');
  });
});
