import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { DISABLED_SHARED_STORE_CONFIG, MemoryService } from '../../../services/memory-service.js';
import { getProjectStoragePath } from '../../../core/registry/project-path.js';
import { getSessionProject } from '../../../core/registry/session-registry.js';
import { WorkerLock } from '../../../core/worker-lock.js';
import { readNumberEnv } from './hook-runtime.js';
import { AutoGraduationScheduler, isAutoGraduationEnabled } from './semantic-daemon-graduation.js';

export interface SemanticDaemonRequest {
  type?: 'retrieve' | 'graduate';
  sessionId?: string;
  prompt?: string;
  topK?: number;
  minScore?: number;
  evaluation?: boolean;
}

export interface SemanticMemory {
  type: string;
  content: string;
  id?: string;
  score?: number;
  sessionId?: string;
}

export interface SemanticDaemonResponse {
  ok: boolean;
  memories?: SemanticMemory[];
  error?: string;
}

const SOCKET_PATH = process.env.CLAUDE_MEMORY_SEMANTIC_SOCKET || path.join(
  os.homedir(),
  '.claude-code',
  'memory',
  'semantic-daemon.sock'
);

const IDLE_TIMEOUT_MS = readNumberEnv('CLAUDE_MEMORY_SEMANTIC_DAEMON_IDLE_MS', 600000, { integer: true, min: 1000 });
const autoGraduationScheduler = new AutoGraduationScheduler({
  enabled: isAutoGraduationEnabled(),
  cooldownMs: readNumberEnv('CLAUDE_MEMORY_AUTO_GRADUATION_COOLDOWN_MS', 300000, { integer: true, min: 1000 }),
  delayMs: readNumberEnv('CLAUDE_MEMORY_AUTO_GRADUATION_DELAY_MS', 50, { integer: true, min: 0 })
});
const serviceCache = new Map<string, MemoryService>();

let server: net.Server | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;
let processHandlersInstalled = false;

function scheduleIdleShutdown(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }

  idleTimer = setTimeout(() => {
    shutdown(0).catch(() => {
      process.exit(0);
    });
  }, IDLE_TIMEOUT_MS);
  idleTimer.unref();
}

export function parseSemanticDaemonRequest(raw: string): SemanticDaemonRequest {
  try {
    return JSON.parse(raw) as SemanticDaemonRequest;
  } catch {
    return {};
  }
}

export function isValidSemanticDaemonRequest(
  input: SemanticDaemonRequest
): boolean {
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) return false;
  if (input.type === 'graduate') return input.evaluation === undefined || typeof input.evaluation === 'boolean';
  return input.type === 'retrieve'
    && typeof input.prompt === 'string'
    && input.prompt.length > 0
    && Number.isFinite(input.topK)
    && Number.isFinite(input.minScore)
    && (input.evaluation === undefined || typeof input.evaluation === 'boolean');
}

export function makeSemanticDaemonErrorResponse(error: unknown): SemanticDaemonResponse {
  return { ok: false, error: error instanceof Error ? error.message : 'unknown daemon error' };
}

export function isVectorSessionFilterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('no field named sessionid');
}

function getServiceForSession(sessionId: string): MemoryService {
  const projectInfo = getSessionProject(sessionId);
  const key = projectInfo?.projectHash || '__global__';

  if (serviceCache.has(key)) {
    return serviceCache.get(key)!;
  }

  const service = new MemoryService({
    storagePath: projectInfo
      ? getProjectStoragePath(projectInfo.projectPath)
      : path.join(os.homedir(), '.claude-code', 'memory'),
    projectHash: projectInfo?.projectHash,
    projectPath: projectInfo?.projectPath,
    // The daemon only serves retrieval requests. Keeping it read-only prevents
    // a long-lived query process from becoming an uncoordinated Lance writer.
    readOnly: true,
    analyticsEnabled: false,
    sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
  });

  serviceCache.set(key, service);
  return service;
}

async function runGraduationWithWriterLock(sessionId: string): Promise<void> {
  const projectInfo = getSessionProject(sessionId);
  const storagePath = projectInfo
    ? getProjectStoragePath(projectInfo.projectPath)
    : path.join(os.homedir(), '.claude-code', 'memory');
  const writerLock = new WorkerLock(path.join(storagePath, 'vector-worker.lock'));
  const lockResult = writerLock.acquire();
  if (!lockResult.acquired) return;

  const service = new MemoryService({
    storagePath,
    projectHash: projectInfo?.projectHash,
    projectPath: projectInfo?.projectPath,
    readOnly: false,
    embeddingOnly: true,
    analyticsEnabled: false,
    sharedStoreConfig: DISABLED_SHARED_STORE_CONFIG
  });

  try {
    await service.initialize();
    await service.forceGraduation();
  } finally {
    await service.shutdown().catch(() => undefined);
    writerLock.release();
  }
}

function getProjectKeyForSession(sessionId: string): string {
  return getSessionProject(sessionId)?.projectHash || '__global__';
}

export async function handleSemanticDaemonRequest(raw: string): Promise<SemanticDaemonResponse> {
  const input = parseSemanticDaemonRequest(raw);
  if (!isValidSemanticDaemonRequest(input)) {
    return { ok: false, error: 'invalid request' };
  }

  try {
    const sessionId = input.sessionId!;
    if (input.type === 'graduate') {
      autoGraduationScheduler.schedule(
        getProjectKeyForSession(sessionId),
        () => runGraduationWithWriterLock(sessionId),
        { evaluation: input.evaluation === true }
      );
      return { ok: true, memories: [] };
    }

    const service = getServiceForSession(sessionId);
    const prompt = input.prompt!;
    let result;
    try {
      result = await service.retrieveMemories(prompt, {
        topK: input.topK!,
        minScore: input.minScore!,
        sessionId,
        intentRewrite: true,
        adaptiveRerank: true,
        projectScopeMode: 'strict',
        recordTrace: false
      });
    } catch (error) {
      if (!isVectorSessionFilterError(error)) {
        throw error;
      }

      // LanceDB field-case mismatch can fail sessionId filtering.
      // Retry without session filter and keep project strict scoping.
      result = await service.retrieveMemories(prompt, {
        topK: input.topK!,
        minScore: input.minScore!,
        intentRewrite: true,
        adaptiveRerank: true,
        projectScopeMode: 'strict',
        recordTrace: false
      });
    }

    const memories = result.memories.map((m) => ({
      type: m.event.eventType,
      content: m.event.content,
      id: m.event.id,
      score: m.score,
      sessionId: m.event.sessionId
    }));

    return { ok: true, memories };
  } catch (error) {
    return makeSemanticDaemonErrorResponse(error);
  }
}

function createServer(): net.Server {
  return net.createServer({ allowHalfOpen: true }, (socket) => {
    scheduleIdleShutdown();
    socket.setEncoding('utf8');

    let requestRaw = '';

    socket.on('data', (chunk) => {
      requestRaw += chunk;
      if (requestRaw.length > 1024 * 1024) {
        socket.end(JSON.stringify({ ok: false, error: 'request too large' }));
      }
    });

    socket.on('end', async () => {
      const response = await handleSemanticDaemonRequest(requestRaw);
      socket.end(JSON.stringify(response));
      scheduleIdleShutdown();
    });

    socket.on('error', () => {
      // Ignore per-socket errors to keep daemon process alive.
    });
  });
}

async function socketInUse(p: string): Promise<boolean> {
  if (!fs.existsSync(p)) return false;
  return new Promise((resolve) => {
    let settled = false;
    const client = net.createConnection(p);
    const done = (alive: boolean) => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(alive);
    };
    client.on('connect', () => done(true));
    client.on('error', () => done(false));
    setTimeout(() => done(false), 120).unref();
  });
}

async function listenServer(): Promise<void> {
  const socketDir = path.dirname(SOCKET_PATH);
  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true });
  }

  if (await socketInUse(SOCKET_PATH)) {
    process.exit(0);
  }

  if (fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // Ignore stale socket unlink failures.
    }
  }

  server = createServer();

  await new Promise<void>((resolve, reject) => {
    if (!server) {
      reject(new Error('daemon server not initialized'));
      return;
    }

    server.once('error', reject);
    server.listen(SOCKET_PATH, () => {
      server?.off('error', reject);
      resolve();
    });
  });
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = null;

  await autoGraduationScheduler.shutdown();

  const closePromises: Promise<void>[] = [];
  for (const service of serviceCache.values()) {
    closePromises.push(service.shutdown().catch(() => undefined));
  }
  await Promise.all(closePromises);
  serviceCache.clear();

  if (server) {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  }
  server = null;

  if (fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // Ignore socket cleanup failure.
    }
  }

  process.exit(code);
}

function installProcessHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;

  process.on('SIGINT', () => { shutdown(0).catch(() => process.exit(0)); });
  process.on('SIGTERM', () => { shutdown(0).catch(() => process.exit(0)); });
  process.on('uncaughtException', () => { shutdown(1).catch(() => process.exit(1)); });
  process.on('unhandledRejection', () => { shutdown(1).catch(() => process.exit(1)); });
}

export async function main(): Promise<void> {
  installProcessHandlers();
  await listenServer();
  scheduleIdleShutdown();
}
