import {
  SourceContractValidationError,
  type SourceContractViolation,
  defineSourceSchema,
  getOwnField,
  isRecord,
  violation
} from './source-schema.js';
import { createSourceRef, validateSourceRef } from './source-ref.js';
import { type SourceAdapterCapabilities, type SourceAdapterContract, type SourceAdapterIdentity, validateSourceAdapterCapabilities, validateSourceAdapterIdentity } from './source-adapter.js';
import { defineSourceTransformations, validateSourceTransformationDeclarations } from './source-transformations.js';

export function validateSourceAdapterContract(
  adapter: Partial<SourceAdapterContract> | undefined,
  path = 'adapter'
): SourceContractViolation[] {
  const violations: SourceContractViolation[] = [];
  if (!isRecord(adapter)) {
    return [violation('adapter.required', path, 'Source adapter contract is required.')];
  }

  pushUnknownFieldViolation(adapter, ['identity', 'source', 'transformations', 'sampleSourceRefs', 'capabilities'], 'adapter.unknown_field', path, violations);

  const identity = getOwnField<Partial<SourceAdapterContract['identity']>>(adapter, 'identity');
  const source = getOwnField<Partial<SourceAdapterContract['source']>>(adapter, 'source');
  const transformations = getOwnField<readonly unknown[]>(adapter, 'transformations');
  const capabilities = getOwnField<Partial<SourceAdapterContract['capabilities']>>(adapter, 'capabilities');
  const sampleSourceRefs = getOwnField<readonly unknown[]>(adapter, 'sampleSourceRefs');

  violations.push(...validateSourceAdapterIdentity(identity, `${path}.identity`));
  violations.push(...validateSourceSchemaLike(source, `${path}.source`));
  violations.push(...validateSourceTransformationDeclarations(transformations, `${path}.transformations`));
  violations.push(...validateSourceAdapterCapabilities(capabilities, `${path}.capabilities`));

  if (sampleSourceRefs !== undefined) {
    if (!Array.isArray(sampleSourceRefs)) {
      violations.push(violation('sampleSourceRefs.invalid', `${path}.sampleSourceRefs`, 'sampleSourceRefs must be an array when present.'));
    } else {
      sampleSourceRefs.forEach((sourceRef, index) => {
        violations.push(...validateSourceRef(sourceRef, `${path}.sampleSourceRefs.${index}`));
      });
    }
  }

  return violations;
}

export function assertSourceAdapterContract(adapter: Partial<SourceAdapterContract> | undefined): asserts adapter is SourceAdapterContract {
  const violations = validateSourceAdapterContract(adapter);
  if (violations.length > 0) {
    throw new SourceContractValidationError(violations);
  }
}

export function defineSourceAdapter(adapter: SourceAdapterContract): SourceAdapterContract {
  assertSourceAdapterContract(adapter);

  const sampleSourceRefsInput = getOwnField<SourceAdapterContract['sampleSourceRefs']>(adapter as unknown as Record<string, unknown>, 'sampleSourceRefs');
  const sampleSourceRefs = sampleSourceRefsInput
    ? Object.freeze(sampleSourceRefsInput.map((sourceRef) => createSourceRef(sourceRef)))
    : undefined;

  const identity = freezeSourceAdapterIdentity(adapter.identity);
  const capabilities = freezeSourceAdapterCapabilities(adapter.capabilities);

  return Object.freeze({
    identity,
    source: defineSourceSchema(adapter.source),
    transformations: defineSourceTransformations(adapter.transformations),
    sampleSourceRefs,
    capabilities
  });
}

function validateSourceSchemaLike(
  schema: Partial<SourceAdapterContract['source']> | undefined,
  path: string
): SourceContractViolation[] {
  return defineSafeValidation(() => defineSourceSchema(schema as SourceAdapterContract['source']), path);
}

function defineSafeValidation(validate: () => unknown, path: string): SourceContractViolation[] {
  try {
    validate();
    return [];
  } catch (error) {
    if (error instanceof SourceContractValidationError) {
      return error.violations.map((violationItem) => ({
        ...violationItem,
        path: violationItem.path === 'source' ? path : violationItem.path.replace(/^source\b/, path)
      }));
    }
    return [violation('source.validation_error', path, 'Source schema validation failed unexpectedly.')];
  }
}

function freezeSourceAdapterIdentity(identity: SourceAdapterIdentity): Readonly<SourceAdapterIdentity> {
  const displayName = getOwnField<string>(identity as unknown as Record<string, unknown>, 'displayName');
  const defined: SourceAdapterIdentity = {
    id: identity.id,
    version: identity.version
  };
  if (displayName !== undefined) defined.displayName = displayName;
  return Object.freeze(defined);
}

function freezeSourceAdapterCapabilities(capabilities: SourceAdapterCapabilities): SourceAdapterCapabilities {
  return Object.freeze(Object.fromEntries(Object.entries(capabilities))) as SourceAdapterCapabilities;
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
    violations.push(violation(code, path, 'Source adapter contract contains unsupported fields.'));
  }
}
