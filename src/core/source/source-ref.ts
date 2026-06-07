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

export function createSourceRef(ref: SourceRef): SourceRef {
  const violations = validateSourceRef(ref);
  if (violations.length > 0) {
    throw new SourceContractValidationError(violations);
  }

  const evidenceHandle = getOwnField<string>(ref as unknown as Record<string, unknown>, 'evidenceHandle');
  const metadata = getOwnField<Record<string, SourceRefMetadataValue>>(ref as unknown as Record<string, unknown>, 'metadata');
  return Object.freeze({
    kind: ref.kind,
    stableId: ref.stableId,
    publicHandle: ref.publicHandle,
    ...(evidenceHandle !== undefined ? { evidenceHandle } : {}),
    privacyClass: ref.privacyClass,
    captureMode: ref.captureMode,
    ...(metadata ? { metadata: Object.freeze(Object.fromEntries(Object.entries(metadata))) } : {})
  });
}

export function validateSourceRef(ref: Partial<SourceRef> | undefined, path = 'sourceRef'): SourceContractViolation[] {
  const violations: SourceContractViolation[] = [];
  if (!ref || !isRecord(ref)) {
    return [violation('sourceRef.required', path, 'Source ref is required.')];
  }

  pushUnknownFieldViolation(ref, ['kind', 'stableId', 'publicHandle', 'evidenceHandle', 'privacyClass', 'captureMode', 'metadata'], 'sourceRef.unknown_field', path, violations);

  const kind = getOwnField<string>(ref, 'kind');
  const stableId = getOwnField<string>(ref, 'stableId');
  const publicHandle = getOwnField<string>(ref, 'publicHandle');
  const evidenceHandle = getOwnField<string>(ref, 'evidenceHandle');
  const privacyClass = getOwnField(ref, 'privacyClass');
  const captureMode = getOwnField(ref, 'captureMode');
  const metadata = getOwnField(ref, 'metadata');

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

  validateMetadata(metadata, `${path}.metadata`, violations);

  return violations;
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

function validateMetadata(metadata: unknown, path: string, violations: SourceContractViolation[]): void {
  if (metadata === undefined) return;
  if (!isRecord(metadata)) {
    violations.push(violation('sourceRef.metadata.invalid', path, 'Source ref metadata must be an object when present.'));
    return;
  }

  const symbolKeys = Object.getOwnPropertySymbols(metadata);
  symbolKeys.forEach((key, index) => {
    const value = (metadata as Record<symbol, unknown>)[key];
    const valuePath = `${path}.[symbol-${index}]`;
    violations.push(violation('sourceRef.metadata.invalid_key', valuePath, 'Source ref metadata keys must be strings.'));
    validateMetadataValue(value, valuePath, String(key.description ?? ''), violations);
  });

  Object.getOwnPropertyNames(metadata).forEach((key, index) => {
    const value = (metadata as Record<string, unknown>)[key];
    const valuePath = metadataEntryPath(path, key, index);
    if (looksLikePrivacySensitiveSourceValue(key)) {
      violations.push(violation('sourceRef.metadata.privacy_sensitive', valuePath, 'Source ref metadata keys must not leak local state handles or credential-shaped values.'));
    }

    validateMetadataValue(value, valuePath, key, violations);
  });
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

function metadataEntryPath(path: string, key: string, index: number): string {
  if (looksLikePrivacySensitiveSourceValue(key)) {
    return `${path}.[redacted-key-${index}]`;
  }
  const sanitizedKey = key.replace(/[^A-Za-z0-9._:-]+/g, '_').slice(0, 64);
  return sanitizedKey ? `${path}.${sanitizedKey}` : `${path}.${index}`;
}

function pushUnknownFieldViolation(
  record: Record<string, unknown>,
  allowedFields: readonly string[],
  code: string,
  path: string,
  violations: SourceContractViolation[]
): void {
  const allowed = new Set(allowedFields);
  if (Reflect.ownKeys(record).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    violations.push(violation(code, path, 'Source ref contains unsupported fields.'));
  }
}
