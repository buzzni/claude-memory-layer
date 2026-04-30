/**
 * Session registry for mapping Claude session IDs to project-local storage.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hashProjectPath, normalizeProjectPath } from './project-path.js';

const REGISTRY_PATH = path.join(os.homedir(), '.claude-code', 'memory', 'session-registry.json');

export interface SessionRegistryEntry {
  projectPath: string;
  projectHash: string;
  registeredAt: string;
}

export interface SessionRegistry {
  version: number;
  sessions: Record<string, SessionRegistryEntry>;
}

export function loadSessionRegistry(): SessionRegistry {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const data = fs.readFileSync(REGISTRY_PATH, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Failed to load session registry:', error);
  }
  return { version: 1, sessions: {} };
}

function saveSessionRegistry(registry: SessionRegistry): void {
  const dir = path.dirname(REGISTRY_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempPath = REGISTRY_PATH + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2));
  fs.renameSync(tempPath, REGISTRY_PATH);
}

export function registerSession(sessionId: string, projectPath: string): void {
  const registry = loadSessionRegistry();

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

  saveSessionRegistry(registry);
}

export function getSessionProject(sessionId: string): SessionRegistryEntry | null {
  const registry = loadSessionRegistry();
  return registry.sessions[sessionId] || null;
}
