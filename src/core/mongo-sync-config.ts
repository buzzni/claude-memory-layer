/**
 * Mongo Sync Config
 * Persistent per-project config for enabling auto-sync from hooks (e.g., SessionEnd).
 *
 * Stored as JSON under the project's storagePath next to events.sqlite.
 * Note: This may include credentials in plaintext (MongoDB URI). Treat accordingly.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { MongoSyncDirection } from './mongo-sync-worker.js';

export type MongoSyncConfig = {
  version: 1;
  enabled: boolean;
  /** MongoDB connection URI (may include credentials). */
  uri: string;
  /** MongoDB database name. */
  dbName: string;
  /** Remote project key (shared across machines). */
  projectKey: string;
  /** push|pull|both */
  direction: MongoSyncDirection;
  /** Batch size for push/pull loops. */
  batchSize: number;
  /** If true, hooks will run a sync at SessionEnd. */
  autoSyncOnSessionEnd: boolean;
  createdAt: string;
  updatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s.length > 0 ? s : null;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.trunc(value);
    return n > 0 ? n : null;
  }
  if (typeof value === 'string') {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

function normalizeDirection(value: unknown): MongoSyncDirection | null {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase();
  if (v === 'push' || v === 'pull' || v === 'both') return v;
  return null;
}

export function getMongoSyncConfigPath(storagePath: string): string {
  return path.join(storagePath, 'mongo-sync.json');
}

export function readMongoSyncConfig(storagePath: string): MongoSyncConfig | null {
  const configPath = getMongoSyncConfigPath(storagePath);
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    if (!isRecord(raw)) return null;

    const version = raw.version;
    if (version !== 1) return null;

    const enabled = raw.enabled;
    if (typeof enabled !== 'boolean') return null;

    const uri = asNonEmptyString(raw.uri);
    const dbName = asNonEmptyString(raw.dbName);
    const projectKey = asNonEmptyString(raw.projectKey);
    const direction = normalizeDirection(raw.direction);
    const batchSize = asPositiveInt(raw.batchSize) ?? 500;
    const autoSyncOnSessionEnd = typeof raw.autoSyncOnSessionEnd === 'boolean' ? raw.autoSyncOnSessionEnd : true;
    const createdAt = asNonEmptyString(raw.createdAt) ?? new Date(0).toISOString();
    const updatedAt = asNonEmptyString(raw.updatedAt) ?? new Date(0).toISOString();

    if (!uri || !dbName || !projectKey || !direction) return null;

    return {
      version: 1,
      enabled,
      uri,
      dbName,
      projectKey,
      direction,
      batchSize,
      autoSyncOnSessionEnd,
      createdAt,
      updatedAt
    };
  } catch {
    return null;
  }
}

export function writeMongoSyncConfig(storagePath: string, config: Omit<MongoSyncConfig, 'version' | 'createdAt' | 'updatedAt'> & {
  createdAt?: string;
  updatedAt?: string;
}): MongoSyncConfig {
  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true });
  }

  const now = new Date().toISOString();
  const existing = readMongoSyncConfig(storagePath);

  const normalized: MongoSyncConfig = {
    version: 1,
    enabled: config.enabled,
    uri: config.uri,
    dbName: config.dbName,
    projectKey: config.projectKey,
    direction: config.direction,
    batchSize: config.batchSize,
    autoSyncOnSessionEnd: config.autoSyncOnSessionEnd,
    createdAt: config.createdAt ?? existing?.createdAt ?? now,
    updatedAt: config.updatedAt ?? now
  };

  const configPath = getMongoSyncConfigPath(storagePath);
  const tmpPath = `${configPath}.tmp`;

  // 0600: contains secrets (Mongo URI may embed credentials)
  fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);

  return normalized;
}

export function removeMongoSyncConfig(storagePath: string): boolean {
  const configPath = getMongoSyncConfigPath(storagePath);
  if (!fs.existsSync(configPath)) return false;
  fs.unlinkSync(configPath);
  return true;
}

export function redactMongoUri(uri: string): string {
  // mongodb://user:pass@host:port/  -> mongodb://user:***@host:port/
  // mongodb+srv://user:pass@host/  -> mongodb+srv://user:***@host/
  const schemeIdx = uri.indexOf('://');
  if (schemeIdx === -1) return uri;
  const atIdx = uri.indexOf('@', schemeIdx + 3);
  if (atIdx === -1) return uri;

  const creds = uri.slice(schemeIdx + 3, atIdx); // user:pass
  const colonIdx = creds.indexOf(':');
  if (colonIdx === -1) return uri;

  const prefix = uri.slice(0, schemeIdx + 3 + colonIdx + 1);
  const suffix = uri.slice(atIdx);
  return `${prefix}***${suffix}`;
}

