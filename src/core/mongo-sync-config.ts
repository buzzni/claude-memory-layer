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

// Errors the driver raises while parsing the string. Their text quotes the string or its pieces in decoded,
// lowercased or split forms, so none of it is printed.
const PARSE_ERROR_NAMES = new Set(['MongoParseError', 'MongoInvalidArgumentError', 'MongoAPIError', 'TypeError']);

/**
 * The reason to print for a failed connection to `uri`. Parse failures, and any failure on a string that cannot be
 * split unambiguously, are reduced to the error name; other errors (network, auth) keep their text with the
 * connection string and its secrets removed.
 */
export function describeMongoConnectionError(error: unknown, uri: string): string {
  const name = error instanceof Error ? error.name : 'Error';
  const parts = splitMongoUri(uri);
  if (!parts || PARSE_ERROR_NAMES.has(name)) {
    return `${name}: connection string could not be parsed; percent-encode special characters in the password and check option names`;
  }
  const text = error instanceof Error ? `${name}: ${error.message}` : String(error);
  return removeSecrets(text.split(uri).join(redactMongoUri(uri)), mongoUriSecrets(parts));
}

// Options whose values are secrets. Other values (maxPoolSize=1, replicaSet=rs0) stay readable in network errors.
const SECRET_OPTION_PATTERN = /pass|secret|token|key|cred|auth/i;

function mongoUriSecrets(parts: MongoUriParts): string[] {
  const raw: string[] = [];
  if (parts.password) raw.push(parts.password);
  for (const pair of parts.query?.split('&') ?? []) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    if (SECRET_OPTION_PATTERN.test(decodeLoosely(pair.slice(0, eqIdx)))) raw.push(pair.slice(eqIdx + 1));
  }

  const secrets = new Set<string>();
  for (const value of raw) {
    // Raw, percent-decoded and form-decoded (+ as space), whole and split into the KEY:value components the driver
    // reports one at a time.
    for (const form of [value, decodeLoosely(value), decodeLoosely(value.replace(/\+/g, ' '))]) {
      secrets.add(form);
      for (const component of form.split(/[,:]/)) secrets.add(component);
    }
  }
  // Longest first, so a secret that contains another is replaced whole.
  return [...secrets].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
}

/** decodeURIComponent that keeps going past malformed escapes, the way the driver's decoder does (U+FFFD). */
function decodeLoosely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/(%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return '�';
      }
    });
  }
}

/** Case-insensitive, no regex: a secret can be any length, and the driver lowercases option names. */
function removeSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.toLowerCase().length !== secret.length || result.toLowerCase().length !== result.length) {
      // Case folding changed the length (e.g. U+0130), so indices would not line up: replace exact forms instead.
      for (const form of [secret, secret.toLowerCase(), secret.toUpperCase()]) result = result.split(form).join('***');
      continue;
    }
    const needle = secret.toLowerCase();
    let lower = result.toLowerCase();
    let idx = lower.indexOf(needle);
    while (idx !== -1) {
      result = `${result.slice(0, idx)}***${result.slice(idx + secret.length)}`;
      lower = result.toLowerCase();
      idx = lower.indexOf(needle, idx + 3);
    }
  }
  return result;
}
