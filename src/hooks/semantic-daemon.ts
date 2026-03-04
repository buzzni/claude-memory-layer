#!/usr/bin/env node

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { MemoryService, getProjectStoragePath, getSessionProject } from '../services/memory-service.js';

interface SemanticDaemonRequest {
  type?: 'retrieve';
  sessionId?: string;
  prompt?: string;
  topK?: number;
  minScore?: number;
}

interface SemanticMemory {
  type: string;
  content: string;
  id?: string;
  score?: number;
}

interface SemanticDaemonResponse {
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

const IDLE_TIMEOUT_MS = parseInt(process.env.CLAUDE_MEMORY_SEMANTIC_DAEMON_IDLE_MS || '600000');
const serviceCache = new Map<string, MemoryService>();

let server: net.Server | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

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

function parseRequest(raw: string): SemanticDaemonRequest {
  try {
    return JSON.parse(raw) as SemanticDaemonRequest;
  } catch {
    return {};
  }
}

function isValidRequest(input: SemanticDaemonRequest): input is Required<SemanticDaemonRequest> {
  return input.type === 'retrieve'
    && typeof input.sessionId === 'string'
    && input.sessionId.length > 0
    && typeof input.prompt === 'string'
    && input.prompt.length > 0
    && Number.isFinite(input.topK)
    && Number.isFinite(input.minScore);
}

function makeErrorResponse(error: unknown): SemanticDaemonResponse {
  return { ok: false, error: error instanceof Error ? error.message : 'unknown daemon error' };
}

function isVectorSessionFilterError(error: unknown): boolean {
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
    readOnly: false,
    embeddingOnly: true,
    analyticsEnabled: false,
    sharedStoreConfig: { enabled: false }
  });

  serviceCache.set(key, service);
  return service;
}

async function handleRequest(raw: string): Promise<SemanticDaemonResponse> {
  const input = parseRequest(raw);
  if (!isValidRequest(input)) {
    return { ok: false, error: 'invalid request' };
  }

  try {
    const service = getServiceForSession(input.sessionId);
    let result;
    try {
      result = await service.retrieveMemories(input.prompt, {
        topK: input.topK,
        minScore: input.minScore,
        sessionId: input.sessionId,
        intentRewrite: true,
        adaptiveRerank: true,
        projectScopeMode: 'strict'
      });
    } catch (error) {
      if (!isVectorSessionFilterError(error)) {
        throw error;
      }

      // LanceDB field-case mismatch can fail sessionId filtering.
      // Retry without session filter and keep project strict scoping.
      result = await service.retrieveMemories(input.prompt, {
        topK: input.topK,
        minScore: input.minScore,
        intentRewrite: true,
        adaptiveRerank: true,
        projectScopeMode: 'strict'
      });
    }

    const memories = result.memories.map((m) => ({
      type: m.event.eventType,
      content: m.event.content,
      id: m.event.id,
      score: m.score
    }));

    return { ok: true, memories };
  } catch (error) {
    return makeErrorResponse(error);
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
      const response = await handleRequest(requestRaw);
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

  if (fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // Ignore socket cleanup failure.
    }
  }

  process.exit(code);
}

async function main(): Promise<void> {
  await listenServer();
  scheduleIdleShutdown();
}

process.on('SIGINT', () => { shutdown(0).catch(() => process.exit(0)); });
process.on('SIGTERM', () => { shutdown(0).catch(() => process.exit(0)); });
process.on('uncaughtException', () => { shutdown(1).catch(() => process.exit(1)); });
process.on('unhandledRejection', () => { shutdown(1).catch(() => process.exit(1)); });

main().catch(() => {
  process.exit(1);
});
