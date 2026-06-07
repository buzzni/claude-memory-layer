import {
  type SourceContractViolation,
  SourceContractValidationError,
  getOwnField,
  hasText,
  isArrayForSourceSnapshot,
  isRecord,
  isStableContractIdentifier,
  looksLikePrivacySensitiveSourceValue,
  safeGetOwnPropertyDescriptorForSourceSnapshot,
  safeReadOwnDataPropertyForSourceSnapshot,
  snapshotAllowedRecordFields,
  violation
} from './source-schema.js';

const MAX_SOURCE_TRANSFORMATION_DECLARATIONS = 1000;

export const SOURCE_TRANSFORMATION_KINDS = Object.freeze(['extract', 'normalize', 'privacy-filter', 'map', 'enrich'] as const);
export type SourceTransformationKind = (typeof SOURCE_TRANSFORMATION_KINDS)[number];

export interface SourceTransformationDeclaration {
  id: string;
  version: string;
  kind: SourceTransformationKind;
  inputSchema: string;
  outputSchema: string;
  deterministic?: boolean;
  description?: string;
}

interface PreparedSourceTransformationDeclaration {
  readonly record?: Record<string, unknown>;
  readonly violations: SourceContractViolation[];
}

export function isSourceTransformationKind(value: unknown): value is SourceTransformationKind {
  return typeof value === 'string' && (SOURCE_TRANSFORMATION_KINDS as readonly string[]).includes(value);
}

export function defineSourceTransformation(transformation: SourceTransformationDeclaration): SourceTransformationDeclaration {
  const prepared = prepareSourceTransformationDeclaration(transformation);
  if (prepared.violations.length > 0 || !prepared.record) {
    throw new SourceContractValidationError(prepared.violations);
  }
  return Object.freeze(freezeSourceTransformationDeclaration(prepared.record));
}

export function defineSourceTransformations(
  transformations: readonly SourceTransformationDeclaration[]
): readonly SourceTransformationDeclaration[] {
  const prepared = prepareSourceTransformationDeclarations(transformations, 'transformations');
  if (prepared.violations.length > 0) {
    throw new SourceContractValidationError(prepared.violations);
  }
  return Object.freeze(prepared.records.map((transformation) => Object.freeze(freezeSourceTransformationDeclaration(transformation))));
}

export function validateSourceTransformationDeclarations(
  transformations: readonly unknown[] | undefined,
  path = 'transformations'
): SourceContractViolation[] {
  return prepareSourceTransformationDeclarations(transformations, path).violations;
}

function prepareSourceTransformationDeclarations(
  transformations: readonly unknown[] | undefined,
  path: string
): { records: Record<string, unknown>[]; violations: SourceContractViolation[] } {
  const snapshot = snapshotSourceTransformationArray(transformations, path);
  const violations: SourceContractViolation[] = [...snapshot.violations];
  const records: Record<string, unknown>[] = [];
  for (let index = 0; index < snapshot.items.length; index += 1) {
    const prepared = prepareSourceTransformationDeclaration(snapshot.items[index], `${path}.${index}`);
    violations.push(...prepared.violations);
    if (prepared.record) records[index] = prepared.record;
  }

  const seenIds = new Set<string>();
  for (const transformation of records) {
    if (!isRecord(transformation)) continue;
    const id = getOwnField<string>(transformation, 'id');
    if (!hasText(id)) continue;
    if (seenIds.has(id)) {
      violations.push(violation('transformation.id.duplicate', path, 'Duplicate transformation id.'));
    }
    seenIds.add(id);
  }
  return { records, violations };
}

function snapshotSourceTransformationArray(
  transformations: readonly unknown[] | undefined,
  path: string
): { items: unknown[]; violations: SourceContractViolation[] } {
  if (!isArrayForSourceSnapshot(transformations)) {
    return {
      items: [],
      violations: [violation('transformations.required', path, 'At least one source transformation declaration is required.')]
    };
  }
  const lengthDescriptorSnapshot = safeGetOwnPropertyDescriptorForSourceSnapshot(
    transformations,
    'length',
    path,
    'transformations.length.invalid',
    'Source transformation declarations must expose a stable bounded array length.'
  );
  if (lengthDescriptorSnapshot.violations.length > 0) {
    return { items: [], violations: lengthDescriptorSnapshot.violations };
  }
  const lengthDescriptor = lengthDescriptorSnapshot.descriptor;
  if (!lengthDescriptor || !('value' in lengthDescriptor)) {
    return {
      items: [],
      violations: [violation('transformations.length.invalid', path, 'Source transformation declarations must expose a stable bounded array length.')]
    };
  }
  const lengthReadSnapshot = safeReadOwnDataPropertyForSourceSnapshot(
    transformations,
    'length',
    lengthDescriptor,
    path,
    'transformations.length.invalid',
    'Source transformation declarations must expose a stable bounded array length.'
  );
  if (lengthReadSnapshot.violations.length > 0) {
    return { items: [], violations: lengthReadSnapshot.violations };
  }
  const length = lengthReadSnapshot.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > MAX_SOURCE_TRANSFORMATION_DECLARATIONS) {
    return {
      items: [],
      violations: [violation('transformations.length.invalid', path, 'Source transformation declarations must expose a stable bounded array length.')]
    };
  }
  if (length === 0) {
    return {
      items: [],
      violations: [violation('transformations.required', path, 'At least one source transformation declaration is required.')]
    };
  }

  const items = new Array<unknown>(length);
  const violations: SourceContractViolation[] = [];
  for (let index = 0; index < length; index += 1) {
    const itemPath = `${path}.${index}`;
    const descriptorSnapshot = safeGetOwnPropertyDescriptorForSourceSnapshot(
      transformations,
      String(index),
      itemPath,
      'transformations.accessor_field',
      'Source transformation declaration array entries must be data properties.'
    );
    violations.push(...descriptorSnapshot.violations);
    const descriptor = descriptorSnapshot.descriptor;
    if (!descriptor) {
      violations.push(violation('transformations.missing_index', itemPath, 'Source transformation declarations must be a dense array.'));
      continue;
    }
    if (!('value' in descriptor)) {
      violations.push(violation('transformations.accessor_field', itemPath, 'Source transformation declaration array entries must be data properties.'));
      continue;
    }
    const readSnapshot = safeReadOwnDataPropertyForSourceSnapshot(
      transformations,
      String(index),
      descriptor,
      itemPath,
      'transformations.accessor_field',
      'Source transformation declaration array entries must be data properties.'
    );
    violations.push(...readSnapshot.violations);
    if (readSnapshot.violations.length > 0) continue;
    items[index] = readSnapshot.value;
  }
  return { items, violations };
}

export function validateSourceTransformationDeclaration(
  transformation: unknown,
  path = 'transformation'
): SourceContractViolation[] {
  return prepareSourceTransformationDeclaration(transformation, path).violations;
}

function prepareSourceTransformationDeclaration(
  transformation: unknown,
  path = 'transformation'
): PreparedSourceTransformationDeclaration {
  const snapshot = snapshotAllowedRecordFields(transformation, ['id', 'version', 'kind', 'inputSchema', 'outputSchema', 'deterministic', 'description'], {
    path,
    requiredCode: 'transformation.required',
    requiredMessage: 'Source transformation declaration is required.',
    unknownCode: 'transformation.unknown_field',
    unknownMessage: 'Source transformation declaration contains unsupported fields.',
    accessorCode: 'transformation.accessor_field',
    accessorMessage: 'Source transformation declaration fields must be data properties.'
  });
  if (!snapshot.record) return { violations: snapshot.violations };

  const violations: SourceContractViolation[] = [...snapshot.violations];
  const id = getOwnField(snapshot.record, 'id');
  const version = getOwnField(snapshot.record, 'version');
  const kind = getOwnField(snapshot.record, 'kind');
  const inputSchema = getOwnField(snapshot.record, 'inputSchema');
  const outputSchema = getOwnField(snapshot.record, 'outputSchema');
  const deterministic = getOwnField(snapshot.record, 'deterministic');
  const description = getOwnField(snapshot.record, 'description');

  if (!hasText(id)) {
    violations.push(violation('transformation.id.required', `${path}.id`, 'Source transformation id must be non-empty.'));
  } else {
    if (!isStableContractIdentifier(id)) {
      violations.push(violation('transformation.id.unstable', `${path}.id`, 'Source transformation id must be stable and must not include a local absolute path.'));
    }
    if (looksLikePrivacySensitiveSourceValue(id)) {
      violations.push(violation('transformation.id.privacy_sensitive', `${path}.id`, 'Source transformation id must not leak local state handles or credential-shaped values.'));
    }
  }

  if (!hasText(version)) {
    violations.push(violation('transformation.version.required', `${path}.version`, 'Source transformation version must be non-empty.'));
  } else if (looksLikePrivacySensitiveSourceValue(version)) {
    violations.push(violation('transformation.version.privacy_sensitive', `${path}.version`, 'Source transformation version must not leak local state handles or credential-shaped values.'));
  }

  if (!isSourceTransformationKind(kind)) {
    violations.push(violation('transformation.kind.invalid', `${path}.kind`, 'Source transformation kind must be one of the bounded source transformation kinds.'));
  }

  if (!hasText(inputSchema)) {
    violations.push(violation('transformation.inputSchema.required', `${path}.inputSchema`, 'Source transformation inputSchema must be non-empty.'));
  } else if (looksLikePrivacySensitiveSourceValue(inputSchema)) {
    violations.push(violation('transformation.inputSchema.privacy_sensitive', `${path}.inputSchema`, 'Source transformation inputSchema must not leak local state handles or credential-shaped values.'));
  }

  if (!hasText(outputSchema)) {
    violations.push(violation('transformation.outputSchema.required', `${path}.outputSchema`, 'Source transformation outputSchema must be non-empty.'));
  } else if (looksLikePrivacySensitiveSourceValue(outputSchema)) {
    violations.push(violation('transformation.outputSchema.privacy_sensitive', `${path}.outputSchema`, 'Source transformation outputSchema must not leak local state handles or credential-shaped values.'));
  }

  if (deterministic !== undefined && typeof deterministic !== 'boolean') {
    violations.push(violation('transformation.deterministic.invalid', `${path}.deterministic`, 'Source transformation deterministic must be a boolean when present.'));
  }

  if (description !== undefined && typeof description !== 'string') {
    violations.push(violation('transformation.description.invalid', `${path}.description`, 'Source transformation description must be a string when present.'));
  } else if (hasText(description) && looksLikePrivacySensitiveSourceValue(description)) {
    violations.push(violation('transformation.description.privacy_sensitive', `${path}.description`, 'Source transformation description must not leak local state handles or credential-shaped values.'));
  }

  return { record: snapshot.record, violations };
}

function freezeSourceTransformationDeclaration(
  transformation: Record<string, unknown>
): SourceTransformationDeclaration {
  const id = getOwnField<string>(transformation, 'id');
  const version = getOwnField<string>(transformation, 'version');
  const kind = getOwnField<SourceTransformationKind>(transformation, 'kind');
  const inputSchema = getOwnField<string>(transformation, 'inputSchema');
  const outputSchema = getOwnField<string>(transformation, 'outputSchema');
  const deterministic = getOwnField<boolean>(transformation, 'deterministic');
  const description = getOwnField<string>(transformation, 'description');
  const defined: SourceTransformationDeclaration = {
    id: id!,
    version: version!,
    kind: kind!,
    inputSchema: inputSchema!,
    outputSchema: outputSchema!
  };
  if (deterministic !== undefined) defined.deterministic = deterministic;
  if (description !== undefined) defined.description = description;
  return defined;
}
