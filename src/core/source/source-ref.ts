import {
  type SourceCaptureMode,
  type SourceContractViolation,
  SourceContractValidationError,
  type SourcePrivacyClass,
  getOwnField,
  hasText,
  isSourceCaptureMode,
  isSourcePrivacyClass,
  looksLikeLocalAbsolutePath,
  looksLikePrivacySensitiveSourceValue,
  safeGetOwnPropertyDescriptorForSourceSnapshot,
  safeOwnKeysForSourceSnapshot,
  safeReadOwnDataPropertyForSourceSnapshot,
  snapshotAllowedRecordFields,
  isRecord,
  violation
} from './source-schema.js';

export type SourceRefKind = 'file' | 'session' | 'api' | 'database' | 'message' | 'unknown';
export type SourceRefMetadataValue = string | number | boolean | null;

export interface SourceRef {
  kind: SourceRefKind | string;
  stableId: string;
  publicHandle: string;
  evidenceHandle?: string;
  privacyClass: SourcePrivacyClass;
  captureMode: SourceCaptureMode;
  metadata?: Readonly<Record<string, SourceRefMetadataValue>>;
}

interface PreparedSourceRef {
  readonly record?: Record<string, unknown>;
  readonly metadata?: Readonly<Record<string, SourceRefMetadataValue>>;
  readonly violations: SourceContractViolation[];
}

export function createSourceRef(ref: SourceRef): SourceRef {
  const prepared = prepareSourceRef(ref);
  if (prepared.violations.length > 0 || !prepared.record) {
    throw new SourceContractValidationError(prepared.violations);
  }

  const kind = getOwnField<SourceRef['kind']>(prepared.record, 'kind');
  const stableId = getOwnField<string>(prepared.record, 'stableId');
  const publicHandle = getOwnField<string>(prepared.record, 'publicHandle');
  const evidenceHandle = getOwnField<string>(prepared.record, 'evidenceHandle');
  const privacyClass = getOwnField<SourcePrivacyClass>(prepared.record, 'privacyClass');
  const captureMode = getOwnField<SourceCaptureMode>(prepared.record, 'captureMode');
  return Object.freeze({
    kind: kind!,
    stableId: stableId!,
    publicHandle: publicHandle!,
    ...(evidenceHandle !== undefined ? { evidenceHandle } : {}),
    privacyClass: privacyClass!,
    captureMode: captureMode!,
    ...(prepared.metadata !== undefined ? { metadata: prepared.metadata } : {})
  });
}

export function validateSourceRef(ref: Partial<SourceRef> | undefined, path = 'sourceRef'): SourceContractViolation[] {
  return prepareSourceRef(ref, path).violations;
}

function prepareSourceRef(ref: Partial<SourceRef> | undefined, path = 'sourceRef'): PreparedSourceRef {
  const snapshot = snapshotAllowedRecordFields(ref, ['kind', 'stableId', 'publicHandle', 'evidenceHandle', 'privacyClass', 'captureMode', 'metadata'], {
    path,
    requiredCode: 'sourceRef.required',
    requiredMessage: 'Source ref is required.',
    unknownCode: 'sourceRef.unknown_field',
    unknownMessage: 'Source ref contains unsupported fields.',
    accessorCode: 'sourceRef.accessor_field',
    accessorMessage: 'Source ref fields must be data properties.'
  });
  if (!snapshot.record) {
    return { violations: snapshot.violations };
  }

  const violations: SourceContractViolation[] = [...snapshot.violations];
  const kind = getOwnField<string>(snapshot.record, 'kind');
  const stableId = getOwnField<string>(snapshot.record, 'stableId');
  const publicHandle = getOwnField<string>(snapshot.record, 'publicHandle');
  const evidenceHandle = getOwnField<string>(snapshot.record, 'evidenceHandle');
  const privacyClass = getOwnField(snapshot.record, 'privacyClass');
  const captureMode = getOwnField(snapshot.record, 'captureMode');
  const metadata = getOwnField(snapshot.record, 'metadata');

  if (!hasText(kind)) {
    violations.push(violation('sourceRef.kind.required', `${path}.kind`, 'Source ref kind must be non-empty.'));
  } else if (looksLikePrivacySensitiveSourceValue(kind)) {
    violations.push(violation('sourceRef.kind.privacy_sensitive', `${path}.kind`, 'Source ref kind must not leak local state handles or credential-shaped values.'));
  }

  if (!hasText(stableId)) {
    violations.push(violation('sourceRef.stableId.required', `${path}.stableId`, 'Source ref stableId must be non-empty.'));
  } else {
    if (looksLikeLocalAbsolutePath(stableId)) {
      violations.push(violation('sourceRef.stableId.absolute_local_path', `${path}.stableId`, 'Source ref stableId must not be a local absolute path.'));
    }
    if (looksLikePrivacySensitiveSourceValue(stableId)) {
      violations.push(violation('sourceRef.stableId.privacy_sensitive', `${path}.stableId`, 'Source ref stableId must not leak local state handles or credential-shaped values.'));
    }
  }

  validatePublicHandle(publicHandle, `${path}.publicHandle`, violations);
  validateEvidenceHandle(evidenceHandle, `${path}.evidenceHandle`, violations);

  if (!isSourcePrivacyClass(privacyClass)) {
    violations.push(violation('sourceRef.privacyClass.invalid', `${path}.privacyClass`, 'Source ref privacyClass must be one of the bounded source privacy classes.'));
  }

  if (!isSourceCaptureMode(captureMode)) {
    violations.push(violation('sourceRef.captureMode.invalid', `${path}.captureMode`, 'Source ref captureMode must be one of the bounded source capture modes.'));
  }

  const metadataSnapshot = snapshotSourceRefMetadata(metadata, `${path}.metadata`);
  violations.push(...metadataSnapshot.violations);

  return {
    record: snapshot.record,
    metadata: metadataSnapshot.record,
    violations
  };
}

function validatePublicHandle(value: unknown, path: string, violations: SourceContractViolation[]): void {
  if (!hasText(value)) {
    violations.push(violation('sourceRef.publicHandle.required', path, 'Source ref publicHandle must be non-empty.'));
    return;
  }
  if (looksLikeLocalAbsolutePath(value)) {
    violations.push(violation('sourceRef.publicHandle.absolute_local_path', path, 'Source ref publicHandle must not leak a local absolute path.'));
  }
  if (looksLikePrivacySensitiveSourceValue(value)) {
    violations.push(violation('sourceRef.publicHandle.privacy_sensitive', path, 'Source ref publicHandle must not leak local state handles or credential-shaped values.'));
  }
}

function validateEvidenceHandle(value: unknown, path: string, violations: SourceContractViolation[]): void {
  if (value === undefined) return;
  if (!hasText(value)) {
    violations.push(violation('sourceRef.evidenceHandle.invalid', path, 'Source ref evidenceHandle must be a non-empty string when present.'));
    return;
  }
  if (looksLikeLocalAbsolutePath(value)) {
    violations.push(violation('sourceRef.evidenceHandle.absolute_local_path', path, 'Source ref evidenceHandle must not leak a local absolute path.'));
  }
  if (looksLikePrivacySensitiveSourceValue(value)) {
    violations.push(violation('sourceRef.evidenceHandle.privacy_sensitive', path, 'Source ref evidenceHandle must not leak local state handles or credential-shaped values.'));
  }
}

function snapshotSourceRefMetadata(
  metadata: unknown,
  path: string
): { record?: Readonly<Record<string, SourceRefMetadataValue>>; violations: SourceContractViolation[] } {
  if (metadata === undefined) return { violations: [] };
  if (!isRecord(metadata)) {
    return {
      violations: [violation('sourceRef.metadata.invalid', path, 'Source ref metadata must be an object when present.')]
    };
  }

  const snapshot: Record<string, SourceRefMetadataValue> = Object.create(null);
  const keySnapshot = safeOwnKeysForSourceSnapshot(metadata, path, 'sourceRef.metadata.accessor_field', 'Source ref metadata values must be data properties.');
  const violations: SourceContractViolation[] = [...keySnapshot.violations];

  keySnapshot.keys.forEach((key, index) => {
    if (typeof key !== 'string') {
      const valuePath = `${path}.[symbol-${index}]`;
      violations.push(violation('sourceRef.metadata.invalid_key', valuePath, 'Source ref metadata keys must be strings.'));
      const descriptorSnapshot = safeGetOwnPropertyDescriptorForSourceSnapshot(metadata, key, valuePath, 'sourceRef.metadata.accessor_field', 'Source ref metadata values must be data properties.');
      violations.push(...descriptorSnapshot.violations);
      const descriptor = descriptorSnapshot.descriptor;
      if (!descriptor || !('value' in descriptor)) {
        violations.push(violation('sourceRef.metadata.accessor_field', valuePath, 'Source ref metadata values must be data properties.'));
        return;
      }
      const readSnapshot = safeReadOwnDataPropertyForSourceSnapshot(metadata, key, descriptor, valuePath, 'sourceRef.metadata.accessor_field', 'Source ref metadata values must be data properties.');
      violations.push(...readSnapshot.violations);
      if (readSnapshot.violations.length > 0) return;
      validateMetadataValue(readSnapshot.value, valuePath, propertyKeyDescription(key), violations);
      return;
    }

    const valuePath = metadataEntryPath(path, key, index);
    if (looksLikePrivacySensitiveSourceValue(key)) {
      violations.push(violation('sourceRef.metadata.privacy_sensitive', valuePath, 'Source ref metadata keys must not leak local state handles or credential-shaped values.'));
    }
    const descriptorSnapshot = safeGetOwnPropertyDescriptorForSourceSnapshot(metadata, key, valuePath, 'sourceRef.metadata.accessor_field', 'Source ref metadata values must be data properties.');
    violations.push(...descriptorSnapshot.violations);
    const descriptor = descriptorSnapshot.descriptor;
    if (!descriptor || !('value' in descriptor)) {
      violations.push(violation('sourceRef.metadata.accessor_field', valuePath, 'Source ref metadata values must be data properties.'));
      return;
    }
    const readSnapshot = safeReadOwnDataPropertyForSourceSnapshot(metadata, key, descriptor, valuePath, 'sourceRef.metadata.accessor_field', 'Source ref metadata values must be data properties.');
    violations.push(...readSnapshot.violations);
    if (readSnapshot.violations.length > 0) return;
    validateMetadataValue(readSnapshot.value, valuePath, key, violations);
    if (isSourceRefMetadataValue(readSnapshot.value)) {
      snapshot[key] = readSnapshot.value;
    }
  });

  return { record: Object.freeze(snapshot), violations };
}

function isSourceRefMetadataValue(value: unknown): value is SourceRefMetadataValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function validateMetadataValue(value: unknown, valuePath: string, key: string, violations: SourceContractViolation[]): void {
  if (value === null) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      violations.push(violation('sourceRef.metadata.invalid_value', valuePath, 'Source ref metadata numbers must be finite.'));
    }
    if (looksLikePrivacySensitiveSourceValue(String(value), key)) {
      violations.push(violation('sourceRef.metadata.privacy_sensitive', valuePath, 'Source ref metadata must not leak local state handles or credential-shaped values.'));
    }
    return;
  }
  if (typeof value === 'boolean') {
    if (looksLikePrivacySensitiveSourceValue(String(value), key)) {
      violations.push(violation('sourceRef.metadata.privacy_sensitive', valuePath, 'Source ref metadata must not leak local state handles or credential-shaped values.'));
    }
    return;
  }
  if (typeof value === 'string') {
    if (looksLikePrivacySensitiveSourceValue(value, key)) {
      violations.push(violation('sourceRef.metadata.privacy_sensitive', valuePath, 'Source ref metadata must not leak local state handles or credential-shaped values.'));
    }
    return;
  }

  violations.push(violation('sourceRef.metadata.invalid_value', valuePath, 'Source ref metadata values must be scalar strings, finite numbers, booleans, or null.'));
}

function propertyKeyDescription(key: PropertyKey): string {
  return typeof key === 'symbol' ? String(key.description ?? '') : '';
}

function metadataEntryPath(path: string, key: string, index: number): string {
  if (looksLikePrivacySensitiveSourceValue(key)) {
    return `${path}.[redacted-key-${index}]`;
  }
  const sanitizedKey = key.replace(/[^A-Za-z0-9._:-]+/g, '_').slice(0, 64);
  return sanitizedKey ? `${path}.${sanitizedKey}` : `${path}.${index}`;
}
