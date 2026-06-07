import { describe, expect, it } from 'vitest';

import {
  SOURCE_CAPTURE_MODES,
  SOURCE_PRIVACY_CLASSES,
  SOURCE_TRANSFORMATION_KINDS,
  assertSourceAdapterContract,
  createSourceRef,
  defineSourceAdapter,
  defineSourceSchema,
  defineSourceTransformations,
  isSourceCaptureMode,
  isSourcePrivacyClass,
  isSourceTransformationKind,
  validateSourceAdapterContract,
  validateSourceRef,
  type SourceAdapterContract
} from '../../src/core/source/index.js';
import { assertSourceAdapterContract as exportedAssertSourceAdapterContract } from '../../src/core/index.js';

function validAdapter(overrides: Partial<SourceAdapterContract> = {}): SourceAdapterContract {
  return {
    identity: {
      id: 'codex-session-importer',
      displayName: 'Codex session importer',
      version: '1.0.0'
    },
    source: defineSourceSchema({
      id: 'codex-session',
      version: '1',
      privacyClass: 'internal',
      captureMode: 'snapshot'
    }),
    transformations: defineSourceTransformations([
      {
        id: 'codex-session-to-raw-event',
        version: '1.0.0',
        kind: 'normalize',
        inputSchema: 'codex-session@1',
        outputSchema: 'raw-event@1',
        deterministic: true
      }
    ]),
    sampleSourceRefs: [
      createSourceRef({
        kind: 'session',
        stableId: 'codex-session:2026-06-07T10-00-00Z',
        publicHandle: 'codex-session:2026-06-07T10-00-00Z',
        evidenceHandle: 'event:codex-session:2026-06-07T10-00-00Z',
        privacyClass: 'internal',
        captureMode: 'snapshot'
      })
    ],
    capabilities: {
      currentnessStrategy: 'session-id-and-message-cursor',
      supportsIncrementalImport: true
    },
    ...overrides
  };
}

describe('source adapter core contract', () => {
  it('requires stable adapter identity and version and exports the contract from core', () => {
    expect(() => assertSourceAdapterContract(validAdapter())).not.toThrow();
    expect(exportedAssertSourceAdapterContract).toBe(assertSourceAdapterContract);

    expect(validateSourceAdapterContract(validAdapter({ identity: { id: '', version: '1.0.0' } })).map((v) => v.code))
      .toContain('identity.id.required');
    expect(validateSourceAdapterContract(validAdapter({ identity: { id: 'codex', version: '' } })).map((v) => v.code))
      .toContain('identity.version.required');
    expect(validateSourceAdapterContract(validAdapter({ identity: { id: '/Users/person/raw/session.json', version: '1.0.0' } })).map((v) => v.code))
      .toContain('identity.id.unstable');
  });

  it('keeps public source contract enum arrays immutable at runtime', () => {
    function expectRuntimeImmutable(
      values: readonly string[],
      injectedValue: string,
      acceptsInjectedValue: (value: unknown) => boolean
    ): void {
      const mutableValues = values as unknown as string[];
      const before = [...mutableValues];
      let mutationThrew = false;
      try {
        mutableValues.push(injectedValue);
      } catch {
        mutationThrew = true;
      }
      const acceptedAfterMutationAttempt = acceptsInjectedValue(injectedValue);
      if (!Object.isFrozen(values)) {
        mutableValues.splice(0, mutableValues.length, ...before);
      }

      expect(Object.isFrozen(values)).toBe(true);
      expect(mutationThrew).toBe(true);
      expect(acceptedAfterMutationAttempt).toBe(false);
      expect([...values]).toEqual(before);
    }

    expectRuntimeImmutable(SOURCE_PRIVACY_CLASSES, 'private', isSourcePrivacyClass);
    expectRuntimeImmutable(SOURCE_CAPTURE_MODES, 'mirror', isSourceCaptureMode);
    expectRuntimeImmutable(SOURCE_TRANSFORMATION_KINDS, 'custom-script', isSourceTransformationKind);
  });

  it('exposes source refs with stable ids without leaking local absolute paths in public or evidence handles', () => {
    const ref = createSourceRef({
      kind: 'file',
      stableId: 'claude-jsonl:session-123',
      publicHandle: 'claude-jsonl:session-123',
      evidenceHandle: 'event:session-123:42',
      privacyClass: 'confidential',
      captureMode: 'snapshot'
    });

    expect(ref.stableId).toBe('claude-jsonl:session-123');
    expect(ref.publicHandle).toBe('claude-jsonl:session-123');
    expect(validateSourceRef(ref)).toEqual([]);

    const violations = validateSourceRef({
      ...ref,
      publicHandle: '/tmp/private/session.jsonl',
      evidenceHandle: 'C:\\Users\\person\\session.jsonl'
    });

    expect(violations.map((v) => v.code)).toEqual(expect.arrayContaining([
      'sourceRef.publicHandle.absolute_local_path',
      'sourceRef.evidenceHandle.absolute_local_path'
    ]));

    for (const leakedHandle of [
      '/root/private/session.jsonl',
      '/data/private/session.jsonl',
      'file:///Users/person/session.jsonl',
      'file:/Users/person/session.jsonl'
    ]) {
      expect(validateSourceRef({
        ...ref,
        publicHandle: leakedHandle,
        evidenceHandle: leakedHandle
      }).map((v) => v.code)).toEqual(expect.arrayContaining([
        'sourceRef.publicHandle.absolute_local_path',
        'sourceRef.evidenceHandle.absolute_local_path'
      ]));
    }

    for (const prefixedLeakedHandle of [
      'event:/Users/person/.hermes/state.db',
      'hermes-history:source:file:/Users/person/.hermes/state.db',
      'event:C:\\Users\\person\\.hermes\\state.db',
      'event:\\\\workstation\\Users\\person\\.hermes\\state.db',
      'event(/Users/alice/session.jsonl)',
      'event[/tmp/private/session.jsonl]',
      'event</Users/alice/session.jsonl>',
      'event-/Users/alice/session.jsonl',
      'event./Users/alice/session.jsonl',
      'event_/Users/alice/session.jsonl',
      'event/Users/alice/session.jsonl',
      'prefix/var/tmp/private.jsonl',
      'source/tmp/private/session.jsonl',
      'eventC:/Users/alice/session.jsonl',
      'event\\\\workstation\\Users\\person\\.hermes\\state.db',
      'event:Users/alice/session.jsonl',
      'Users/alice/.hermes/state.db',
      'prefix%2FUsers%2Falice%2F.hermes%2Fstate.db',
      'prefix%2FUsers%2Falice%2F.hermes%2Fstate.db%ZZ',
      'prefix%252FUsers%252Falice%252F.hermes%252Fstate.db',
      'prefix%252FUsers%252Falice%252F.hermes%252Fstate.db%ZZ',
      'file%3A%2FUsers%2Falice%2F.hermes%2Fstate.db',
      'eventC%3A%5CUsers%5Calice%5C.hermes%5Cstate.db'
    ]) {
      expect(validateSourceRef({
        ...ref,
        stableId: prefixedLeakedHandle,
        publicHandle: prefixedLeakedHandle,
        evidenceHandle: prefixedLeakedHandle
      }).map((v) => v.code)).toEqual(expect.arrayContaining([
        'sourceRef.stableId.absolute_local_path',
        'sourceRef.publicHandle.absolute_local_path',
        'sourceRef.evidenceHandle.absolute_local_path'
      ]));
    }
  });

  it('rejects source ref handles and metadata that leak local state or credentials', () => {
    const ref = createSourceRef({
      kind: 'session',
      stableId: 'hermes-history:session:hash-abc123',
      publicHandle: 'hermes-history:session:hash-abc123',
      evidenceHandle: 'event:hash-abc123:1',
      privacyClass: 'confidential',
      captureMode: 'history_import',
      metadata: {
        source: 'hermes-history'
      }
    });

    const syntheticCredentialHandles = [
      ['eyJ', 'fixture', 'sig'].join('.'),
      ['sk', 'live', 'fixture'].join('_'),
      ['AI', 'za', 'fixture'].join('')
    ];

    for (const sensitiveHandle of [
      '~/.hermes/state.db',
      'file:C:/Users/person/state.db',
      'event:state.db',
      'source=state.db',
      'path:state.db',
      'event:state.db/source=cli',
      'source=state.db/path=cli',
      'path:state.db:1',
      'event:postgres://user:***@example.com/db',
      'source=postgres://user:***@example.com/db',
      'token=fixture',
      'token%3Dfixture',
      'token%3Dfixture%ZZ',
      'token%253Dfixture',
      'token%253Dfixture%ZZ',
      'api_key=fixture',
      'api_key%3Dfixture%ZZ',
      ...syntheticCredentialHandles
    ]) {
      expect(validateSourceRef({
        ...ref,
        stableId: sensitiveHandle,
        publicHandle: sensitiveHandle,
        evidenceHandle: sensitiveHandle
      }).map((v) => v.code)).toEqual(expect.arrayContaining([
        'sourceRef.stableId.privacy_sensitive',
        'sourceRef.publicHandle.privacy_sensitive',
        'sourceRef.evidenceHandle.privacy_sensitive'
      ]));
    }

    expect(validateSourceRef({
      ...ref,
      metadata: {
        importedFrom: '~/.hermes/state.db',
        token: 'fixture'
      }
    }).map((v) => v.code)).toEqual(expect.arrayContaining([
      'sourceRef.metadata.privacy_sensitive'
    ]));

    expect(validateSourceRef({
      ...ref,
      metadata: {
        nested: { raw: '/Users/person/.hermes/state.db' } as never
      }
    }).map((v) => v.code)).toContain('sourceRef.metadata.invalid_value');

    const metadataKeyViolations = validateSourceRef({
      ...ref,
      metadata: {
        '/Users/person/.hermes/state.db': 'redacted'
      } as never
    });
    expect(metadataKeyViolations.map((v) => v.code)).toContain('sourceRef.metadata.privacy_sensitive');
    expect(JSON.stringify(metadataKeyViolations)).not.toContain('/Users/person');

    expect(validateSourceRef({
      ...ref,
      metadata: {
        token: 123456
      }
    }).map((v) => v.code)).toContain('sourceRef.metadata.privacy_sensitive');

    for (const metadata of [
      { 'state.db/path': 'redacted' } as never,
      { importedFrom: 'state.db/path' },
      { importedFrom: 'source=state.db/path=cli' },
      { importedFrom: 'event(/Users/alice/session.jsonl)' },
      { importedFrom: 'event[/tmp/private/session.jsonl]' },
      { importedFrom: 'event-/Users/alice/session.jsonl' },
      { importedFrom: 'event./Users/alice/session.jsonl' },
      { importedFrom: 'event_/Users/alice/session.jsonl' },
      { importedFrom: 'event/Users/alice/session.jsonl' },
      { importedFrom: 'prefix/var/tmp/private.jsonl' },
      { importedFrom: 'event:Users/alice/session.jsonl' },
      { importedFrom: 'prefix%2FUsers%2Falice%2F.hermes%2Fstate.db' },
      { importedFrom: 'prefix%2FUsers%2Falice%2F.hermes%2Fstate.db%ZZ' },
      { importedFrom: 'prefix%252FUsers%252Falice%252F.hermes%252Fstate.db' },
      { importedFrom: 'prefix%252FUsers%252Falice%252F.hermes%252Fstate.db%ZZ' },
      { importedFrom: 'token%3Dfixture' },
      { importedFrom: 'token%3Dfixture%ZZ' },
      { importedFrom: 'token%253Dfixture' },
      { importedFrom: 'token%253Dfixture%ZZ' },
      { importedFrom: ['eyJ', 'fixture', 'sig'].join('.') }
    ]) {
      expect(validateSourceRef({
        ...ref,
        metadata
      }).map((v) => v.code)).toContain('sourceRef.metadata.privacy_sensitive');
    }

    const symbolKey = Symbol('rawPath');
    const symbolMetadata = {
      source: 'hermes-history',
      [symbolKey]: { raw: '/Users/person/.hermes/state.db' }
    } as never;
    const symbolMetadataViolations = validateSourceRef({
      ...ref,
      metadata: symbolMetadata
    });
    expect(symbolMetadataViolations.map((v) => v.code)).toContain('sourceRef.metadata.invalid_key');
    expect(symbolMetadataViolations.map((v) => v.code)).toContain('sourceRef.metadata.invalid_value');
    expect(() => createSourceRef({
      ...ref,
      metadata: symbolMetadata
    })).toThrow(/sourceRef\.metadata\.(invalid_key|invalid_value)/);

    const nonEnumerableMetadata = { source: 'hermes-history' } as Record<string, unknown>;
    Object.defineProperty(nonEnumerableMetadata, 'importedFrom', {
      enumerable: false,
      value: 'prefix%2FUsers%2Falice%2F.hermes%2Fstate.db%ZZ'
    });
    expect(validateSourceRef({
      ...ref,
      metadata: nonEnumerableMetadata as never
    }).map((v) => v.code)).toContain('sourceRef.metadata.privacy_sensitive');

    for (const evidenceHandle of [null, '']) {
      const evidenceViolations = validateSourceRef({
        ...ref,
        evidenceHandle
      } as never);
      expect(evidenceViolations.map((v) => v.code)).toContain('sourceRef.evidenceHandle.invalid');
      expect(() => createSourceRef({
        ...ref,
        evidenceHandle
      } as never)).toThrow(/sourceRef\.evidenceHandle\.invalid/);
    }
  });

  it('returns contract violations instead of throwing for malformed transformation entries', () => {
    expect(() => validateSourceAdapterContract(validAdapter({
      transformations: [null as never]
    }))).not.toThrow();

    expect(validateSourceAdapterContract(validAdapter({
      transformations: [null as never]
    })).map((v) => v.code)).toContain('transformation.required');
  });

  it('declares privacy class and capture mode from bounded enums', () => {
    expect(SOURCE_PRIVACY_CLASSES).toEqual(['public', 'internal', 'confidential', 'restricted']);
    expect(SOURCE_CAPTURE_MODES).toEqual(['snapshot', 'append-only-log', 'stream', 'metadata-only', 'history_import']);

    const violations = validateSourceAdapterContract(validAdapter({
      source: {
        id: 'bad-source',
        version: '1',
        privacyClass: 'private' as never,
        captureMode: 'mirror' as never
      }
    }));

    expect(violations.map((v) => v.code)).toEqual(expect.arrayContaining([
      'source.privacyClass.invalid',
      'source.captureMode.invalid'
    ]));
  });

  it('declares transformations as immutable, stable metadata', () => {
    const transformations = defineSourceTransformations([
      {
        id: 'strip-local-paths',
        version: '1.0.0',
        kind: 'privacy-filter',
        inputSchema: 'claude-jsonl@1',
        outputSchema: 'public-source-ref@1',
        deterministic: true
      }
    ]);

    expect(Object.isFrozen(transformations)).toBe(true);
    expect(Object.isFrozen(transformations[0])).toBe(true);
    expect(transformations[0].id).toBe('strip-local-paths');

    const violations = validateSourceAdapterContract(validAdapter({
      transformations: [
        {
          id: '/Users/person/transform.ts',
          version: '',
          kind: 'custom-script' as never,
          inputSchema: '',
          outputSchema: 'raw-event@1'
        }
      ]
    }));

    expect(violations.map((v) => v.code)).toEqual(expect.arrayContaining([
      'transformation.id.unstable',
      'transformation.version.required',
      'transformation.kind.invalid',
      'transformation.inputSchema.required'
    ]));

    const duplicateSensitiveIdViolations = validateSourceAdapterContract(validAdapter({
      transformations: [
        {
          id: '/Users/person/.hermes/state.db',
          version: '1.0.0',
          kind: 'normalize',
          inputSchema: 'raw-source@1',
          outputSchema: 'raw-event@1'
        },
        {
          id: '/Users/person/.hermes/state.db',
          version: '1.0.0',
          kind: 'normalize',
          inputSchema: 'raw-source@1',
          outputSchema: 'raw-event@1'
        }
      ]
    }));
    expect(duplicateSensitiveIdViolations.map((v) => v.code)).toContain('transformation.id.duplicate');
    const serializedDuplicateSensitiveIdViolations = JSON.stringify(duplicateSensitiveIdViolations);
    expect(serializedDuplicateSensitiveIdViolations).not.toContain('/Users/person');
    expect(serializedDuplicateSensitiveIdViolations).not.toContain('.hermes');
    expect(serializedDuplicateSensitiveIdViolations).not.toContain('state.db');
  });

  it('requires deterministic currentness declarations before adapters can pass conformance', () => {
    expect(validateSourceAdapterContract(validAdapter({
      capabilities: undefined as never
    })).map((v) => v.code)).toContain('capabilities.required');

    expect(validateSourceAdapterContract(validAdapter({
      capabilities: {
        supportsIncrementalImport: true
      } as never
    })).map((v) => v.code)).toContain('capabilities.currentnessStrategy.required');

    expect(validateSourceAdapterContract(validAdapter({
      capabilities: {
        currentnessStrategy: '/Users/person/.hermes/state.db'
      } as never
    })).map((v) => v.code)).toContain('capabilities.currentnessStrategy.unstable');

    const prototypeCapabilities = Object.create({ currentnessStrategy: 'session-id-and-message-cursor' });
    prototypeCapabilities.supportsIncrementalImport = true;
    expect(validateSourceAdapterContract(validAdapter({
      capabilities: prototypeCapabilities
    })).map((v) => v.code)).toContain('capabilities.currentnessStrategy.required');
  });

  it('rejects prototype-inherited required contract fields instead of accepting polluted declarations', () => {
    const inheritedAdapter = Object.create(validAdapter()) as SourceAdapterContract;
    expect(validateSourceAdapterContract(inheritedAdapter).map((v) => v.code)).toEqual(expect.arrayContaining([
      'identity.required',
      'source.required',
      'transformations.required',
      'capabilities.required'
    ]));

    const inheritedIdentity = Object.create({ id: 'codex-session-importer', version: '1.0.0' }) as SourceAdapterContract['identity'];
    expect(validateSourceAdapterContract(validAdapter({
      identity: inheritedIdentity
    })).map((v) => v.code)).toEqual(expect.arrayContaining([
      'identity.id.required',
      'identity.version.required'
    ]));

    const inheritedSource = Object.create({
      id: 'codex-session',
      version: '1',
      privacyClass: 'internal',
      captureMode: 'snapshot'
    }) as SourceAdapterContract['source'];
    expect(validateSourceAdapterContract(validAdapter({
      source: inheritedSource
    })).map((v) => v.code)).toEqual(expect.arrayContaining([
      'source.id.required',
      'source.version.required',
      'source.privacyClass.invalid',
      'source.captureMode.invalid'
    ]));

    const inheritedSourceRef = Object.create({
      kind: 'session',
      stableId: 'session:hash',
      publicHandle: 'session:hash',
      evidenceHandle: 'event:session:hash',
      privacyClass: 'internal',
      captureMode: 'snapshot'
    }) as NonNullable<SourceAdapterContract['sampleSourceRefs']>[number];
    expect(validateSourceRef(inheritedSourceRef).map((v) => v.code)).toEqual(expect.arrayContaining([
      'sourceRef.kind.required',
      'sourceRef.stableId.required',
      'sourceRef.publicHandle.required',
      'sourceRef.privacyClass.invalid',
      'sourceRef.captureMode.invalid'
    ]));

    const inheritedTransformation = Object.create({
      id: 'normalize-session',
      version: '1.0.0',
      kind: 'normalize',
      inputSchema: 'session@1',
      outputSchema: 'raw-event@1'
    }) as SourceAdapterContract['transformations'][number];
    expect(validateSourceAdapterContract(validAdapter({
      transformations: [inheritedTransformation]
    })).map((v) => v.code)).toEqual(expect.arrayContaining([
      'transformation.id.required',
      'transformation.version.required',
      'transformation.kind.invalid',
      'transformation.inputSchema.required',
      'transformation.outputSchema.required'
    ]));
  });

  it('rejects malformed optional public declaration text fields before freezing', () => {
    const baseAdapter = validAdapter();
    const violations = validateSourceAdapterContract({
      ...baseAdapter,
      identity: {
        ...baseAdapter.identity,
        displayName: { raw: '/Users/person/private/session.jsonl' }
      } as never,
      source: {
        ...baseAdapter.source,
        description: null,
        metadataSchema: { raw: 'token=fixture' }
      } as never,
      transformations: [
        {
          ...baseAdapter.transformations[0],
          description: { raw: '/Users/person/private/session.jsonl' }
        } as never
      ]
    });

    expect(violations.map((v) => v.code)).toEqual(expect.arrayContaining([
      'identity.displayName.invalid',
      'source.description.invalid',
      'source.metadataSchema.invalid',
      'transformation.description.invalid'
    ]));
    expect(JSON.stringify(violations)).not.toContain('/Users/person');
    expect(JSON.stringify(violations)).not.toContain('token=fixture');

    expect(() => defineSourceAdapter({
      ...baseAdapter,
      identity: {
        ...baseAdapter.identity,
        displayName: { raw: '/Users/person/private/session.jsonl' }
      } as never
    })).toThrow(/identity\.displayName\.invalid/);
    expect(() => defineSourceSchema({
      id: 'safe-source',
      version: '1',
      privacyClass: 'internal',
      captureMode: 'snapshot',
      description: { raw: '/Users/person/private/session.jsonl' }
    } as never)).toThrow(/source\.description\.invalid/);
    expect(() => defineSourceTransformations([
      {
        id: 'safe-transform',
        version: '1.0.0',
        kind: 'normalize',
        inputSchema: 'raw-source@1',
        outputSchema: 'raw-event@1',
        description: { raw: '/Users/person/private/session.jsonl' }
      } as never
    ])).toThrow(/transformation\.description\.invalid/);
  });

  it('rejects unknown fields and privacy-sensitive public declaration values before freezing', () => {
    const baseRef = {
      kind: 'session',
      stableId: 'source-session:hash-abc123',
      publicHandle: 'source-session:hash-abc123',
      evidenceHandle: 'event:hash-abc123:1',
      privacyClass: 'confidential',
      captureMode: 'history_import'
    } as const;
    const stripeLikeId = ['sk', 'live', 'adapter'].join('_');
    const jwtLikeVersion = ['eyJ', 'identity', 'sig'].join('.');
    const googleLikeSourceId = ['AI', 'za', 'source'].join('');
    const symbolKey = Symbol('rawPath');

    const sourceRefKindViolations = validateSourceRef({
      ...baseRef,
      kind: 'event/Users/alice/session.jsonl'
    } as never);
    expect(sourceRefKindViolations.map((v) => v.code)).toContain('sourceRef.kind.privacy_sensitive');
    expect(JSON.stringify(sourceRefKindViolations)).not.toContain('event/Users/alice');

    expect(validateSourceRef({
      ...baseRef,
      kind: stripeLikeId
    } as never).map((v) => v.code)).toContain('sourceRef.kind.privacy_sensitive');

    const sourceRefViolations = validateSourceRef({
      ...baseRef,
      rawPath: '/Users/person/private/session.jsonl'
    } as never);
    expect(sourceRefViolations.map((v) => v.code)).toContain('sourceRef.unknown_field');
    expect(JSON.stringify(sourceRefViolations)).not.toContain('/Users/person');
    expect(() => createSourceRef({
      ...baseRef,
      extra: 'safe-but-unknown'
    } as never)).toThrow(/sourceRef\.unknown_field/);
    expect(() => createSourceRef({
      ...baseRef,
      [symbolKey]: '/Users/person/private/session.jsonl'
    } as never)).toThrow(/sourceRef\.unknown_field/);

    expect(() => defineSourceSchema({
      id: 'safe-source',
      version: '1',
      privacyClass: 'internal',
      captureMode: 'snapshot',
      rawPath: 'safe-but-unknown'
    } as never)).toThrow(/source\.unknown_field/);
    expect(() => defineSourceSchema({
      id: 'safe-source',
      version: '1',
      privacyClass: 'internal',
      captureMode: 'snapshot',
      [symbolKey]: '/Users/person/private/session.jsonl'
    } as never)).toThrow(/source\.unknown_field/);
    const nonEnumerableSource = {
      id: 'safe-source',
      version: '1',
      privacyClass: 'internal',
      captureMode: 'snapshot'
    } as Record<string, unknown>;
    Object.defineProperty(nonEnumerableSource, 'rawPath', {
      enumerable: false,
      value: 'prefix%2FUsers%2Falice%2F.hermes%2Fstate.db%ZZ'
    });
    expect(() => defineSourceSchema(nonEnumerableSource as never)).toThrow(/source\.unknown_field/);

    expect(() => defineSourceTransformations([
      {
        id: 'safe-transform',
        version: '1.0.0',
        kind: 'normalize',
        inputSchema: 'raw-source@1',
        outputSchema: 'raw-event@1',
        rawPath: 'safe-but-unknown'
      } as never
    ])).toThrow(/transformation\.unknown_field/);
    expect(() => defineSourceTransformations([
      {
        id: 'safe-transform',
        version: '1.0.0',
        kind: 'normalize',
        inputSchema: 'raw-source@1',
        outputSchema: 'raw-event@1',
        [symbolKey]: '/Users/person/private/session.jsonl'
      } as never
    ])).toThrow(/transformation\.unknown_field/);

    const baseAdapter = validAdapter();
    const symbolRootAdapterViolations = validateSourceAdapterContract({
      ...baseAdapter,
      [symbolKey]: '/Users/person/private/session.jsonl'
    } as never);
    expect(symbolRootAdapterViolations.map((v) => v.code)).toContain('adapter.unknown_field');

    const symbolNestedAdapterViolations = validateSourceAdapterContract({
      ...baseAdapter,
      identity: {
        ...baseAdapter.identity,
        [symbolKey]: '/Users/person/private/session.jsonl'
      } as never,
      capabilities: {
        ...baseAdapter.capabilities,
        [symbolKey]: { raw: '/Users/person/private/session.jsonl' }
      } as never
    });
    expect(symbolNestedAdapterViolations.map((v) => v.code)).toContain('identity.unknown_field');
    expect(symbolNestedAdapterViolations.map((v) => v.code)).toContain('capabilities.invalid_key');
    expect(symbolNestedAdapterViolations.map((v) => v.code)).toContain('capabilities.invalid_value');

    const nonEnumerableCapabilities = {
      ...baseAdapter.capabilities
    } as Record<string, unknown>;
    Object.defineProperty(nonEnumerableCapabilities, 'importedFrom', {
      enumerable: false,
      value: 'prefix%2FUsers%2Falice%2F.hermes%2Fstate.db%ZZ'
    });
    expect(validateSourceAdapterContract(validAdapter({
      capabilities: nonEnumerableCapabilities as never
    })).map((v) => v.code)).toContain('capabilities.privacy_sensitive');

    const violations = validateSourceAdapterContract({
      ...baseAdapter,
      identity: {
        id: stripeLikeId,
        version: jwtLikeVersion,
        displayName: 'event/Users/alice/session.jsonl',
        rawPath: 'safe-but-unknown'
      } as never,
      source: {
        id: googleLikeSourceId,
        version: 'token=fixture',
        privacyClass: 'internal',
        captureMode: 'snapshot',
        description: 'event/Users/alice/session.jsonl',
        metadataSchema: 'sk-meta',
        rawPath: 'safe-but-unknown'
      } as never,
      transformations: [
        {
          id: stripeLikeId,
          version: jwtLikeVersion,
          kind: 'normalize',
          inputSchema: googleLikeSourceId,
          outputSchema: 'token=fixture',
          description: 'token=fixture',
          rawPath: 'safe-but-unknown'
        } as never
      ],
      sampleSourceRefs: [
        {
          ...baseRef,
          rawPath: 'safe-but-unknown'
        } as never
      ],
      capabilities: {
        currentnessStrategy: 'session-id-and-message-cursor',
        supportsIncrementalImport: true,
        importedFrom: 'event/Users/alice/session.jsonl',
        nested: { raw: 'safe' },
        '/Users/person/private': true
      } as never
    });

    expect(violations.map((v) => v.code)).toEqual(expect.arrayContaining([
      'identity.unknown_field',
      'identity.id.privacy_sensitive',
      'identity.version.privacy_sensitive',
      'identity.displayName.privacy_sensitive',
      'source.unknown_field',
      'source.id.privacy_sensitive',
      'source.version.privacy_sensitive',
      'source.description.privacy_sensitive',
      'source.metadataSchema.privacy_sensitive',
      'transformation.unknown_field',
      'transformation.id.privacy_sensitive',
      'transformation.version.privacy_sensitive',
      'transformation.inputSchema.privacy_sensitive',
      'transformation.outputSchema.privacy_sensitive',
      'transformation.description.privacy_sensitive',
      'sourceRef.unknown_field',
      'capabilities.privacy_sensitive',
      'capabilities.invalid_value'
    ]));
    const serializedViolations = JSON.stringify(violations);
    expect(serializedViolations).not.toContain('/Users/person');
    expect(serializedViolations).not.toContain('event/Users/alice');
  });

  it('conformance suite catches schema, identity, source-ref, and transformation declaration violations', () => {
    const violations = validateSourceAdapterContract({
      identity: { id: ' ', version: ' ' },
      source: {
        id: '',
        version: '',
        privacyClass: 'private' as never,
        captureMode: 'mirror' as never
      },
      transformations: [
        {
          id: '',
          version: '',
          kind: 'normalize',
          inputSchema: 'raw-source@1',
          outputSchema: ''
        },
        {
          id: '',
          version: '1',
          kind: 'normalize',
          inputSchema: 'raw-source@1',
          outputSchema: 'raw-event@1'
        }
      ],
      sampleSourceRefs: [
        {
          kind: 'file',
          stableId: '',
          publicHandle: '/Users/person/private/session.jsonl',
          evidenceHandle: '/var/tmp/private/session.jsonl',
          privacyClass: 'secret' as never,
          captureMode: 'mirror' as never
        }
      ]
    });

    expect(violations.map((v) => v.code)).toEqual(expect.arrayContaining([
      'identity.id.required',
      'identity.version.required',
      'source.id.required',
      'source.version.required',
      'source.privacyClass.invalid',
      'source.captureMode.invalid',
      'transformation.id.required',
      'transformation.version.required',
      'transformation.outputSchema.required',
      'sourceRef.stableId.required',
      'sourceRef.publicHandle.absolute_local_path',
      'sourceRef.evidenceHandle.absolute_local_path'
    ]));
  });

  it('freezes a valid adapter definition without adding importer side effects', () => {
    const adapter = defineSourceAdapter(validAdapter());

    expect(Object.isFrozen(adapter)).toBe(true);
    expect(adapter.identity.id).toBe('codex-session-importer');
    expect(adapter.transformations).toHaveLength(1);
  });
});
