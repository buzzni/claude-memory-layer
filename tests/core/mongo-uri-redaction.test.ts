/**
 * Mongo connection strings carry secrets in the password (`user:pass@`) and in query options such as
 * `tlsCertificateKeyFilePassword`. The driver echoes the string, decoded and reshaped, in its own errors, so a
 * connection failure must print neither the string nor any part of the driver's parse error.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describeMongoConnectionError, redactMongoUri } from '../../src/core/mongo-sync-config.js';
import { MongoSyncWorker } from '../../src/core/mongo-sync-worker.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('redactMongoUri', () => {
  it('masks the password and keeps user, hosts and database', () => {
    expect(redactMongoUri('mongodb://user:pass@db.example:27017/app')).toBe('mongodb://user:***@db.example:27017/app');
    expect(redactMongoUri('mongodb+srv://user:pass@cluster.example/app')).toBe('mongodb+srv://user:***@cluster.example/app');
  });

  it('hides the whole query, option names included', () => {
    expect(redactMongoUri('mongodb://u:xy@h1:1,h2:2/?xySuffix=1&tlsCertificateKeyFilePassword=s3cr3t'))
      .toBe('mongodb://u:***@h1:1,h2:2/?***');
  });

  it('leaves a string without secrets unchanged', () => {
    expect(redactMongoUri('mongodb://127.0.0.1:27017/')).toBe('mongodb://127.0.0.1:27017/');
  });

  it.each([
    'mongodb://u:prefix@tail@/?tlsCertificateKeyFilePassword=keysecret',
    'mongodb://u:prefix?tail@localhost/',
    'mongodb://u:pre/fix@localhost/',
    'mongodb://u:pw123@localhost/?authMechanism=TopSecret@tail',
    'not a connection string with pa55word'
  ])('refuses to show a string it cannot split unambiguously: %s', (uri) => {
    expect(redactMongoUri(uri)).toBe('<unparseable MongoDB connection string>');
  });
});

describe('describeMongoConnectionError', () => {
  it('drops the driver text of a parse failure, which quotes the connection string', () => {
    const uri = 'mongodb://u:pa55word@/?tlsCertificateKeyFilePassword=s3cr3t';
    const reason = describeMongoConnectionError(
      namedError('MongoParseError', `Protocol and host list are required in "${uri}"`),
      uri
    );
    expect(reason).toContain('MongoParseError');
    expect(reason).not.toMatch(/pa55word|s3cr3t/);
  });

  it.each([
    ['MongoParseError', 'Expected maxPoolSize to be stringified int value, got: abc'],
    ['MongoParseError', 'option secretsuffix is not supported'],
    ['MongoInvalidArgumentError', 'privateToken is not a valid compression mechanism'],
    ['MongoAPIError', 'Invalid CANONICALIZE_HOST_NAME value: TopSecret'],
    ['TypeError', 'Invalid URL: mongodb://u:prefix@tail@/']
  ])('treats %s as a parse failure and prints none of its text', (name, message) => {
    const reason = describeMongoConnectionError(namedError(name, message), 'mongodb://u:abc@localhost/?secretSuffix=1');
    expect(reason).not.toContain(message);
    expect(reason).toMatch(/could not be parsed/);
  });

  it('never prints driver text for a string it cannot split, whatever the error', () => {
    const uri = 'mongodb://u:pw123@localhost/?authMechanism=TopSecret@tail';
    const reason = describeMongoConnectionError(namedError('MongoServerSelectionError', 'got TopSecret@tail'), uri);
    expect(reason).not.toMatch(/TopSecret|tail|pw123/);
  });

  it('keeps a network error readable and scrubs the password from it', () => {
    const uri = 'mongodb://u:pa55word@127.0.0.1:1/?maxPoolSize=1';
    const reason = describeMongoConnectionError(
      namedError('MongoServerSelectionError', `connect ECONNREFUSED 127.0.0.1:1 for ${uri} (PA55WORD)`),
      uri
    );
    expect(reason).toContain('connect ECONNREFUSED 127.0.0.1:1');
    expect(reason).not.toMatch(/pa55word/i);
  });

  it('scrubs decoded and component forms of secret option values', () => {
    const uri = 'mongodb://h/?%61uthMechanismProperties=AWS_SESSION_TOKEN:T0p%2BSecret&tlsCertificateKeyFilePassword=a+b';
    const reason = describeMongoConnectionError(
      namedError('MongoServerSelectionError', 'auth with T0p+Secret and "a b" failed'),
      uri
    );
    expect(reason).not.toMatch(/T0p\+Secret|a b/);
  });

  it('handles a huge password without building a regex from it', () => {
    const password = 'x'.repeat(60_000);
    const uri = `mongodb://u:${password}@127.0.0.1:1/`;
    const reason = describeMongoConnectionError(namedError('MongoServerSelectionError', `bad ${password}`), uri);
    expect(reason).not.toContain(password);
  });
});

describe('MongoSyncWorker connection failure', () => {
  let tempDir: string;
  let store: SQLiteEventStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-mongo-redact-'));
    store = new SQLiteEventStore(path.join(tempDir, 'events.sqlite'));
    await store.initialize();
  });

  afterEach(async () => {
    try { await store.close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    'mongodb://u:pa55word@/?tlsCertificateKeyFilePassword=s3cr3t',
    'mongodb://u:pa55word@localhost/?maxPoolSize=pa55word',
    'mongodb://u:pa55word@localhost/?pa55wordSuffix=1',
    'mongodb://u:pa55word@localhost/?authMechanismProperties=CANONICALIZE_HOST_NAME:s3cr3t'
  ])('does not leak secrets when the real driver rejects %s', async (uri) => {
    const worker = new MongoSyncWorker(store, { uri, dbName: 'x', projectKey: 'p' });

    const error = await worker.syncNow().then(() => null, (err: unknown) => err as Error);
    expect(error?.message).toContain('MongoDB connection failed');
    expect(error?.message).not.toMatch(/pa55word|s3cr3t/i);
  });
});
