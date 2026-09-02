/**
 * Session registry for mapping Claude session IDs to project-local storage.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { hashProjectPath, normalizeProjectPath } from './project-path.js';
import { resolveCanonicalRepoIdentity } from './repo-identity.js';
import { WorkerLock } from '../worker-lock.js';

export interface SessionRegistryLocationOptions {
  homeDir?: string;
  now?: () => Date;
}

function getRegistryPath(options: SessionRegistryLocationOptions = {}): string {
  return path.join(options.homeDir ?? os.homedir(), '.claude-code', 'memory', 'session-registry.json');
}

export interface SessionRegistryEntry {
  projectPath: string;
  projectHash: string;
  registeredAt: string;
  lastSeenAt?: string;
  identityKind?: 'memory-root-marker' | 'git-common-dir' | 'path-fallback';
  terminal?: boolean;
  /** Changes on every SessionStart, allowing a late SessionEnd to avoid closing a resumed session. */
  registrationId?: string;
}

export interface SessionRegistry {
  version: number;
  sessions: Record<string, SessionRegistryEntry>;
}

export function loadSessionRegistry(options: SessionRegistryLocationOptions = {}): SessionRegistry {
  const registryPath = getRegistryPath(options);
  try {
    if (fs.existsSync(registryPath)) {
      const data = fs.readFileSync(registryPath, 'utf-8');
      return normalizeRegistry(JSON.parse(data));
    }
  } catch (error) {
    console.error('Failed to load session registry:', error);
  }
  return { version: 2, sessions: {} };
}

function saveSessionRegistry(registry: SessionRegistry, options: SessionRegistryLocationOptions = {}): void {
  const registryPath = getRegistryPath(options);
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, registryPath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Renamed or already removed.
    }
  }
}

export function registerSession(
  sessionId: string,
  projectPath: string,
  options: SessionRegistryLocationOptions = {}
): string {
  return registerSessionState(sessionId, projectPath, false, options);
}

/** Register an already-completed imported session without making it look live. */
export function registerTerminalSession(
  sessionId: string,
  projectPath: string,
  options: SessionRegistryLocationOptions = {}
): string {
  return registerSessionState(sessionId, projectPath, true, options);
}

function registerSessionState(
  sessionId: string,
  projectPath: string,
  terminal: boolean,
  options: SessionRegistryLocationOptions
): string {
  return withRegistryLock(options, () => {
    const registry = loadSessionRegistry(options);
    const now = (options.now ?? (() => new Date()))().toISOString();
    const normalizedPath = normalizeProjectPath(projectPath);
    const existing = registry.sessions[sessionId];
    const registrationId = randomUUID();
    registry.version = 2;
    registry.sessions[sessionId] = {
      projectPath: normalizedPath,
      projectHash: hashProjectPath(normalizedPath),
      registeredAt: existing?.registeredAt ?? now,
      lastSeenAt: now,
      identityKind: identityKindFor(normalizedPath),
      terminal,
      registrationId
    };
    expireStaleNonTerminalEntries(registry.sessions, new Date(now));
    registry.sessions = pruneRegistryEntries(
      registry.sessions,
      new Date(now),
      path.join(options.homeDir ?? os.homedir(), '.claude-code', 'memory')
    );
    saveSessionRegistry(registry, options);
    return registrationId;
  });
}

/** Remove a transient session mapping without disturbing other registrations. */
export function unregisterSession(sessionId: string, options: SessionRegistryLocationOptions = {}): void {
  withRegistryLock(options, () => {
    const registry = loadSessionRegistry(options);
    if (!(sessionId in registry.sessions)) return;
    delete registry.sessions[sessionId];
    saveSessionRegistry(registry, options);
  });
}

/** Remove only the SessionStart generation observed by the caller. */
export function unregisterSessionIfCurrent(
  sessionId: string,
  registrationId: string,
  options: SessionRegistryLocationOptions = {}
): boolean {
  return withRegistryLock(options, () => {
    const registry = loadSessionRegistry(options);
    const entry = registry.sessions[sessionId];
    if (!entry || entry.registrationId !== registrationId) return false;
    delete registry.sessions[sessionId];
    saveSessionRegistry(registry, options);
    return true;
  });
}

/**
 * Mark only the SessionStart generation observed by the caller. A resumed
 * session receives a new registration ID and must not be closed by older,
 * still-running SessionEnd work.
 */
export function markSessionTerminalIfCurrent(
  sessionId: string,
  registrationId: string | null,
  options: SessionRegistryLocationOptions = {}
): boolean {
  return withRegistryLock(options, () => {
    const registry = loadSessionRegistry(options);
    const entry = registry.sessions[sessionId];
    if (!entry || (entry.registrationId ?? null) !== registrationId) return false;
    entry.terminal = true;
    entry.lastSeenAt = (options.now ?? (() => new Date()))().toISOString();
    registry.version = 2;
    saveSessionRegistry(registry, options);
    return true;
  });
}

/** Register a short-lived mapping and guarantee cleanup on success or failure. */
export async function withRegisteredSession<T>(
  sessionId: string,
  projectPath: string,
  action: () => Promise<T>,
  options: SessionRegistryLocationOptions = {}
): Promise<T> {
  const registrationId = registerSession(sessionId, projectPath, options);
  try {
    return await action();
  } finally {
    unregisterSessionIfCurrent(sessionId, registrationId, options);
  }
}

export function getSessionProject(
  sessionId: string,
  options: SessionRegistryLocationOptions = {}
): SessionRegistryEntry | null {
  const registry = loadSessionRegistry(options);
  return registry.sessions[sessionId] || null;
}

const SOFT_MAX_ENTRIES = 1_000;
const HARD_MAX_ENTRIES = 5_000;
const ACTIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const STALE_NON_TERMINAL_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeRegistry(value: unknown): SessionRegistry {
  if (!isRecord(value)) return { version: 2, sessions: {} };
  const input = value as Partial<SessionRegistry>;
  const sessions = isRecord(input.sessions)
    ? Object.fromEntries(Object.entries(input.sessions).flatMap(([sessionId, entry]) => {
      const normalized = normalizeRegistryEntry(entry);
      return normalized ? [[sessionId, normalized]] : [];
    }))
    : {};
  return { version: Number(input.version) >= 2 ? 2 : 1, sessions };
}

function normalizeRegistryEntry(value: unknown): SessionRegistryEntry | null {
  if (!isRecord(value)
    || typeof value.projectPath !== 'string'
    || typeof value.projectHash !== 'string'
    || typeof value.registeredAt !== 'string') return null;
  const entry: SessionRegistryEntry = {
    projectPath: value.projectPath,
    projectHash: value.projectHash,
    registeredAt: value.registeredAt
  };
  if (typeof value.lastSeenAt === 'string') entry.lastSeenAt = value.lastSeenAt;
  if (value.identityKind === 'memory-root-marker'
    || value.identityKind === 'git-common-dir'
    || value.identityKind === 'path-fallback') entry.identityKind = value.identityKind;
  if (typeof value.terminal === 'boolean') entry.terminal = value.terminal;
  if (typeof value.registrationId === 'string') entry.registrationId = value.registrationId;
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identityKindFor(projectPath: string): SessionRegistryEntry['identityKind'] {
  try {
    const kind = resolveCanonicalRepoIdentity(projectPath).kind;
    if (kind === 'memory-root-marker') return 'memory-root-marker';
    if (kind === 'path-fallback') return 'path-fallback';
    return 'git-common-dir';
  } catch {
    return 'path-fallback';
  }
}

function entryTime(entry: SessionRegistryEntry): number {
  const parsed = Date.parse(entry.lastSeenAt ?? entry.registeredAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pruneRegistryEntries(
  sessions: Record<string, SessionRegistryEntry>,
  now: Date,
  memoryRoot: string
): Record<string, SessionRegistryEntry> {
  const entries = Object.entries(sessions);
  if (entries.length <= SOFT_MAX_ENTRIES) return sessions;
  const recentCutoff = now.getTime() - ACTIVE_RETENTION_MS;
  const recentActive = entries.filter(([, entry]) => !entry.terminal && entryTime(entry) >= recentCutoff);
  // A session can remain relevant after SessionEnd because later imports or
  // deferred hook writes append project events without touching the registry.
  // Conservatively protect registry entries for stores whose SQLite DB/WAL has
  // recent activity, avoiding a database open or migration in this hot path.
  const activeProjectHashes = recentProjectActivityHashes(entries, memoryRoot, recentCutoff);
  const recentProjectEntries = entries.filter(([, entry]) => activeProjectHashes.has(entry.projectHash));
  const protectedSessionIds = new Set(
    [...recentActive, ...recentProjectEntries].map(([sessionId]) => sessionId)
  );
  const protectedEntries = entries
    .filter(([sessionId]) => protectedSessionIds.has(sessionId))
    .sort((a, b) => entryTime(b[1]) - entryTime(a[1]));
  const remainder = entries
    .filter(([sessionId]) => !protectedSessionIds.has(sessionId))
    .sort((a, b) => entryTime(b[1]) - entryTime(a[1]));
  const retained = [
    ...protectedEntries,
    ...remainder.slice(0, Math.max(0, SOFT_MAX_ENTRIES - protectedEntries.length))
  ]
    .slice(0, HARD_MAX_ENTRIES);
  return Object.fromEntries(retained);
}

/**
 * SessionEnd is best-effort and is unavailable for some import/MCP clients.
 * Keep the project mapping for late writes, but stop treating a registration
 * that has not been refreshed for a full week as a live cleanup protection.
 * A resumed session receives a fresh SessionStart registration and becomes
 * non-terminal again.
 */
function expireStaleNonTerminalEntries(
  sessions: Record<string, SessionRegistryEntry>,
  now: Date
): void {
  const cutoff = now.getTime() - STALE_NON_TERMINAL_SESSION_MS;
  for (const entry of Object.values(sessions)) {
    if (!entry.terminal && entryTime(entry) < cutoff) entry.terminal = true;
  }
}

function recentProjectActivityHashes(
  entries: Array<[string, SessionRegistryEntry]>,
  memoryRoot: string,
  cutoffMs: number
): Set<string> {
  const recent = new Set<string>();
  const hashes = new Set(entries.map(([, entry]) => entry.projectHash));
  for (const projectHash of hashes) {
    if (!/^[a-f0-9]{8}$/.test(projectHash)) continue;
    const storagePath = path.join(memoryRoot, 'projects', projectHash);
    if (!isOwnedProjectStore(storagePath, memoryRoot)) continue;
    for (const fileName of ['events.sqlite', 'events.sqlite-wal']) {
      try {
        const filePath = path.join(storagePath, fileName);
        const stat = fs.lstatSync(filePath);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs >= cutoffMs) {
          recent.add(projectHash);
          break;
        }
      } catch {
        // Missing/unreadable activity evidence is not a preservation signal.
      }
    }
  }
  return recent;
}

function isOwnedProjectStore(storagePath: string, memoryRoot: string): boolean {
  try {
    const stat = fs.lstatSync(storagePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const relative = path.relative(fs.realpathSync(memoryRoot), fs.realpathSync(storagePath));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function withRegistryLock<T>(options: SessionRegistryLocationOptions, action: () => T): T {
  const registryPath = getRegistryPath(options);
  const dir = path.dirname(registryPath);
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = `${registryPath}.lock`;
  const lock = new WorkerLock(lockPath);
  const deadline = Date.now() + 1_000;
  for (;;) {
    const acquired = lock.acquire();
    if (acquired.acquired) break;
    if (Date.now() >= deadline) throw new Error(`session registry is busy (holder pid: ${acquired.holderPid ?? 'unknown'})`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    return action();
  } finally {
    lock.release();
  }
}
