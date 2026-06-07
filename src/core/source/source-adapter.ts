import {
  type SourceContractViolation,
  getOwnField,
  hasOwnField,
  hasText,
  isRecord,
  isStableContractIdentifier,
  looksLikePrivacySensitiveSourceValue,
  safeGetOwnPropertyDescriptorForSourceSnapshot,
  safeOwnKeysForSourceSnapshot,
  safeReadOwnDataPropertyForSourceSnapshot,
  snapshotAllowedRecordFields,
  violation
} from './source-schema.js';
import type { SourceRef } from './source-ref.js';
import type { SourceSchemaDeclaration } from './source-schema.js';
import type { SourceTransformationDeclaration } from './source-transformations.js';

export interface SourceAdapterIdentity {
  id: string;
  version: string;
  displayName?: string;
}

export interface SourceAdapterCapabilities extends Readonly<Record<string, boolean | string | number>> {
  readonly currentnessStrategy: string;
}

export interface SourceAdapterContract {
  identity: SourceAdapterIdentity;
  source: SourceSchemaDeclaration;
  transformations: readonly SourceTransformationDeclaration[];
  sampleSourceRefs?: readonly SourceRef[];
  capabilities: SourceAdapterCapabilities;
}

export interface PreparedSourceAdapterIdentity {
  readonly record?: Record<string, unknown>;
  readonly violations: SourceContractViolation[];
}

export interface PreparedSourceAdapterCapabilities {
  readonly record?: Record<string, unknown>;
  readonly violations: SourceContractViolation[];
}

export function validateSourceAdapterIdentity(
  identity: Partial<SourceAdapterIdentity> | undefined,
  path = 'identity'
): SourceContractViolation[] {
  return prepareSourceAdapterIdentity(identity, path).violations;
}

export function prepareSourceAdapterIdentity(
  identity: Partial<SourceAdapterIdentity> | undefined,
  path = 'identity'
): PreparedSourceAdapterIdentity {
  const snapshot = snapshotAllowedRecordFields(identity, ['id', 'version', 'displayName'], {
    path,
    requiredCode: 'identity.required',
    requiredMessage: 'Source adapter identity is required.',
    unknownCode: 'identity.unknown_field',
    unknownMessage: 'Source adapter contract object contains unsupported fields.',
    accessorCode: 'identity.accessor_field',
    accessorMessage: 'Source adapter identity fields must be data properties.'
  });
  if (!snapshot.record) return { violations: snapshot.violations };

  const violations: SourceContractViolation[] = [...snapshot.violations];
  const id = getOwnField(snapshot.record, 'id');
  const version = getOwnField(snapshot.record, 'version');
  const displayName = getOwnField(snapshot.record, 'displayName');

  if (!hasText(id)) {
    violations.push(violation('identity.id.required', `${path}.id`, 'Source adapter identity id must be non-empty.'));
  } else {
    if (!isStableContractIdentifier(id)) {
      violations.push(violation('identity.id.unstable', `${path}.id`, 'Source adapter identity id must be stable and must not include a local absolute path.'));
    }
    if (looksLikePrivacySensitiveSourceValue(id)) {
      violations.push(violation('identity.id.privacy_sensitive', `${path}.id`, 'Source adapter identity id must not leak local state handles or credential-shaped values.'));
    }
  }

  if (!hasText(version)) {
    violations.push(violation('identity.version.required', `${path}.version`, 'Source adapter identity version must be non-empty.'));
  } else if (looksLikePrivacySensitiveSourceValue(version)) {
    violations.push(violation('identity.version.privacy_sensitive', `${path}.version`, 'Source adapter identity version must not leak local state handles or credential-shaped values.'));
  }

  if (displayName !== undefined && typeof displayName !== 'string') {
    violations.push(violation('identity.displayName.invalid', `${path}.displayName`, 'Source adapter displayName must be a string when present.'));
  } else if (hasText(displayName) && looksLikePrivacySensitiveSourceValue(displayName)) {
    violations.push(violation('identity.displayName.privacy_sensitive', `${path}.displayName`, 'Source adapter displayName must not leak local state handles or credential-shaped values.'));
  }

  return { record: snapshot.record, violations };
}

export function freezeSourceAdapterIdentity(identity: Record<string, unknown>): Readonly<SourceAdapterIdentity> {
  const id = getOwnField<string>(identity, 'id');
  const version = getOwnField<string>(identity, 'version');
  const displayName = getOwnField<string>(identity, 'displayName');
  const defined: SourceAdapterIdentity = {
    id: id!,
    version: version!
  };
  if (displayName !== undefined) defined.displayName = displayName;
  return Object.freeze(defined);
}

export function validateSourceAdapterCapabilities(
  capabilities: Partial<SourceAdapterCapabilities> | undefined,
  path = 'capabilities'
): SourceContractViolation[] {
  return prepareSourceAdapterCapabilities(capabilities, path).violations;
}

export function prepareSourceAdapterCapabilities(
  capabilities: Partial<SourceAdapterCapabilities> | undefined,
  path = 'capabilities'
): PreparedSourceAdapterCapabilities {
  if (!isRecord(capabilities)) {
    return {
      violations: [violation('capabilities.required', path, 'Source adapter capabilities with currentnessStrategy are required.')]
    };
  }

  const record: Record<string, unknown> = Object.create(null);
  const keySnapshot = safeOwnKeysForSourceSnapshot(capabilities, path, 'capabilities.accessor_field', 'Source adapter capability fields must be data properties.');
  const violations: SourceContractViolation[] = [...keySnapshot.violations];

  keySnapshot.keys.forEach((key, index) => {
    if (typeof key !== 'string') {
      const valuePath = `${path}.[symbol-${index}]`;
      violations.push(violation('capabilities.invalid_key', valuePath, 'Source adapter capability keys must be strings.'));
      const descriptorSnapshot = safeGetOwnPropertyDescriptorForSourceSnapshot(capabilities, key, valuePath, 'capabilities.accessor_field', 'Source adapter capability fields must be data properties.');
      violations.push(...descriptorSnapshot.violations);
      const descriptor = descriptorSnapshot.descriptor;
      if (!descriptor || !('value' in descriptor)) {
        violations.push(violation('capabilities.accessor_field', valuePath, 'Source adapter capability fields must be data properties.'));
        return;
      }
      const readSnapshot = safeReadOwnDataPropertyForSourceSnapshot(capabilities, key, descriptor, valuePath, 'capabilities.accessor_field', 'Source adapter capability fields must be data properties.');
      violations.push(...readSnapshot.violations);
      if (readSnapshot.violations.length > 0) return;
      validateCapabilityValue(propertyKeyDescription(key), readSnapshot.value, valuePath, violations);
      return;
    }

    const valuePath = capabilityEntryPath(path, key, index);
    const descriptorSnapshot = safeGetOwnPropertyDescriptorForSourceSnapshot(capabilities, key, valuePath, 'capabilities.accessor_field', 'Source adapter capability fields must be data properties.');
    violations.push(...descriptorSnapshot.violations);
    const descriptor = descriptorSnapshot.descriptor;
    if (!descriptor || !('value' in descriptor)) {
      violations.push(violation('capabilities.accessor_field', valuePath, 'Source adapter capability fields must be data properties.'));
      return;
    }
    const readSnapshot = safeReadOwnDataPropertyForSourceSnapshot(capabilities, key, descriptor, valuePath, 'capabilities.accessor_field', 'Source adapter capability fields must be data properties.');
    violations.push(...readSnapshot.violations);
    if (readSnapshot.violations.length > 0) return;
    record[key] = readSnapshot.value;
    validateCapabilityValue(key, readSnapshot.value, valuePath, violations);
  });

  const currentnessStrategy = getOwnField(record, 'currentnessStrategy');
  if (!hasOwnField(record, 'currentnessStrategy') || !hasText(currentnessStrategy)) {
    violations.push(violation('capabilities.currentnessStrategy.required', `${path}.currentnessStrategy`, 'Source adapter capabilities must declare a deterministic currentnessStrategy.'));
  } else if (!isStableContractIdentifier(currentnessStrategy)) {
    violations.push(violation('capabilities.currentnessStrategy.unstable', `${path}.currentnessStrategy`, 'Source adapter currentnessStrategy must be stable and must not include a local absolute path.'));
  }

  return { record, violations };
}

export function freezeSourceAdapterCapabilities(capabilities: Record<string, unknown>): SourceAdapterCapabilities {
  const keySnapshot = safeOwnKeysForSourceSnapshot(capabilities, 'capabilities', 'capabilities.accessor_field', 'Source adapter capability fields must be data properties.');
  const safeEntries: Array<[string, unknown]> = [];
  keySnapshot.keys.forEach((key) => {
    if (typeof key !== 'string') return;
    const descriptorSnapshot = safeGetOwnPropertyDescriptorForSourceSnapshot(capabilities, key, `capabilities.${key}`, 'capabilities.accessor_field', 'Source adapter capability fields must be data properties.');
    const descriptor = descriptorSnapshot.descriptor;
    if (descriptor && 'value' in descriptor) safeEntries.push([key, descriptor.value]);
  });
  return Object.freeze(Object.fromEntries(safeEntries)) as SourceAdapterCapabilities;
}

function propertyKeyDescription(key: PropertyKey): string {
  return typeof key === 'symbol' ? String(key.description ?? '') : '';
}

function capabilityEntryPath(path: string, key: string, index: number): string {
  if (looksLikePrivacySensitiveSourceValue(key)) {
    return `${path}.[redacted-key-${index}]`;
  }
  const sanitizedKey = key.replace(/[^A-Za-z0-9._:-]+/g, '_').slice(0, 64);
  return sanitizedKey ? `${path}.${sanitizedKey}` : `${path}.${index}`;
}

function validateCapabilityValue(
  key: string,
  value: unknown,
  path: string,
  violations: SourceContractViolation[]
): void {
  if (looksLikePrivacySensitiveSourceValue(key)) {
    violations.push(violation('capabilities.privacy_sensitive', path, 'Source adapter capability keys must not leak local state handles or credential-shaped values.'));
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      violations.push(violation('capabilities.invalid_value', path, 'Source adapter capability numbers must be finite.'));
    }
    if (looksLikePrivacySensitiveSourceValue(String(value), key)) {
      violations.push(violation('capabilities.privacy_sensitive', path, 'Source adapter capability values must not leak local state handles or credential-shaped values.'));
    }
    return;
  }
  if (typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (looksLikePrivacySensitiveSourceValue(value, key)) {
      violations.push(violation('capabilities.privacy_sensitive', path, 'Source adapter capability values must not leak local state handles or credential-shaped values.'));
    }
    return;
  }
  violations.push(violation('capabilities.invalid_value', path, 'Source adapter capability values must be scalar strings, finite numbers, or booleans.'));
}
