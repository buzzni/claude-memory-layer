import { spawn, type ChildProcess } from 'node:child_process';
import * as nodeUrl from 'node:url';
import * as path from 'node:path';

import { readStdin } from '../../claude/hooks/hook-runtime.js';

export interface CodexSessionEndHookInput {
  session_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name?: string;
}

export interface CodexSessionImportJob {
  transcriptPath: string;
  projectPath: string;
}

export interface CodexSessionEndHookDeps {
  spawnWorker: (
    executable: string,
    args: string[],
    options: {
      detached: boolean;
      stdio: ['pipe', 'ignore', 'ignore'];
    }
  ) => Pick<ChildProcess, 'stdin' | 'unref'>;
  workerPath: string;
}

function defaultWorkerPath(): string {
  return path.join(path.dirname(nodeUrl.fileURLToPath(import.meta.url)), 'codex-session-import-worker.js');
}

const realDeps: CodexSessionEndHookDeps = {
  spawnWorker: spawn,
  workerPath: defaultWorkerPath()
};

export function normalizeCodexSessionImportJob(input: CodexSessionEndHookInput): CodexSessionImportJob | null {
  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path.trim() : '';
  const projectPath = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  if (!transcriptPath || !projectPath || !path.isAbsolute(projectPath)) return null;
  return { transcriptPath, projectPath };
}

export function launchCodexSessionImport(
  input: CodexSessionEndHookInput,
  deps: CodexSessionEndHookDeps = realDeps
): boolean {
  const job = normalizeCodexSessionImportJob(input);
  if (!job) return false;

  const child = deps.spawnWorker(process.execPath, [deps.workerPath], {
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'ignore', 'ignore']
  });
  child.stdin?.on('error', () => {
    // Codex must not fail its lifecycle when a detached worker exits early.
  });
  child.stdin?.end(JSON.stringify(job));
  child.unref();
  return true;
}

export async function main(): Promise<string> {
  try {
    const input = JSON.parse(await readStdin()) as CodexSessionEndHookInput;
    launchCodexSessionImport(input);
  } catch (error) {
    if (process.env.CLAUDE_MEMORY_DEBUG) {
      console.error('Codex memory hook error:', error);
    }
  }
  return JSON.stringify({});
}
