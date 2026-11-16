/**
 * Mongo Sync Config
 * Connection-string helpers for Mongo sync: redacting the URI and describing connection failures without leaking
 * credentials. Sync runs only from the `mongo-sync` CLI, which takes its connection settings from flags or
 * CLAUDE_MEMORY_MONGO_* env vars and does not persist them.
 */

import * as dns from 'dns';
import * as os from 'os';

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
