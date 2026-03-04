import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

interface SemanticRequest {
  sessionId: string;
  prompt: string;
  topK: number;
  minScore: number;
}

interface SemanticMemory {
  type: string;
  content: string;
  id?: string;
  score?: number;
}

interface SemanticDaemonRequest {
  type: 'retrieve';
  sessionId: string;
  prompt: string;
  topK: number;
  minScore: number;
}

interface SemanticDaemonResponse {
  ok: boolean;
  memories?: SemanticMemory[];
  error?: string;
}

const DEFAULT_SOCKET_PATH = path.join(
  os.homedir(),
  '.claude-code',
  'memory',
  'semantic-daemon.sock'
);

const DAEMON_SOCKET_PATH = process.env.CLAUDE_MEMORY_SEMANTIC_SOCKET || DEFAULT_SOCKET_PATH;
const DAEMON_START_TIMEOUT_MS = parseInt(process.env.CLAUDE_MEMORY_SEMANTIC_DAEMON_START_MS || '1500');

let daemonStartPromise: Promise<void> | null = null;

export async function retrieveSemanticMemories(
  request: SemanticRequest,
  timeoutMs: number
): Promise<SemanticMemory[]> {
  const payload: SemanticDaemonRequest = {
    type: 'retrieve',
    sessionId: request.sessionId,
    prompt: request.prompt,
    topK: request.topK,
    minScore: request.minScore
  };

  try {
    return await requestFromDaemon(payload, timeoutMs);
  } catch (error) {
    if (!isConnectionError(error)) {
      throw error;
    }

    await ensureDaemonRunning();
    return requestFromDaemon(payload, timeoutMs).catch((retryError) => {
      if (process.env.CLAUDE_MEMORY_DEBUG) {
        console.error('[semantic-client] retry failed after daemon start:', retryError);
      }
      throw retryError;
    });
  }
}

function requestFromDaemon(
  payload: SemanticDaemonRequest,
  timeoutMs: number
): Promise<SemanticMemory[]> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(DAEMON_SOCKET_PATH);
    client.setEncoding('utf8');

    let settled = false;
    let responseRaw = '';
    const timer = setTimeout(() => {
      const timeoutError = new Error(`semantic daemon timeout (${timeoutMs}ms)`);
      (timeoutError as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      settle(timeoutError);
      client.destroy();
    }, timeoutMs);

    const settle = (error?: Error, memories?: SemanticMemory[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(memories || []);
      }
    };

    client.on('connect', () => {
      client.end(JSON.stringify(payload));
    });

    client.on('data', (chunk) => {
      responseRaw += chunk;
      if (responseRaw.length > 4 * 1024 * 1024) {
        settle(new Error('semantic daemon response too large'));
        client.destroy();
      }
    });

    client.on('end', () => {
      try {
        const parsed = JSON.parse(responseRaw || '{}') as SemanticDaemonResponse;
        if (!parsed.ok) {
          settle(new Error(parsed.error || 'semantic daemon error'));
          return;
        }
        settle(undefined, parsed.memories || []);
      } catch (error) {
        settle(error as Error);
      }
    });

    client.on('error', (error) => {
      settle(error as Error);
    });
  });
}

async function ensureDaemonRunning(): Promise<void> {
  if (daemonStartPromise) {
    return daemonStartPromise;
  }

  daemonStartPromise = (async () => {
    if (await canConnect()) {
      return;
    }

    const daemonScriptPath = getDaemonScriptPath();
    if (!fs.existsSync(daemonScriptPath)) {
      throw new Error(`semantic daemon script not found: ${daemonScriptPath}`);
    }

    const daemonDir = path.dirname(DAEMON_SOCKET_PATH);
    if (!fs.existsSync(daemonDir)) {
      fs.mkdirSync(daemonDir, { recursive: true });
    }

    const child = spawn(process.execPath, [daemonScriptPath], {
      detached: true,
      stdio: 'ignore',
      env: process.env
    });
    child.unref();

    const startDeadline = Date.now() + DAEMON_START_TIMEOUT_MS;
    while (Date.now() < startDeadline) {
      if (await canConnect()) {
        return;
      }
      await sleep(60);
    }

    throw new Error(`semantic daemon start timeout (${DAEMON_START_TIMEOUT_MS}ms)`);
  })();

  try {
    await daemonStartPromise;
  } finally {
    daemonStartPromise = null;
  }
}

function getDaemonScriptPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.join(path.dirname(currentFile), 'semantic-daemon.js');
}

function canConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const client = net.createConnection(DAEMON_SOCKET_PATH);
    const finalize = (ok: boolean) => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(ok);
    };

    client.on('connect', () => finalize(true));
    client.on('error', () => finalize(false));
    setTimeout(() => finalize(false), 120).unref();
  });
}

function isConnectionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'ECONNRESET';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
