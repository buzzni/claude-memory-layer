/**
 * Mongo connection strings carry secrets in two places: the password in `user:pass@` and query options such as
 * `tlsCertificateKeyFilePassword`. The driver also echoes the whole string in its own errors, so a connection failure
 * must not print either.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { redactMongoSecrets, redactMongoUri } from '../../src/core/mongo-sync-config.js';
import { MongoSyncWorker } from '../../src/core/mongo-sync-worker.js';
import { SQLiteEventStore } from '../../src/core/sqlite-event-store.js';

describe('redactMongoUri', () => {
  it('masks the password', () => {
    expect(redactMongoUri('mongodb://user:pass@db.example:27017/')).toBe('mongodb://user:***@db.example:27017/');
    expect(redactMongoUri('mongodb+srv://user:pass@cluster.example/app')).toBe('mongodb+srv://user:***@cluster.example/app');
  });

  it('masks every query option value and keeps the option names', () => {
    expect(redactMongoUri('mongodb://u:p@127.0.0.1:1/?tlsCertificateKeyFilePassword=s3cr3t&replicaSet=rs0'))
      .toBe('mongodb://u:***@127.0.0.1:1/?tlsCertificateKeyFilePassword=***&replicaSet=***');
  });

  it('masks query values when the string has no credentials', () => {
    expect(redactMongoUri('mongodb://127.0.0.1:27017/?authMechanismProperties=AWS_SESSION_TOKEN:tok'))
      .toBe('mongodb://127.0.0.1:27017/?authMechanismProperties=***');
  });

  it('leaves a string without secrets unchanged', () => {
    expect(redactMongoUri('mongodb://127.0.0.1:27017/')).toBe('mongodb://127.0.0.1:27017/');
  });
});

describe('redactMongoSecrets', () => {
  const uri = 'mongodb://u:pa55word@127.0.0.1:1/?tlsCertificateKeyFilePassword=s3cr3t';

  it('replaces the echoed connection string with the redacted one', () => {
    expect(redactMongoSecrets(`MongoParseError: bad "${uri}"`, uri))
      .toBe('MongoParseError: bad "mongodb://u:***@127.0.0.1:1/?tlsCertificateKeyFilePassword=***"');
  });

  it('removes secret values that appear on their own', () => {
    const text = redactMongoSecrets('auth failed for pa55word; key password s3cr3t rejected', uri);
    expect(text).not.toContain('pa55word');
    expect(text).not.toContain('s3cr3t');
  });

  it('also catches percent-encoded secrets in their decoded form', () => {
    const encoded = 'mongodb://u:p%40ss1@127.0.0.1:1/';
    expect(redactMongoSecrets('login p@ss1 failed', encoded)).not.toContain('p@ss1');
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

  it('does not leak the password or query secrets in the thrown error', async () => {
    // An empty host list makes the driver throw while parsing, and its message quotes the whole string.
    const worker = new MongoSyncWorker(store, {
      uri: 'mongodb://u:pa55word@/?tlsCertificateKeyFilePassword=s3cr3t',
      dbName: 'x',
      projectKey: 'p'
    });

    const error = await worker.syncNow().then(() => null, (err: unknown) => err as Error);
    expect(error?.message).toContain('MongoDB connection failed');
    expect(error?.message).not.toContain('pa55word');
    expect(error?.message).not.toContain('s3cr3t');
  });
});
