import {
  type SourceContractViolation,
  SourceContractValidationError,
  getOwnField,
  hasText,
  isRecord,
  isStableContractIdentifier,
  looksLikePrivacySensitiveSourceValue,
  violation
} from './source-schema.js';

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

export function isSourceTransformationKind(value: unknown): value is SourceTransformationKind {
  return typeof value === 'string' && (SOURCE_TRANSFORMATION_KINDS as readonly string[]).includes(value);
}

export function defineSourceTransformation(transformation: SourceTransformationDeclaration): SourceTransformationDeclaration {
  const violations = validateSourceTransformationDeclaration(transformation);
  if (violations.length > 0) {
    throw new SourceContractValidationError(violations);
  }
  return Object.freeze(freezeSourceTransformationDeclaration(transformation));
}

export function defineSourceTransformations(
  transformations: readonly SourceTransformationDeclaration[]
): readonly SourceTransformationDeclaration[] {
  const violations = validateSourceTransformationDeclarations(transformations);
  if (violations.length > 0) {
    throw new SourceContractValidationError(violations);
  }
  return Object.freeze(transformations.map((transformation) => Object.freeze(freezeSourceTransformationDeclaration(transformation))));
}

export function validateSourceTransformationDeclarations(
  transformations: readonly unknown[] | undefined,
  path = 'transformations'
): SourceContractViolation[] {
  if (!Array.isArray(transformations) || transformations.length === 0) {
    return [violation('transformations.required', path, 'At least one source transformation declaration is required.')];
  }

  const violations = transformations.flatMap((transformation, index) => validateSourceTransformationDeclaration(transformation, `${path}.${index}`));
  const seenIds = new Set<string>();
  for (const transformation of transformations) {
    if (!isRecord(transformation)) continue;
    const id = getOwnField<string>(transformation, 'id');
    if (!hasText(id)) continue;
    if (seenIds.has(id)) {
      violations.push(violation('transformation.id.duplicate', path, 'Duplicate transformation id.'));
    }
    seenIds.add(id);
  }
  return violations;
}

export function validateSourceTransformationDeclaration(
  transformation: unknown,
  path = 'transformation'
): SourceContractViolation[] {
  const violations: SourceContractViolation[] = [];
  if (!isRecord(transformation)) {
    return [violation('transformation.required', path, 'Source transformation declaration is required.')];
  }
  pushUnknownFieldViolation(transformation, ['id', 'version', 'kind', 'inputSchema', 'outputSchema', 'deterministic', 'description'], 'transformation.unknown_field', path, violations);

  const id = getOwnField(transformation, 'id');
  const version = getOwnField(transformation, 'version');
  const kind = getOwnField(transformation, 'kind');
  const inputSchema = getOwnField(transformation, 'inputSchema');
  const outputSchema = getOwnField(transformation, 'outputSchema');
  const deterministic = getOwnField(transformation, 'deterministic');
  const description = getOwnField(transformation, 'description');

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

  return violations;
}

function freezeSourceTransformationDeclaration(
  transformation: SourceTransformationDeclaration
): SourceTransformationDeclaration {
  const deterministic = getOwnField<boolean>(transformation as unknown as Record<string, unknown>, 'deterministic');
  const description = getOwnField<string>(transformation as unknown as Record<string, unknown>, 'description');
  const defined: SourceTransformationDeclaration = {
    id: transformation.id,
    version: transformation.version,
    kind: transformation.kind,
    inputSchema: transformation.inputSchema,
    outputSchema: transformation.outputSchema
  };
  if (deterministic !== undefined) defined.deterministic = deterministic;
  if (description !== undefined) defined.description = description;
  return defined;
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
    violations.push(violation(code, path, 'Source transformation declaration contains unsupported fields.'));
  }
}
