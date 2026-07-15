/**
 * Session registry for mapping Claude session IDs to project-local storage.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hashProjectPath, normalizeProjectPath } from './project-path.js';

export interface SessionRegistryLocationOptions {
  homeDir?: string;
}

function getRegistryPath(options: SessionRegistryLocationOptions = {}): string {
  return path.join(options.homeDir ?? os.homedir(), '.claude-code', 'memory', 'session-registry.json');
}

export interface SessionRegistryEntry {
  projectPath: string;
  projectHash: string;
  registeredAt: string;
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
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Failed to load session registry:', error);
  }
  return { version: 1, sessions: {} };
}

function saveSessionRegistry(registry: SessionRegistry, options: SessionRegistryLocationOptions = {}): void {
  const registryPath = getRegistryPath(options);
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempPath = registryPath + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, registryPath);
}

export function registerSession(
  sessionId: string,
  projectPath: string,
  options: SessionRegistryLocationOptions = {}
): void {
  const registry = loadSessionRegistry(options);

  registry.sessions[sessionId] = {
    projectPath: normalizeProjectPath(projectPath),
    projectHash: hashProjectPath(projectPath),
    registeredAt: new Date().toISOString()
  };

  const entries = Object.entries(registry.sessions);
  if (entries.length > 1000) {
    const sorted = entries.sort((a, b) =>
      new Date(b[1].registeredAt).getTime() - new Date(a[1].registeredAt).getTime()
    );
    registry.sessions = Object.fromEntries(sorted.slice(0, 1000));
  }

  saveSessionRegistry(registry, options);
}

/** Remove a transient session mapping without disturbing other registrations. */
export function unregisterSession(sessionId: string, options: SessionRegistryLocationOptions = {}): void {
  const registry = loadSessionRegistry(options);
  if (!(sessionId in registry.sessions)) return;

  delete registry.sessions[sessionId];
  saveSessionRegistry(registry, options);
}

/** Register a short-lived mapping and guarantee cleanup on success or failure. */
export async function withRegisteredSession<T>(
  sessionId: string,
  projectPath: string,
  action: () => Promise<T>,
  options: SessionRegistryLocationOptions = {}
): Promise<T> {
  registerSession(sessionId, projectPath, options);
  try {
    return await action();
  } finally {
    unregisterSession(sessionId, options);
  }
}

export function getSessionProject(
  sessionId: string,
  options: SessionRegistryLocationOptions = {}
): SessionRegistryEntry | null {
  const registry = loadSessionRegistry(options);
  return registry.sessions[sessionId] || null;
}
