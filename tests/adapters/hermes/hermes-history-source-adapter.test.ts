import { describe, expect, it } from 'vitest';

import {
  assertSourceAdapterContract,
  validateSourceAdapterContract
} from '../../../src/core/source/index.js';
import {
  createHermesHistorySourceRef,
  hermesHistorySourceAdapter
} from '../../../src/adapters/hermes/source/index.js';
import { hermesHistorySourceAdapter as hermesHistorySourceAdapterFromBarrel } from '../../../src/adapters/hermes/index.js';

describe('Hermes history source adapter', () => {
  it('declares Hermes history source metadata and passes the reusable source adapter conformance suite', () => {
    expect(() => assertSourceAdapterContract(hermesHistorySourceAdapter)).not.toThrow();
    expect(validateSourceAdapterContract(hermesHistorySourceAdapter)).toEqual([]);

    expect(hermesHistorySourceAdapter.identity).toMatchObject({
      id: 'hermes-history',
      displayName: 'Hermes history',
      version: '1.0.0'
    });
    expect(hermesHistorySourceAdapter.source).toMatchObject({
      id: 'hermes-history',
      version: '1',
      privacyClass: 'confidential',
      captureMode: 'history_import',
      metadataSchema: 'hermes-sessiondb@1'
    });
    expect(hermesHistorySourceAdapter.transformations.map((transformation) => transformation.id)).toEqual([
      'hermes-sessiondb-to-cml-events',
      'hermes-history-privacy-filter'
    ]);
    expect(hermesHistorySourceAdapter.capabilities).toMatchObject({
      supportsIncrementalImport: true,
      currentnessStrategy: 'session-started-at-and-message-id',
      supportsLiveSync: false,
      sourcePathDisclosure: 'redacted'
    });
    expect(hermesHistorySourceAdapterFromBarrel).toBe(hermesHistorySourceAdapter);
  });

  it('creates privacy-safe source refs without exposing raw session ids or local state DB paths', () => {
    expect(hermesHistorySourceAdapter.sampleSourceRefs?.[0]).toMatchObject({
      kind: 'database',
      stableId: 'hermes-history:state-db',
      publicHandle: 'hermes-history:state-db',
      evidenceHandle: 'hermes-history:state-db',
      privacyClass: 'confidential',
      captureMode: 'history_import'
    });

    const messageRef = createHermesHistorySourceRef({
      sessionId: 'session-a',
      messageId: 42,
      hermesSource: 'cli'
    });

    expect(messageRef).toMatchObject({
      kind: 'message',
      stableId: expect.stringMatching(/^hermes-history:session:[a-f0-9]{12}:message:42$/),
      publicHandle: expect.stringMatching(/^hermes-history:session:[a-f0-9]{12}:message:42$/),
      evidenceHandle: expect.stringMatching(/^hermes-history:evidence:[a-f0-9]{12}:message:42$/),
      privacyClass: 'confidential',
      captureMode: 'history_import',
      metadata: {
        adapterId: 'hermes-history',
        hermesSource: 'cli',
        messageId: 42
      }
    });

    const pathLikeRef = createHermesHistorySourceRef({
      sessionId: '/Users/person/.hermes/state.db',
      messageId: 7,
      hermesSource: '/Users/person/.hermes/state.db'
    });
    const pathLikeMessageRef = createHermesHistorySourceRef({
      sessionId: 'session-a',
      messageId: '/Users/person/.hermes/state.db',
      hermesSource: 'cli'
    });
    const credentialLikeMessageRef = createHermesHistorySourceRef({
      sessionId: 'session-a',
      messageId: 'token=fixture',
      hermesSource: 'cli'
    });
    const bareCredentialLikeMessageRefs = [
      ['sk', 'fixture-value'].join('-'),
      ['ghp', 'fixturevalue'].join('_'),
      ['xoxb', 'fixture', 'value'].join('-'),
      ['eyJ', 'fixture', 'sig'].join('.'),
      ['sk', 'live', 'fixture'].join('_'),
      ['AI', 'za', 'fixture'].join('')
    ].map((messageId) => createHermesHistorySourceRef({
      sessionId: 'session-a',
      messageId,
      hermesSource: 'cli'
    }));
    const stateDbHandleMessageRef = createHermesHistorySourceRef({
      sessionId: 'session-a',
      messageId: 'event:state.db/source=cli',
      hermesSource: 'source=state.db/path=cli'
    });
    const delimitedPathMessageRef = createHermesHistorySourceRef({
      sessionId: 'session-a',
      messageId: 'event(/Users/alice/session.jsonl)',
      hermesSource: 'event[/tmp/private/session.jsonl]'
    });
    const punctuationDelimitedPathRefs = [
      'event-/Users/alice/session.jsonl',
      'event./Users/alice/session.jsonl',
      'event_/Users/alice/session.jsonl',
      'event/Users/alice/session.jsonl',
      'prefix/var/tmp/private.jsonl',
      'eventC:/Users/alice/session.jsonl',
      'event\\\\workstation\\Users\\person\\.hermes\\state.db',
      'event:Users/alice/session.jsonl',
      'Users/alice/.hermes/state.db',
      'prefix%2FUsers%2Falice%2F.hermes%2Fstate.db',
      'file%3A%2FUsers%2Falice%2F.hermes%2Fstate.db',
      'eventC%3A%5CUsers%5Calice%5C.hermes%5Cstate.db'
    ].map((value) => createHermesHistorySourceRef({
      sessionId: 'session-a',
      messageId: value,
      hermesSource: value
    }));
    const commonLocalSourceRefs = [
      '~/.hermes/state.db',
      '.hermes/state.db',
      'state.db',
      'file:/Users/person/.hermes/state.db'
    ].map((hermesSource) => createHermesHistorySourceRef({
      sessionId: 'session-a',
      messageId: 9,
      hermesSource
    }));
    const serializedRefs = JSON.stringify([
      messageRef,
      pathLikeRef,
      pathLikeMessageRef,
      credentialLikeMessageRef,
      bareCredentialLikeMessageRefs,
      stateDbHandleMessageRef,
      delimitedPathMessageRef,
      punctuationDelimitedPathRefs,
      commonLocalSourceRefs,
      hermesHistorySourceAdapter.sampleSourceRefs
    ]);

    expect(pathLikeMessageRef.publicHandle).toMatch(/^hermes-history:session:[a-f0-9]{12}:message:hash-[a-f0-9]{12}$/);
    expect(pathLikeMessageRef.metadata?.messageId).toEqual(expect.stringMatching(/^hash-[a-f0-9]{12}$/));
    expect(credentialLikeMessageRef.publicHandle).toMatch(/^hermes-history:session:[a-f0-9]{12}:message:hash-[a-f0-9]{12}$/);
    expect(credentialLikeMessageRef.metadata?.messageId).toEqual(expect.stringMatching(/^hash-[a-f0-9]{12}$/));
    expect(bareCredentialLikeMessageRefs.every((ref) => /^hermes-history:session:[a-f0-9]{12}:message:hash-[a-f0-9]{12}$/.test(ref.publicHandle))).toBe(true);
    expect(bareCredentialLikeMessageRefs.every((ref) => String(ref.metadata?.messageId).startsWith('hash-'))).toBe(true);
    expect(stateDbHandleMessageRef.publicHandle).toMatch(/^hermes-history:session:[a-f0-9]{12}:message:hash-[a-f0-9]{12}$/);
    expect(stateDbHandleMessageRef.metadata?.messageId).toEqual(expect.stringMatching(/^hash-[a-f0-9]{12}$/));
    expect(stateDbHandleMessageRef.metadata?.hermesSource).toBe('redacted');
    expect(delimitedPathMessageRef.publicHandle).toMatch(/^hermes-history:session:[a-f0-9]{12}:message:hash-[a-f0-9]{12}$/);
    expect(delimitedPathMessageRef.metadata?.messageId).toEqual(expect.stringMatching(/^hash-[a-f0-9]{12}$/));
    expect(delimitedPathMessageRef.metadata?.hermesSource).toBe('redacted');
    expect(punctuationDelimitedPathRefs.every((ref) => /^hermes-history:session:[a-f0-9]{12}:message:hash-[a-f0-9]{12}$/.test(ref.publicHandle))).toBe(true);
    expect(punctuationDelimitedPathRefs.every((ref) => String(ref.metadata?.messageId).startsWith('hash-'))).toBe(true);
    expect(punctuationDelimitedPathRefs.every((ref) => ref.metadata?.hermesSource === 'redacted')).toBe(true);
    expect(commonLocalSourceRefs.every((ref) => ref.metadata?.hermesSource === 'redacted')).toBe(true);

    expect(serializedRefs).not.toContain('session-a');
    expect(serializedRefs).not.toContain('/Users/person');
    expect(serializedRefs).not.toContain('.hermes');
    expect(serializedRefs).not.toContain('state.db');
    expect(serializedRefs).not.toContain('token');
    expect(serializedRefs).not.toContain('fixture');
    expect(serializedRefs).not.toContain('sk-');
    expect(serializedRefs).not.toContain('ghp_');
    expect(serializedRefs).not.toContain('xoxb-');
    expect(serializedRefs).not.toContain('%2FUsers');
    expect(serializedRefs).not.toContain('%5CUsers');
    expect(serializedRefs).not.toContain('AIza');
    expect(serializedRefs).not.toContain('sk_live');
    expect(serializedRefs).not.toContain('eyJ');
  });
});
