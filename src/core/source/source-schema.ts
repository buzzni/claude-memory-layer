export const SOURCE_PRIVACY_CLASSES = Object.freeze(['public', 'internal', 'confidential', 'restricted'] as const);
export type SourcePrivacyClass = (typeof SOURCE_PRIVACY_CLASSES)[number];

export const SOURCE_CAPTURE_MODES = Object.freeze(['snapshot', 'append-only-log', 'stream', 'metadata-only', 'history_import'] as const);
export type SourceCaptureMode = (typeof SOURCE_CAPTURE_MODES)[number];

export interface SourceContractViolation {
  code: string;
  path: string;
  message: string;
}

export class SourceContractValidationError extends Error {
  readonly violations: readonly SourceContractViolation[];

  constructor(violations: readonly SourceContractViolation[]) {
    super(`Source contract validation failed: ${violations.map((violation) => violation.code).join(', ')}`);
    this.name = 'SourceContractValidationError';
    this.violations = violations;
  }
}

export interface SourceSchemaDeclaration {
  id: string;
  version: string;
  privacyClass: SourcePrivacyClass;
  captureMode: SourceCaptureMode;
  description?: string;
  metadataSchema?: string;
}

export interface SourceRecordSnapshot {
  readonly record?: Record<string, unknown>;
  readonly violations: SourceContractViolation[];
}

export interface SourceRecordSnapshotOptions {
  readonly path: string;
  readonly requiredCode: string;
  readonly requiredMessage: string;
  readonly unknownCode: string;
  readonly unknownMessage: string;
  readonly accessorCode: string;
  readonly accessorMessage: string;
}

export function isSourcePrivacyClass(value: unknown): value is SourcePrivacyClass {
  return isOneOf(SOURCE_PRIVACY_CLASSES, value);
}

export function isSourceCaptureMode(value: unknown): value is SourceCaptureMode {
  return isOneOf(SOURCE_CAPTURE_MODES, value);
}

export function defineSourceSchema(schema: SourceSchemaDeclaration): SourceSchemaDeclaration {
  const prepared = prepareSourceSchema(schema);
  if (prepared.violations.length > 0 || !prepared.record) {
    throw new SourceContractValidationError(prepared.violations);
  }

  return Object.freeze(freezeSourceSchemaDeclaration(prepared.record));
}

export function validateSourceSchema(schema: Partial<SourceSchemaDeclaration> | undefined, path = 'source'): SourceContractViolation[] {
  return prepareSourceSchema(schema, path).violations;
}

export function prepareSourceSchema(schema: Partial<SourceSchemaDeclaration> | undefined, path = 'source'): SourceRecordSnapshot {
  const snapshot = snapshotAllowedRecordFields(schema, ['id', 'version', 'privacyClass', 'captureMode', 'description', 'metadataSchema'], {
    path,
    requiredCode: 'source.required',
    requiredMessage: 'Source schema declaration is required.',
    unknownCode: 'source.unknown_field',
    unknownMessage: 'Source schema declaration contains unsupported fields.',
    accessorCode: 'source.accessor_field',
    accessorMessage: 'Source schema declaration fields must be data properties.'
  });
  if (!snapshot.record) return snapshot;

  return {
    record: snapshot.record,
    violations: validateSourceSchemaRecord(snapshot.record, path, snapshot.violations)
  };
}

function validateSourceSchemaRecord(
  schema: Record<string, unknown>,
  path: string,
  initialViolations: readonly SourceContractViolation[]
): SourceContractViolation[] {
  const violations: SourceContractViolation[] = [...initialViolations];
  const id = getOwnField<string>(schema, 'id');
  const version = getOwnField<string>(schema, 'version');
  const privacyClass = getOwnField(schema, 'privacyClass');
  const captureMode = getOwnField(schema, 'captureMode');
  const description = getOwnField<string>(schema, 'description');
  const metadataSchema = getOwnField<string>(schema, 'metadataSchema');

  if (!hasText(id)) {
    violations.push(violation('source.id.required', `${path}.id`, 'Source schema id must be non-empty.'));
  } else {
    if (!isStableContractIdentifier(id)) {
      violations.push(violation('source.id.unstable', `${path}.id`, 'Source schema id must be stable and must not include a local absolute path.'));
    }
    if (looksLikePrivacySensitiveSourceValue(id)) {
      violations.push(violation('source.id.privacy_sensitive', `${path}.id`, 'Source schema id must not leak local state handles or credential-shaped values.'));
    }
  }

  if (!hasText(version)) {
    violations.push(violation('source.version.required', `${path}.version`, 'Source schema version must be non-empty.'));
  } else if (looksLikePrivacySensitiveSourceValue(version)) {
    violations.push(violation('source.version.privacy_sensitive', `${path}.version`, 'Source schema version must not leak local state handles or credential-shaped values.'));
  }

  if (!isSourcePrivacyClass(privacyClass)) {
    violations.push(violation('source.privacyClass.invalid', `${path}.privacyClass`, 'Source schema privacyClass must be one of the bounded source privacy classes.'));
  }

  if (!isSourceCaptureMode(captureMode)) {
    violations.push(violation('source.captureMode.invalid', `${path}.captureMode`, 'Source schema captureMode must be one of the bounded source capture modes.'));
  }

  if (description !== undefined && typeof description !== 'string') {
    violations.push(violation('source.description.invalid', `${path}.description`, 'Source schema description must be a string when present.'));
  } else if (hasText(description) && looksLikePrivacySensitiveSourceValue(description)) {
    violations.push(violation('source.description.privacy_sensitive', `${path}.description`, 'Source schema description must not leak local state handles or credential-shaped values.'));
  }

  if (metadataSchema !== undefined && typeof metadataSchema !== 'string') {
    violations.push(violation('source.metadataSchema.invalid', `${path}.metadataSchema`, 'Source schema metadataSchema must be a string when present.'));
  } else if (hasText(metadataSchema) && looksLikePrivacySensitiveSourceValue(metadataSchema)) {
    violations.push(violation('source.metadataSchema.privacy_sensitive', `${path}.metadataSchema`, 'Source schema metadataSchema must not leak local state handles or credential-shaped values.'));
  }

  return violations;
}

function freezeSourceSchemaDeclaration(schema: Record<string, unknown>): SourceSchemaDeclaration {
  const id = getOwnField<string>(schema, 'id');
  const version = getOwnField<string>(schema, 'version');
  const privacyClass = getOwnField<SourcePrivacyClass>(schema, 'privacyClass');
  const captureMode = getOwnField<SourceCaptureMode>(schema, 'captureMode');
  const ownDescription = getOwnField<string>(schema, 'description');
  const ownMetadataSchema = getOwnField<string>(schema, 'metadataSchema');
  const defined: SourceSchemaDeclaration = {
    id: id!,
    version: version!,
    privacyClass: privacyClass!,
    captureMode: captureMode!
  };
  if (ownDescription !== undefined) defined.description = ownDescription;
  if (ownMetadataSchema !== undefined) defined.metadataSchema = ownMetadataSchema;
  return defined;
}

export function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isArrayForSourceSnapshot(value: unknown): value is readonly unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isArrayForSourceSnapshot(value);
}

export function hasOwnField(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function getOwnField<T = unknown>(record: Record<string, unknown>, key: string): T | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && 'value' in descriptor ? (descriptor.value as T) : undefined;
  } catch {
    return undefined;
  }
}

export function safeOwnKeysForSourceSnapshot(
  value: object,
  path: string,
  code: string,
  message: string
): { keys: PropertyKey[]; violations: SourceContractViolation[] } {
  try {
    return { keys: Reflect.ownKeys(value), violations: [] };
  } catch {
    return { keys: [], violations: [violation(code, path, message)] };
  }
}

export function safeGetOwnPropertyDescriptorForSourceSnapshot(
  value: object,
  key: PropertyKey,
  path: string,
  code: string,
  message: string
): { descriptor?: PropertyDescriptor; violations: SourceContractViolation[] } {
  try {
    return { descriptor: Object.getOwnPropertyDescriptor(value, key), violations: [] };
  } catch {
    return { violations: [violation(code, path, message)] };
  }
}

export function safeReadOwnDataPropertyForSourceSnapshot(
  value: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor,
  path: string,
  code: string,
  message: string
): { value?: unknown; violations: SourceContractViolation[] } {
  if (!('value' in descriptor)) {
    return { violations: [violation(code, path, message)] };
  }
  try {
    const readValue = Reflect.get(value, key, value);
    if (!Object.is(readValue, descriptor.value)) {
      return { violations: [violation(code, path, message)] };
    }
    return { value: descriptor.value, violations: [] };
  } catch {
    return { violations: [violation(code, path, message)] };
  }
}

export function snapshotAllowedRecordFields(
  value: unknown,
  allowedFields: readonly string[],
  options: SourceRecordSnapshotOptions
): SourceRecordSnapshot {
  if (!isRecord(value)) {
    return {
      record: undefined,
      violations: [violation(options.requiredCode, options.path, options.requiredMessage)]
    };
  }

  const allowed = new Set(allowedFields);
  const record: Record<string, unknown> = Object.create(null);
  const keySnapshot = safeOwnKeysForSourceSnapshot(value, options.path, options.accessorCode, options.accessorMessage);
  const violations: SourceContractViolation[] = [...keySnapshot.violations];
  for (const key of keySnapshot.keys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      violations.push(violation(options.unknownCode, options.path, options.unknownMessage));
      continue;
    }
    const descriptorSnapshot = safeGetOwnPropertyDescriptorForSourceSnapshot(value, key, `${options.path}.${key}`, options.accessorCode, options.accessorMessage);
    violations.push(...descriptorSnapshot.violations);
    const descriptor = descriptorSnapshot.descriptor;
    if (!descriptor || !('value' in descriptor)) {
      violations.push(violation(options.accessorCode, `${options.path}.${key}`, options.accessorMessage));
      continue;
    }
    const readSnapshot = safeReadOwnDataPropertyForSourceSnapshot(value, key, descriptor, `${options.path}.${key}`, options.accessorCode, options.accessorMessage);
    violations.push(...readSnapshot.violations);
    if (readSnapshot.violations.length > 0) continue;
    record[key] = readSnapshot.value;
  }

  return { record, violations };
}

export function isStableContractIdentifier(value: string): boolean {
  if (!hasText(value)) return false;
  if (looksLikeLocalAbsolutePath(value)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value);
}

export function looksLikeLocalAbsolutePath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;

  return sourceValueVariants(trimmed).some((candidate) => {
    const normalized = candidate.replace(/\\/g, '/');
    return /^file:\/*/i.test(normalized)
      || /[A-Za-z]:\//.test(normalized)
      || normalized.startsWith('/')
      || /(?:^|[^A-Za-z0-9])file:\/*/i.test(normalized)
      || /(?:^|[^A-Za-z0-9])\/(?!\/)/.test(normalized)
      || /(?:^|[^A-Za-z0-9])(?:Users|home|root|tmp|var|data)(?:\/|$)/.test(normalized)
      || /(?:^|\/(?:\/*))(?:Users|home|root|tmp|var|data)(?:\/|$)/.test(normalized)
      || /(?:^|[^A-Za-z0-9])\\\\/.test(candidate);
  });
}

export function looksLikePrivacySensitiveSourceValue(value: unknown, fieldName = ''): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;

  return sourceValueVariants(trimmed).some((candidate) => {
    const normalized = candidate.replace(/\\/g, '/');
    return looksLikeLocalAbsolutePath(candidate)
      || /(?:^|[\s:=,;|()[\]{}<>"'`])~(?:\/|$)/.test(normalized)
      || /(?:^|\/)\.hermes(?:\/|$)/i.test(normalized)
      || /(?:^|[^A-Za-z0-9])state\.db(?:$|[^A-Za-z0-9])/i.test(normalized)
      || looksLikeCredentialAssignment(candidate)
      || looksLikeBareCredentialToken(candidate)
      || looksLikeCredentialFieldValue(fieldName, candidate)
      || /\bBearer\s+(?!\[?redacted\]?\b)[A-Za-z0-9._~+/=-]{3,}/i.test(candidate)
      || /(?:^|[\s:=,;|()[\]{}<>"'`])[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i.test(candidate)
      || /(?:^|[\s:=,;|()[\]{}<>"'`])[a-z][a-z0-9+.-]*:\/\/:[^\s/@]+@/i.test(candidate);
  });
}

export function violation(code: string, path: string, message: string): SourceContractViolation {
  return { code, path, message };
}

function looksLikeCredentialAssignment(value: string): boolean {
  return /(?:^|[^A-Za-z0-9_-])(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|authorization|token)\s*[:=]\s*(?!\[?redacted\]?\b)(?:Bearer\s+)?[^\s&;,|]{3,}/i.test(value);
}

function looksLikeBareCredentialToken(value: string): boolean {
  if (/^\[?redacted\]?$/i.test(value.trim())) return false;
  const tokenBoundary = '(?:^|[^A-Za-z0-9_-])';
  const tokenEnd = '(?:$|[^A-Za-z0-9_-])';
  return [
    new RegExp(`${tokenBoundary}sk[-_][A-Za-z0-9][A-Za-z0-9_-]{2,}${tokenEnd}`),
    new RegExp(`${tokenBoundary}gh[a-z]_[A-Za-z0-9_]{3,}${tokenEnd}`),
    new RegExp(`${tokenBoundary}github_pat_[A-Za-z0-9_]{3,}${tokenEnd}`),
    new RegExp(`${tokenBoundary}xox[abprs]-[A-Za-z0-9-]{3,}${tokenEnd}`),
    new RegExp(`${tokenBoundary}hf_[A-Za-z0-9]{3,}${tokenEnd}`),
    new RegExp(`${tokenBoundary}glpat-[A-Za-z0-9_-]{3,}${tokenEnd}`),
    new RegExp(`${tokenBoundary}(?:AKIA|ASIA)[A-Z0-9]{8,}${tokenEnd}`),
    new RegExp(`${tokenBoundary}AIza[A-Za-z0-9_-]{3,}${tokenEnd}`),
    new RegExp(`${tokenBoundary}eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}${tokenEnd}`)
  ].some((pattern) => pattern.test(value));
}

function sourceValueVariants(value: string): string[] {
  const variants = new Set([value]);
  let current = value;
  for (let attempt = 0; attempt < 5 && current.includes('%'); attempt += 1) {
    const decoded = decodePercentEncodedBestEffort(current);
    if (decoded === current) break;
    variants.add(decoded);
    current = decoded;
  }
  return [...variants];
}

function decodePercentEncodedBestEffort(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%[0-9A-Fa-f]{2}/g, (match) => String.fromCharCode(Number.parseInt(match.slice(1), 16)));
  }
}

function looksLikeCredentialFieldValue(fieldName: string, value: string): boolean {
  return /^(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|authorization|token)$/i.test(fieldName.trim())
    && !/^\[?redacted\]?$/i.test(value.trim());
}

function isOneOf<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}
