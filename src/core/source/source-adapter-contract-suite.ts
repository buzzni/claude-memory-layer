import {
  SourceContractValidationError,
  type SourceContractViolation,
  defineSourceSchema,
  getOwnField,
  isArrayForSourceSnapshot,
  safeGetOwnPropertyDescriptorForSourceSnapshot,
  safeReadOwnDataPropertyForSourceSnapshot,
  snapshotAllowedRecordFields,
  violation
} from './source-schema.js';
import { createSourceRef } from './source-ref.js';
import {
  type SourceAdapterCapabilities,
  type SourceAdapterContract,
  type SourceAdapterIdentity,
  freezeSourceAdapterCapabilities,
  freezeSourceAdapterIdentity,
  prepareSourceAdapterCapabilities,
  prepareSourceAdapterIdentity
} from './source-adapter.js';
import { defineSourceTransformations } from './source-transformations.js';

const MAX_SAMPLE_SOURCE_REFS = 1000;

interface PreparedSourceAdapterContract {
  readonly contract?: SourceAdapterContract;
  readonly violations: SourceContractViolation[];
}

export function validateSourceAdapterContract(
  adapter: Partial<SourceAdapterContract> | undefined,
  path = 'adapter'
): SourceContractViolation[] {
  return prepareSourceAdapterContract(adapter, path).violations;
}

export function assertSourceAdapterContract(adapter: Partial<SourceAdapterContract> | undefined): SourceAdapterContract {
  return defineSourceAdapter(adapter as SourceAdapterContract);
}

export function defineSourceAdapter(adapter: SourceAdapterContract): SourceAdapterContract {
  const prepared = prepareSourceAdapterContract(adapter);
  if (prepared.violations.length > 0 || !prepared.contract) {
    throw new SourceContractValidationError(prepared.violations);
  }
  return Object.freeze(prepared.contract);
}

function prepareSourceAdapterContract(
  adapter: Partial<SourceAdapterContract> | undefined,
  path = 'adapter'
): PreparedSourceAdapterContract {
  const snapshot = snapshotAllowedRecordFields(adapter, ['identity', 'source', 'transformations', 'sampleSourceRefs', 'capabilities'], {
    path,
    requiredCode: 'adapter.required',
    requiredMessage: 'Source adapter contract is required.',
    unknownCode: 'adapter.unknown_field',
    unknownMessage: 'Source adapter contract contains unsupported fields.',
    accessorCode: 'adapter.accessor_field',
    accessorMessage: 'Source adapter contract fields must be data properties.'
  });
  if (!snapshot.record) return { violations: snapshot.violations };

  const violations: SourceContractViolation[] = [...snapshot.violations];
  const identityInput = getOwnField<Partial<SourceAdapterIdentity>>(snapshot.record, 'identity');
  const sourceInput = getOwnField<SourceAdapterContract['source']>(snapshot.record, 'source');
  const transformationsInput = getOwnField<SourceAdapterContract['transformations']>(snapshot.record, 'transformations');
  const capabilitiesInput = getOwnField<Partial<SourceAdapterCapabilities>>(snapshot.record, 'capabilities');
  const sampleSourceRefsInput = getOwnField<SourceAdapterContract['sampleSourceRefs']>(snapshot.record, 'sampleSourceRefs');

  const identityPrepared = prepareSourceAdapterIdentity(identityInput, `${path}.identity`);
  violations.push(...identityPrepared.violations);

  const sourcePrepared = defineSafeResult(
    () => defineSourceSchema(sourceInput!),
    'source',
    `${path}.source`,
    'source.validation_error',
    'Source schema validation failed unexpectedly.'
  );
  violations.push(...sourcePrepared.violations);

  const transformationsPrepared = defineSafeResult(
    () => defineSourceTransformations(transformationsInput!),
    'transformations',
    `${path}.transformations`,
    'transformations.validation_error',
    'Source transformation validation failed unexpectedly.'
  );
  violations.push(...transformationsPrepared.violations);

  const capabilitiesPrepared = prepareSourceAdapterCapabilities(capabilitiesInput, `${path}.capabilities`);
  violations.push(...capabilitiesPrepared.violations);

  const sampleSourceRefsPrepared = defineSampleSourceRefs(sampleSourceRefsInput, `${path}.sampleSourceRefs`);
  violations.push(...sampleSourceRefsPrepared.violations);

  if (violations.length > 0 || !identityPrepared.record || !sourcePrepared.value || !transformationsPrepared.value || !capabilitiesPrepared.record) {
    return { violations };
  }

  const contract: SourceAdapterContract = {
    identity: freezeSourceAdapterIdentity(identityPrepared.record),
    source: sourcePrepared.value,
    transformations: transformationsPrepared.value,
    sampleSourceRefs: sampleSourceRefsPrepared.value,
    capabilities: freezeSourceAdapterCapabilities(capabilitiesPrepared.record)
  };
  return { contract, violations };
}

function defineSampleSourceRefs(
  sampleSourceRefs: readonly unknown[] | undefined,
  path: string
): { value?: readonly ReturnType<typeof createSourceRef>[]; violations: SourceContractViolation[] } {
  if (sampleSourceRefs === undefined) return { violations: [] };
  if (!isArrayForSourceSnapshot(sampleSourceRefs)) {
    return {
      violations: [violation('sampleSourceRefs.invalid', path, 'sampleSourceRefs must be an array when present.')]
    };
  }

  const snapshot = snapshotSampleSourceRefArray(sampleSourceRefs, path);
  const violations: SourceContractViolation[] = [...snapshot.violations];
  const refs: ReturnType<typeof createSourceRef>[] = [];
  for (let index = 0; index < snapshot.items.length; index += 1) {
    const defined = defineSafeResult(
      () => createSourceRef(snapshot.items[index] as never),
      'sourceRef',
      `${path}.${index}`,
      'sampleSourceRefs.validation_error',
      'Sample source ref validation failed unexpectedly.'
    );
    violations.push(...defined.violations);
    if (defined.value) refs[index] = defined.value;
  }
  return {
    value: violations.length === 0 ? Object.freeze(refs) : undefined,
    violations
  };
}

function snapshotSampleSourceRefArray(
  sampleSourceRefs: readonly unknown[],
  path: string
): { items: unknown[]; violations: SourceContractViolation[] } {
  const lengthDescriptorSnapshot = safeGetOwnPropertyDescriptorForSourceSnapshot(
    sampleSourceRefs,
    'length',
    path,
    'sampleSourceRefs.length.invalid',
    'sampleSourceRefs must expose a stable bounded array length.'
  );
  if (lengthDescriptorSnapshot.violations.length > 0) {
    return { items: [], violations: lengthDescriptorSnapshot.violations };
  }
  const lengthDescriptor = lengthDescriptorSnapshot.descriptor;
  if (!lengthDescriptor || !('value' in lengthDescriptor)) {
    return {
      items: [],
      violations: [violation('sampleSourceRefs.length.invalid', path, 'sampleSourceRefs must expose a stable bounded array length.')]
    };
  }
  const lengthReadSnapshot = safeReadOwnDataPropertyForSourceSnapshot(
    sampleSourceRefs,
    'length',
    lengthDescriptor,
    path,
    'sampleSourceRefs.length.invalid',
    'sampleSourceRefs must expose a stable bounded array length.'
  );
  if (lengthReadSnapshot.violations.length > 0) {
    return { items: [], violations: lengthReadSnapshot.violations };
  }
  const length = lengthReadSnapshot.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > MAX_SAMPLE_SOURCE_REFS) {
    return {
      items: [],
      violations: [violation('sampleSourceRefs.length.invalid', path, 'sampleSourceRefs must expose a stable bounded array length.')]
    };
  }

  const items = new Array<unknown>(length);
  const violations: SourceContractViolation[] = [];
  for (let index = 0; index < length; index += 1) {
    const itemPath = `${path}.${index}`;
    const descriptorSnapshot = safeGetOwnPropertyDescriptorForSourceSnapshot(
      sampleSourceRefs,
      String(index),
      itemPath,
      'sampleSourceRefs.accessor_field',
      'sampleSourceRefs array entries must be data properties.'
    );
    violations.push(...descriptorSnapshot.violations);
    const descriptor = descriptorSnapshot.descriptor;
    if (!descriptor) {
      violations.push(violation('sampleSourceRefs.missing_index', itemPath, 'sampleSourceRefs must be a dense array.'));
      continue;
    }
    if (!('value' in descriptor)) {
      violations.push(violation('sampleSourceRefs.accessor_field', itemPath, 'sampleSourceRefs array entries must be data properties.'));
      continue;
    }
    const readSnapshot = safeReadOwnDataPropertyForSourceSnapshot(
      sampleSourceRefs,
      String(index),
      descriptor,
      itemPath,
      'sampleSourceRefs.accessor_field',
      'sampleSourceRefs array entries must be data properties.'
    );
    violations.push(...readSnapshot.violations);
    if (readSnapshot.violations.length > 0) continue;
    items[index] = readSnapshot.value;
  }
  return { items, violations };
}

function defineSafeResult<T>(
  define: () => T,
  sourcePathPrefix: string,
  targetPathPrefix: string,
  fallbackCode: string,
  fallbackMessage: string
): { value?: T; violations: SourceContractViolation[] } {
  try {
    return { value: define(), violations: [] };
  } catch (error) {
    if (error instanceof SourceContractValidationError) {
      return {
        violations: error.violations.map((violationItem) => ({
          ...violationItem,
          path: remapPathPrefix(violationItem.path, sourcePathPrefix, targetPathPrefix)
        }))
      };
    }
    return { violations: [violation(fallbackCode, targetPathPrefix, fallbackMessage)] };
  }
}

function remapPathPrefix(path: string, sourcePathPrefix: string, targetPathPrefix: string): string {
  if (path === sourcePathPrefix) return targetPathPrefix;
  if (path.startsWith(`${sourcePathPrefix}.`)) return `${targetPathPrefix}${path.slice(sourcePathPrefix.length)}`;
  return path;
}
