import {
  type SourceContractViolation,
  getOwnField,
  hasOwnField,
  hasText,
  isRecord,
  isStableContractIdentifier,
  looksLikePrivacySensitiveSourceValue,
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

export function validateSourceAdapterIdentity(
  identity: Partial<SourceAdapterIdentity> | undefined,
  path = 'identity'
): SourceContractViolation[] {
  const violations: SourceContractViolation[] = [];
  if (!isRecord(identity)) {
    return [violation('identity.required', path, 'Source adapter identity is required.')];
  }

  pushUnknownFieldViolation(identity, ['id', 'version', 'displayName'], 'identity.unknown_field', path, violations);

  const id = getOwnField(identity, 'id');
  const version = getOwnField(identity, 'version');
  const displayName = getOwnField(identity, 'displayName');

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

  return violations;
}

export function validateSourceAdapterCapabilities(
  capabilities: Partial<SourceAdapterCapabilities> | undefined,
  path = 'capabilities'
): SourceContractViolation[] {
  const violations: SourceContractViolation[] = [];
  if (!isRecord(capabilities)) {
    return [violation('capabilities.required', path, 'Source adapter capabilities with currentnessStrategy are required.')];
  }

  Object.getOwnPropertySymbols(capabilities).forEach((key, index) => {
    const value = (capabilities as Record<symbol, unknown>)[key];
    const valuePath = `${path}.[symbol-${index}]`;
    violations.push(violation('capabilities.invalid_key', valuePath, 'Source adapter capability keys must be strings.'));
    validateCapabilityValue(String(key.description ?? ''), value, valuePath, violations);
  });

  Object.getOwnPropertyNames(capabilities).forEach((key) => {
    const value = (capabilities as Record<string, unknown>)[key];
    validateCapabilityValue(key, value, path, violations);
  });

  const currentnessStrategy = getOwnField(capabilities, 'currentnessStrategy');
  if (!hasOwnField(capabilities, 'currentnessStrategy') || !hasText(currentnessStrategy)) {
    violations.push(violation('capabilities.currentnessStrategy.required', `${path}.currentnessStrategy`, 'Source adapter capabilities must declare a deterministic currentnessStrategy.'));
  } else if (!isStableContractIdentifier(currentnessStrategy)) {
    violations.push(violation('capabilities.currentnessStrategy.unstable', `${path}.currentnessStrategy`, 'Source adapter currentnessStrategy must be stable and must not include a local absolute path.'));
  }

  return violations;
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

function pushUnknownFieldViolation(
  record: Record<string, unknown>,
  allowedFields: readonly string[],
  code: string,
  path: string,
  violations: SourceContractViolation[]
): void {
  const allowed = new Set(allowedFields);
  if (Reflect.ownKeys(record).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    violations.push(violation(code, path, 'Source adapter contract object contains unsupported fields.'));
  }
}
