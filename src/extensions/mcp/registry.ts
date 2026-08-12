import * as path from 'node:path';

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { isGenericContinuationQuery } from '../../core/retrieval-quality.js';
import { withAutoProjectPath } from './handlers.js';
import { mcpHandlerDomains } from './handlers/domains/index.js';
import type { McpHandlerDomain, McpToolHandler } from './handlers/domain-handler.js';
import { toolDefinitions } from './tool-definitions.js';

export const MCP_TOOL_PROFILES = ['core', 'operations', 'governance', 'experimental', 'all'] as const;
export type McpToolProfile = typeof MCP_TOOL_PROFILES[number];
export type McpMutationKind = 'read_only' | 'conditional' | 'mutating';

export interface McpMutationCondition {
  field: string;
  operator: 'equals' | 'not_equals' | 'absent' | 'absolute_path' | 'generic_continuation_query';
  value?: unknown;
  defaultValue?: unknown;
  description: string;
}

export type McpMutationExpression =
  | McpMutationCondition
  | { all: McpMutationExpression[] }
  | { any: McpMutationExpression[] };

interface McpReadOnlyMutation {
  kind: 'read_only';
}

interface McpMutatingMutation {
  kind: 'mutating';
}

export interface McpConditionalMutation {
  kind: 'conditional';
  writeWhen: McpMutationExpression;
  readOnlyOptOut?: Record<string, unknown>;
  evaluate: (args: Record<string, unknown>) => boolean;
}

export type McpMutationMetadata = McpReadOnlyMutation | McpMutatingMutation | McpConditionalMutation;

export interface McpToolRegistration {
  tool: Tool;
  profiles: readonly McpToolProfile[];
  mutation: McpMutationMetadata;
  handlerDomain: McpHandlerDomain['name'];
  handler: McpToolHandler;
  telemetryWrites?: readonly string[];
}

export const MCP_TOOL_PROFILE_ENV = 'CLAUDE_MEMORY_MCP_PROFILE';

const CORE_TOOL_NAMES = new Set([
  'mem-search',
  'mem-timeline',
  'mem-details',
  'mem-stats',
  'mem-context-pack',
  'mem-project-timeline',
  'mem-source-ref'
]);

const MUTATING_TOOL_NAMES = new Set([
  'mem-import-latest',
  'mem-facet-tag',
  'mem-action-update',
  'mem-checkpoint-create',
  'mem-lesson-save',
  'mem-asset-create',
  'mem-asset-update',
  'mem-asset-bind',
  'mem-asset-grant-set',
  'mem-shared-actor-link',
  'mem-shared-actor-unlink',
  'mem-actor-card-upsert',
  'mem-entity-supersede',
  'mem-core-block-update',
  'mem-perspective-observation-create',
  'mem-perspective-observation-delete'
]);

const CONTEXT_PACK_MUTATION: McpConditionalMutation = {
  kind: 'conditional',
  writeWhen: {
    all: [
      {
        field: 'projectPath',
        operator: 'absolute_path',
        description: 'An explicit or existing-store auto-resolved absolute projectPath is available.'
      },
      {
        any: [
          {
            field: 'refreshLatest',
            operator: 'equals',
            value: true,
            defaultValue: 'auto',
            description: 'Explicit refresh is enabled.'
          },
          {
            all: [
              {
                field: 'refreshLatest',
                operator: 'not_equals',
                value: false,
                defaultValue: 'auto',
                description: 'The read-only refresh opt-out is not set.'
              },
              {
                field: 'query',
                operator: 'generic_continuation_query',
                defaultValue: 'recent project context',
                description: 'The query is a generic continuation request.'
              },
              {
                field: 'sessionId',
                operator: 'absent',
                description: 'No source-session filter is set.'
              }
            ]
          }
        ]
      }
    ]
  },
  readOnlyOptOut: { refreshLatest: false },
  evaluate: contextPackWrites
};

const ASSET_CATALOG_MUTATION: McpConditionalMutation = {
  kind: 'conditional',
  writeWhen: {
    field: 'apply',
    operator: 'equals',
    value: true,
    defaultValue: false,
    description: 'Preview is read-only; apply=true creates missing catalog assets.'
  },
  readOnlyOptOut: { apply: false },
  evaluate: (args) => args.apply === true
};

function contextPackWrites(args: Record<string, unknown>): boolean {
  const effectiveArgs = withAutoProjectPath(args);
  const projectPath = typeof effectiveArgs.projectPath === 'string' ? effectiveArgs.projectPath.trim() : '';
  if (!projectPath || !path.isAbsolute(projectPath)) return false;
  if (effectiveArgs.refreshLatest === true) return true;
  if (effectiveArgs.refreshLatest === false) return false;

  const query = typeof effectiveArgs.query === 'string' && effectiveArgs.query.trim().length > 0
    ? effectiveArgs.query.trim()
    : 'recent project context';
  const sessionId = typeof effectiveArgs.sessionId === 'string' && effectiveArgs.sessionId.trim().length > 0
    ? effectiveArgs.sessionId.trim()
    : undefined;
  return sessionId === undefined && isGenericContinuationQuery(query);
}

function mutationForTool(name: string): McpMutationMetadata {
  if (name === 'mem-context-pack') return CONTEXT_PACK_MUTATION;
  if (name === 'mem-asset-catalog-sync') return ASSET_CATALOG_MUTATION;
  if (MUTATING_TOOL_NAMES.has(name)) return { kind: 'mutating' };
  return { kind: 'read_only' };
}

function profilesForTool(name: string, domain: McpHandlerDomain['name']): readonly McpToolProfile[] {
  if (CORE_TOOL_NAMES.has(name)) return MCP_TOOL_PROFILES;
  if (name === 'external-market-context') return ['experimental', 'all'];
  if (name === 'mem-import-latest' || domain === 'operations') return ['operations', 'all'];
  if (domain === 'graph-lessons') return ['experimental', 'all'];
  if (domain === 'governance-assets') return ['governance', 'all'];
  if (domain === 'perspective-shared') {
    return name.startsWith('mem-perspective-') ? ['experimental', 'all'] : ['governance', 'all'];
  }
  return ['all'];
}

function buildDomainMap(): Map<string, McpHandlerDomain> {
  const result = new Map<string, McpHandlerDomain>();
  for (const domain of mcpHandlerDomains) {
    for (const toolName of domain.toolNames) {
      if (result.has(toolName)) throw new Error(`Duplicate MCP handler registration: ${toolName}`);
      result.set(toolName, domain);
    }
  }
  return result;
}

function buildRegistry(): McpToolRegistration[] {
  const domainsByTool = buildDomainMap();
  const seenDefinitions = new Set<string>();
  const registrations = toolDefinitions.map((tool): McpToolRegistration => {
    if (seenDefinitions.has(tool.name)) throw new Error(`Duplicate MCP tool definition: ${tool.name}`);
    seenDefinitions.add(tool.name);
    const domain = domainsByTool.get(tool.name);
    if (!domain) throw new Error(`Missing MCP handler registration: ${tool.name}`);
    domainsByTool.delete(tool.name);
    return {
      tool,
      profiles: profilesForTool(tool.name, domain.name),
      mutation: mutationForTool(tool.name),
      handlerDomain: domain.name,
      handler: domain.handle,
      ...(tool.name === 'mem-context-pack'
        ? { telemetryWrites: ['best-effort retrieval query trace'] }
        : {})
    };
  });

  if (domainsByTool.size > 0) {
    throw new Error(`MCP handlers have no tool definitions: ${Array.from(domainsByTool.keys()).join(', ')}`);
  }
  return registrations;
}

export const mcpToolRegistry: readonly McpToolRegistration[] = buildRegistry();
const registryByName = new Map(mcpToolRegistry.map((entry) => [entry.tool.name, entry]));

// Compatibility export: all remains byte-for-byte identical to the pre-profile list.
export const tools: Tool[] = mcpToolRegistry.map((entry) => entry.tool);

export function resolveMcpToolProfile(value = process.env[MCP_TOOL_PROFILE_ENV]): McpToolProfile {
  if (value === undefined || value.trim() === '') return 'all';
  const normalized = value.trim().toLowerCase();
  if ((MCP_TOOL_PROFILES as readonly string[]).includes(normalized)) {
    return normalized as McpToolProfile;
  }
  throw new Error(
    `Unknown MCP tool profile "${value}". Expected one of: ${MCP_TOOL_PROFILES.join(', ')}.`
  );
}

export function getToolsForProfile(profile: McpToolProfile): Tool[] {
  return mcpToolRegistry
    .filter((entry) => entry.profiles.includes(profile))
    .map((entry) => entry.tool);
}

export function getMcpToolRegistration(name: string): McpToolRegistration | undefined {
  return registryByName.get(name);
}

export function willMcpToolMutate(name: string, args: Record<string, unknown>): boolean | undefined {
  const mutation = registryByName.get(name)?.mutation;
  if (!mutation) return undefined;
  if (mutation.kind === 'read_only') return false;
  if (mutation.kind === 'mutating') return true;
  return mutation.evaluate(args);
}

export async function dispatchRegisteredToolCall(
  name: string,
  args: Record<string, unknown>,
  profile: McpToolProfile = 'all'
): Promise<CallToolResult> {
  const registration = registryByName.get(name);
  if (!registration || !registration.profiles.includes(profile)) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true
    };
  }
  return registration.handler(name, args);
}
