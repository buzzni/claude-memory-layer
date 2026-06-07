import { createHash } from 'node:crypto';

import {
  createSourceRef,
  defineSourceAdapter,
  looksLikeLocalAbsolutePath,
  looksLikePrivacySensitiveSourceValue,
  type SourceRef,
  type SourceRefMetadataValue
} from '../../../core/source/index.js';

export const HERMES_HISTORY_ADAPTER_ID = 'hermes-history';
export const HERMES_HISTORY_ADAPTER_VERSION = '1.0.0';
export const HERMES_HISTORY_SOURCE_SCHEMA_VERSION = '1';
export const HERMES_HISTORY_CAPTURE_MODE = 'history_import';
export const HERMES_HISTORY_PRIVACY_CLASS = 'confidential';

export interface HermesHistorySourceRefInput {
  sessionId: string;
  messageId?: string | number;
  hermesSource?: string;
}

export const hermesHistorySourceAdapter = defineSourceAdapter({
  identity: {
    id: HERMES_HISTORY_ADAPTER_ID,
    displayName: 'Hermes history',
    version: HERMES_HISTORY_ADAPTER_VERSION
  },
  source: {
    id: HERMES_HISTORY_ADAPTER_ID,
    version: HERMES_HISTORY_SOURCE_SCHEMA_VERSION,
    privacyClass: HERMES_HISTORY_PRIVACY_CLASS,
    captureMode: HERMES_HISTORY_CAPTURE_MODE,
    metadataSchema: 'hermes-sessiondb@1',
    description: 'Opt-in Hermes SessionDB history imports; source paths remain local configuration and are redacted from public source refs.'
  },
  transformations: [
    {
      id: 'hermes-sessiondb-to-cml-events',
      version: '1.0.0',
      kind: 'normalize',
      inputSchema: 'hermes-sessiondb@1',
      outputSchema: 'cml-raw-event@1',
      deterministic: true,
      description: 'Normalize Hermes sessions/messages into CML user and assistant events without changing importer behavior.'
    },
    {
      id: 'hermes-history-privacy-filter',
      version: '1.0.0',
      kind: 'privacy-filter',
      inputSchema: 'hermes-message-content@1',
      outputSchema: 'cml-privacy-filtered-content@1',
      deterministic: true,
      description: 'Apply the existing CML privacy filter before imported Hermes content is stored.'
    }
  ],
  sampleSourceRefs: [
    createSourceRef({
      kind: 'database',
      stableId: 'hermes-history:state-db',
      publicHandle: 'hermes-history:state-db',
      evidenceHandle: 'hermes-history:state-db',
      privacyClass: HERMES_HISTORY_PRIVACY_CLASS,
      captureMode: HERMES_HISTORY_CAPTURE_MODE,
      metadata: {
        adapterId: HERMES_HISTORY_ADAPTER_ID,
        pathDisclosure: 'redacted'
      }
    })
  ],
  capabilities: {
    supportsIncrementalImport: true,
    currentnessStrategy: 'session-started-at-and-message-id',
    supportsLiveSync: false,
    sourcePathDisclosure: 'redacted'
  }
});

export function createHermesHistorySourceRef(input: HermesHistorySourceRefInput): SourceRef {
  const sessionHash = stableHash(requireNonEmpty(input.sessionId, 'sessionId'));
  const messageId = normalizeMessageId(input.messageId);
  const baseHandle = `${HERMES_HISTORY_ADAPTER_ID}:session:${sessionHash}`;
  const publicHandle = messageId ? `${baseHandle}:message:${messageId}` : baseHandle;
  const metadata: Record<string, SourceRefMetadataValue> = {
    adapterId: HERMES_HISTORY_ADAPTER_ID,
    sourceSessionHash: sessionHash
  };

  const hermesSource = normalizeHermesSource(input.hermesSource);
  if (hermesSource) {
    metadata.hermesSource = hermesSource;
  }
  if (messageId) {
    metadata.messageId = typeof input.messageId === 'number' ? input.messageId : messageId;
  }

  return createSourceRef({
    kind: messageId ? 'message' : 'session',
    stableId: publicHandle,
    publicHandle,
    evidenceHandle: messageId
      ? `${HERMES_HISTORY_ADAPTER_ID}:evidence:${sessionHash}:message:${messageId}`
      : `${HERMES_HISTORY_ADAPTER_ID}:evidence:${sessionHash}`,
    privacyClass: HERMES_HISTORY_PRIVACY_CLASS,
    captureMode: HERMES_HISTORY_CAPTURE_MODE,
    metadata
  });
}

function requireNonEmpty(value: string, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Hermes history source ref ${fieldName} is required.`);
  }
  return value;
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function normalizeHermesSource(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return shouldRedactLocalSourceValue(trimmed) ? 'redacted' : trimmed;
}

function normalizeMessageId(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  if (shouldRedactLocalSourceValue(raw)) return `hash-${stableHash(raw)}`;
  const safe = raw.replace(/[^A-Za-z0-9._:@-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || stableHash(raw);
}

function shouldRedactLocalSourceValue(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, '/');
  return looksLikePrivacySensitiveSourceValue(normalized)
    || looksLikeLocalAbsolutePath(normalized)
    || /^file:/i.test(normalized)
    || normalized === 'state.db'
    || normalized.endsWith('/state.db')
    || /(?:^|\/)\.hermes(?:\/|$)/.test(normalized)
    || normalized.startsWith('~/.hermes/');
}
