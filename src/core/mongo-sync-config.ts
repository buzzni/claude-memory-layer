/**
 * Mongo Sync Config
 * Persistent per-project config for enabling auto-sync from hooks (e.g., SessionEnd).
 *
 * Stored as JSON under the project's storagePath next to events.sqlite.
 * Note: This may include credentials in plaintext (MongoDB URI). Treat accordingly.
 */

import * as dns from 'dns';
import * as fs from 'fs';
import * as os from 'os';
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

const UNPARSEABLE_URI = '<unparseable MongoDB connection string>';

interface MongoUriParts {
  scheme: string;
  username: string | null;
  password: string | null;
  hosts: string;
  path: string;
  query: string | null;
}

/**
 * Splits a connection string only when its structure is unambiguous. A well-formed string percent-encodes `@`, `/`,
 * `?` and `:` inside credentials, so any `@` outside the authority means a password the driver will also reject, and
 * guessing its end would show part of it.
 */
function splitMongoUri(uri: string): MongoUriParts | null {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/is.exec(uri);
  if (!match) return null;
  const [, scheme, rest] = match;

  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const remainder = authorityEnd === -1 ? '' : rest.slice(authorityEnd);
  if (remainder.includes('@') || authority.indexOf('@') !== authority.lastIndexOf('@')) return null;

  const atIdx = authority.indexOf('@');
  const creds = atIdx === -1 ? null : authority.slice(0, atIdx);
  const hosts = authority.slice(atIdx + 1);
  if (!hosts) return null;

  const colonIdx = creds?.indexOf(':') ?? -1;
  const queryIdx = remainder.indexOf('?');
  return {
    scheme,
    username: creds === null ? null : colonIdx === -1 ? creds : creds.slice(0, colonIdx),
    password: creds === null || colonIdx === -1 ? null : creds.slice(colonIdx + 1),
    hosts,
    path: queryIdx === -1 ? remainder : remainder.slice(0, queryIdx),
    query: queryIdx === -1 ? null : remainder.slice(queryIdx + 1)
  };
}

export function redactMongoUri(uri: string): string {
  // mongodb://user:pass@host:port/db?opts  -> mongodb://user:***@host:port/db?***
  // Option names are hidden too: they can contain the password, and values like tlsCertificateKeyFilePassword are secrets.
  const parts = splitMongoUri(uri);
  if (!parts) return UNPARSEABLE_URI;
  const creds = parts.username === null ? '' : parts.password === null ? `${parts.username}@` : `${parts.username}:***@`;
  const query = parts.query === null ? '' : '?***';
  return `${parts.scheme}${creds}${parts.hosts}${parts.path}${query}`;
}

// Errors the driver raises while parsing the string or its options. They get a hint instead of their text.
const PARSE_ERROR_NAMES = new Set([
  'MongoParseError',
  'MongoInvalidArgumentError',
  'MongoAPIError',
  'MongoRuntimeError',
  'MongoMissingCredentialsError',
  'TypeError',
  'URIError'
]);
const PARSE_HINT = 'connection string could not be parsed; percent-encode special characters in the password and check option names';

// OS errno codes plus the resolver's (ENOTFOUND, EAI_AGAIN, ...), which are not errno values.
const ERRNO_CODES = new Set([
  ...Object.keys(os.constants.errno),
  ...(Object.values(dns) as unknown[]).filter((value): value is string => typeof value === 'string' && /^E[A-Z_]+$/.test(value)),
  'EAI_AGAIN'
]);
/**
 * The reason to print for a failed connection to `uri`. The driver's text is never printed: it quotes the connection
 * string, or pieces of it decoded, lowercased, normalized or split, in more forms than can be scrubbed. Instead the
 * reason is the error name plus structured codes along the `cause` chain (errno and resolver codes, the server's code
 * name). Nothing is read from message text, where an option value can look like a code. The hosts are already in the
 * redacted URI printed next to it.
 */
export function describeMongoConnectionError(error: unknown, uri: string): string {
  const name = error instanceof Error ? error.name : 'Error';
  if (!splitMongoUri(uri) || PARSE_ERROR_NAMES.has(name)) return `${name}: ${PARSE_HINT}`;
  const facts = connectionErrorFacts(error);
  return facts.length > 0 ? `${name} (${facts.join(', ')})` : name;
}

function connectionErrorFacts(error: unknown): string[] {
  const facts = new Set<string>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const { code, codeName } = current as { code?: unknown; codeName?: unknown };
    if (typeof code === 'string' && ERRNO_CODES.has(code)) facts.add(code);
    if (typeof codeName === 'string' && /^[A-Za-z]+$/.test(codeName)) facts.add(codeName);
    current = (current as { cause?: unknown }).cause;
  }
  return [...facts];
}
