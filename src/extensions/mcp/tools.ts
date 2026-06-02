/**
 * MCP Tool Definitions
 * Available tools for Claude Desktop
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const projectPathProperty = {
  type: 'string',
  description: 'Optional: absolute project path to search a project-scoped claude-memory-layer store instead of the global store'
} as const;

const requiredProjectPathProperty = {
  type: 'string',
  description: 'Required absolute project path for project-scoped memory operation tools; prevents cross-project leakage.'
} as const;

const actorProperty = {
  type: 'string',
  description: 'Actor identifier recorded in governance audit metadata for state-changing operations.'
} as const;

const targetActorAliasAnyOf = [
  { required: ['targetActorId'] },
  { required: ['observedActorId'] }
] as const;

const memoryOperationTargetTypeProperty = {
  type: 'string',
  enum: ['event', 'entity', 'edge', 'consolidated_memory', 'lesson', 'action'],
  description: 'Facet/retention operation target type from the memory operations model.'
} as const;

const checkpointTargetTypeProperty = {
  type: 'string',
  enum: ['action', 'session'],
  description: 'Checkpoint target type. Checkpoints resume either an action or a session.'
} as const;

const operationLimitProperty = {
  type: 'number',
  maximum: 100,
  description: 'Maximum number of compact, privacy-safe results to return (default: 50, max: 100).'
} as const;

export const tools: Tool[] = [
  {
    name: 'external-market-context',
    description: 'Read-only external market/company context from DART, FRED, and Finnhub with structured MarketContextSnapshot bull/bear/risk/catalyst analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Optional company name for report subject and DART fallback search' },
        dartCorpCode: { type: 'string', description: 'Optional exact DART corp_code for issuer-specific filings' },
        symbol: { type: 'string', description: 'Optional listed ticker for Finnhub company profile' },
        providers: { type: 'array', items: { type: 'string', enum: ['dart', 'fred', 'finnhub'] }, description: 'Providers to fetch (default: dart, fred, finnhub)' },
        fredSeries: { type: 'array', items: { type: 'string' }, description: 'Optional FRED series IDs (default: FEDFUNDS, CPIAUCSL, UNRATE)' },
        includeSnapshot: { type: 'boolean', description: 'Include structured MarketContextSnapshot and DART company snapshot (default: true)' },
        projectPath: projectPathProperty
      }
    }
  },
  {
    name: 'mem-search',
    description: 'Search claude-memory-layer for relevant past conversations and insights. Returns a compact index of results - use mem-details to get full content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query'
        },
        topK: {
          type: 'number',
          description: 'Maximum number of results (default: 5, max: 20)'
        },
        sessionId: {
          type: 'string',
          description: 'Optional: filter by specific session ID'
        },
        projectPath: projectPathProperty,
        eventType: {
          type: 'string',
          enum: ['user_prompt', 'agent_response', 'tool_observation', 'session_summary'],
          description: 'Optional: filter by event type'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'mem-timeline',
    description: 'Get chronological context around specific memories. Useful for understanding the conversation flow.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Memory IDs (from mem-search) to get timeline for'
        },
        windowSize: {
          type: 'number',
          description: 'Number of items before/after each ID (default: 3)'
        },
        projectPath: projectPathProperty
      },
      required: ['ids']
    }
  },
  {
    name: 'mem-details',
    description: 'Get full content of specific memories. Use after mem-search to get complete information.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Memory IDs to fetch full details for'
        },
        projectPath: projectPathProperty
      },
      required: ['ids']
    }
  },
  {
    name: 'mem-stats',
    description: 'Get statistics about the memory storage (total events, sessions, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty
      }
    }
  },
  {
    name: 'mem-context-pack',
    description: 'Build a compact, agent-ready project context pack from relevant memories plus recent project timeline. Use at the start of Hermes/Codex work to recover the important project state without reading raw transcripts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional task/topic query. Defaults to recent project context.'
        },
        topK: {
          type: 'number',
          description: 'Maximum relevant memories to include (default: 5, max: 12)'
        },
        recentLimit: {
          type: 'number',
          description: 'Maximum recent events to inspect for project timeline (default: 30, max: 200)'
        },
        sessionLimit: {
          type: 'number',
          description: 'Maximum recent sessions to summarize (default: 5, max: 20)'
        },
        sessionId: {
          type: 'string',
          description: 'Optional: filter relevant memories by specific session ID'
        },
        projectPath: projectPathProperty,
        compression: {
          type: 'string',
          enum: ['off', 'safe', 'aggressive'],
          description: 'Optional context-pack compression mode. safe preserves source refs and high-signal errors/log lines; aggressive is more compact.'
        },
        maxChars: {
          type: 'number',
          description: 'Maximum final context-pack characters after safe compression (default: no hard cap, max: 50000)'
        },
        maxTokens: {
          type: 'number',
          description: 'Maximum final context-pack tokens, estimated at ~4 chars/token, after safe compression (default: no hard cap)'
        },
        refreshLatest: {
          type: 'boolean',
          description: 'Import latest local session history before retrieval. Generic continuation queries auto-refresh when absolute projectPath is supplied and no sessionId filter is set; set false to opt out. Auto-refresh and explicit true both mutate project memory; explicit true also requires absolute projectPath.'
        },
        refreshSources: {
          type: 'array',
          items: { type: 'string', enum: ['claude', 'codex', 'hermes'] },
          description: 'Sources to refresh when refreshLatest is true or auto-refresh runs (default: hermes and codex)'
        },
        refreshSessionLimit: {
          type: 'number',
          description: 'Maximum recent matching sessions per refresh source (default: 1, max: 10)'
        },
        refreshMessageLimit: {
          type: 'number',
          description: 'Maximum messages/memories per refresh source (default: 200, max: 1000)'
        },
        refreshForce: {
          type: 'boolean',
          description: 'Force reimport during refresh by deleting existing events for imported sessions first (default: false)'
        },
        refreshEmbeddings: {
          type: 'boolean',
          description: 'Process pending embeddings after refresh (default: false for fast context retrieval)'
        },
        sessionsDir: {
          type: 'string',
          description: 'Optional Codex sessions directory override for refreshLatest'
        },
        stateDb: {
          type: 'string',
          description: 'Optional Hermes state database path override for refreshLatest'
        },
        observerActorId: {
          type: 'string',
          description: 'Optional perspective observer actor id. When supplied with targetActorId, adds an actor-card/perspective lane.'
        },
        targetActorId: {
          type: 'string',
          description: 'Optional perspective target actor id (the observed actor). Requires observerActorId for perspective context.'
        },
        observedActorId: {
          type: 'string',
          description: 'Alias for targetActorId.'
        },
        includeActorCard: {
          type: 'boolean',
          description: 'Include the compact actor card for observerActorId -> targetActorId when available (default: true when perspective actors are supplied).'
        },
        includePerspectiveObservations: {
          type: 'boolean',
          description: 'Include relevant perspective observations for observerActorId -> targetActorId when available (default: true when perspective actors are supplied).'
        },
        limitToSession: {
          type: 'boolean',
          description: 'When true and sessionId is supplied, restrict perspective observations to session-scoped plus durable observations.'
        },
        reasoningLevel: {
          type: 'string',
          enum: ['minimal', 'low', 'medium', 'high'],
          description: 'Perspective context breadth hint: minimal/low return fewer observations, medium/high return more derived context.'
        }
      }
    }
  },
  {
    name: 'mem-import-latest',
    description: 'Explicitly import the latest local Claude Code, Codex, and/or Hermes session history into project-scoped memory before retrieving context. This mutates memory; use for freshness jobs before mem-context-pack.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Required absolute project path. Import is always project-scoped to avoid cross-project memory mixing.'
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['claude', 'codex', 'hermes'] },
          description: 'Sources to import (default: hermes and codex)'
        },
        sessionLimit: {
          type: 'number',
          description: 'Maximum recent matching sessions per source to import (default: 1, max: 10)'
        },
        messageLimit: {
          type: 'number',
          description: 'Maximum messages/memories per source import (default: 200, max: 1000)'
        },
        force: {
          type: 'boolean',
          description: 'Force reimport by deleting existing events for imported sessions first (default: false)'
        },
        processEmbeddings: {
          type: 'boolean',
          description: 'Process pending embeddings after import (default: false for fast freshness imports)'
        },
        sessionsDir: {
          type: 'string',
          description: 'Optional Codex sessions directory override'
        },
        stateDb: {
          type: 'string',
          description: 'Optional Hermes state database path override'
        }
      },
      required: ['projectPath']
    }
  },
  {
    name: 'mem-project-timeline',
    description: 'Summarize recent project memory by session, source agent, event counts, and safe previews. Useful for understanding what happened recently before continuing work.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum recent events to inspect (default: 50, max: 500)'
        },
        sessionLimit: {
          type: 'number',
          description: 'Maximum sessions to summarize (default: 10, max: 50)'
        },
        projectPath: projectPathProperty
      }
    }
  },
  {
    name: 'mem-source-ref',
    description: 'Resolve memory IDs, mem citation IDs, or event: IDs into privacy-safe source references with redacted previews and safe metadata only. Prefer this before mem-details when raw transcript exposure is unnecessary.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Memory/event IDs to resolve. Accepts full event IDs, event:<id>, mem:<citation>, or bare citation IDs.'
        },
        maxContentChars: {
          type: 'number',
          description: 'Maximum redacted preview characters per source (default: 500, max: 2000)'
        },
        lookupLimit: {
          type: 'number',
          description: 'Maximum recent events to scan for ID resolution (default: 10000, max: 50000)'
        },
        projectPath: projectPathProperty
      },
      required: ['ids']
    }
  },
  {
    name: 'mem-facet-query',
    description: 'Query project-scoped memory facets and return compact privacy-safe facet rows for filtering or inspection.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        dimension: {
          type: 'string',
          description: 'Optional facet dimension to filter by, such as workflow, artifact, task_type, source, or confidence.'
        },
        value: {
          type: 'string',
          description: 'Optional facet value to filter by within the selected dimension.'
        },
        targetType: memoryOperationTargetTypeProperty,
        targetId: {
          type: 'string',
          description: 'Optional project-scoped target identifier to inspect facets for.'
        },
        limit: operationLimitProperty
      },
      required: ['projectPath']
    }
  },
  {
    name: 'mem-facet-tag',
    description: 'Attach or update a project-scoped facet tag on a memory operations target with governance audit metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        targetType: memoryOperationTargetTypeProperty,
        targetId: {
          type: 'string',
          description: 'Project-scoped target identifier to tag.'
        },
        dimension: {
          type: 'string',
          description: 'Facet dimension to write, such as workflow, artifact, task_type, source, or confidence.'
        },
        value: {
          type: 'string',
          description: 'Facet value to write. Handler must sanitize before persistence.'
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Optional confidence for the facet assertion (0-1).'
        },
        sourceEventIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional bounded source event references used as evidence.'
        },
        actor: actorProperty
      },
      required: ['projectPath', 'targetType', 'targetId', 'dimension', 'value', 'actor']
    }
  },
  {
    name: 'mem-action-list',
    description: 'List project-scoped memory actions with compact status/frontier metadata and no raw transcript disclosure.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'done', 'blocked', 'cancelled'],
          description: 'Optional action status filter.'
        },
        includeTerminal: {
          type: 'boolean',
          description: 'Whether to include terminal done/cancelled actions (default: false).'
        },
        limit: operationLimitProperty
      },
      required: ['projectPath']
    }
  },
  {
    name: 'mem-action-update',
    description: 'Update a project-scoped memory action status through an audited, state-changing operation.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        actionId: {
          type: 'string',
          description: 'Project-scoped action identifier to update.'
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'done', 'blocked', 'cancelled'],
          description: 'New action status.'
        },
        note: {
          type: 'string',
          description: 'Optional sanitized note for the audit trail.'
        },
        sourceEventIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional bounded source event references used as evidence for the status update.'
        },
        actor: actorProperty
      },
      required: ['projectPath', 'actionId', 'status', 'actor']
    }
  },
  {
    name: 'mem-frontier',
    description: 'Return the project-scoped execution frontier: next actions, blocked work, checkpoints, and safe resume hints.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        includeBlocked: {
          type: 'boolean',
          description: 'Whether to include blocked/cancelled items in the compact frontier output (default: false).'
        },
        limit: operationLimitProperty
      },
      required: ['projectPath']
    }
  },
  {
    name: 'mem-checkpoint-create',
    description: 'Create an audited project-scoped checkpoint for a resumable operation target without exposing raw local paths or transcript content.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        targetType: checkpointTargetTypeProperty,
        targetId: {
          type: 'string',
          description: 'Project-scoped action or session identifier the checkpoint resumes from.'
        },
        label: {
          type: 'string',
          description: 'Short sanitized checkpoint label.'
        },
        state: {
          type: 'object',
          description: 'Optional bounded JSON checkpoint state. Handler must sanitize before persistence.'
        },
        sourceEventIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional bounded source event references used as evidence.'
        },
        actor: actorProperty
      },
      required: ['projectPath', 'targetType', 'targetId', 'label', 'actor']
    }
  },
  {
    name: 'mem-checkpoint-list',
    description: 'List project-scoped checkpoints with bounded metadata for safe task resumption.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        targetType: checkpointTargetTypeProperty,
        targetId: {
          type: 'string',
          description: 'Optional action or session identifier filter.'
        },
        limit: operationLimitProperty
      },
      required: ['projectPath']
    }
  },
  {
    name: 'mem-retention-audit',
    description: 'Run a dry-run retention governance audit for project-scoped memories and return policy explanations without hard deletion.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        policyVersion: {
          type: 'string',
          description: 'Optional retention policy version (default: v1).'
        },
        targetType: memoryOperationTargetTypeProperty,
        targetId: {
          type: 'string',
          description: 'Optional target identifier to audit one item.'
        },
        dryRun: {
          type: 'boolean',
          const: true,
          description: 'Must remain dry-run for P0 retention tooling; no hard delete action is exposed.'
        },
        limit: {
          type: 'number',
          maximum: 500,
          description: 'Maximum audit rows to return (default: 50, max: 500).'
        }
      },
      required: ['projectPath']
    }
  },
  {
    name: 'mem-graph-query',
    description: 'Run bounded project-scoped graph expansion/query diagnostics over active entities and edges with sanitized explanations.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        query: {
          type: 'string',
          description: 'Natural-language or entity query used to extract start entities and return bounded graph paths.'
        },
        startEntityTitle: {
          type: 'string',
          description: 'Optional explicit start entity title. Handler must sanitize before disclosure.'
        },
        direction: {
          type: 'string',
          enum: ['outgoing', 'incoming', 'both'],
          description: 'Traversal direction for active graph edges (default: both).'
        },
        maxHops: {
          type: 'number',
          minimum: 1,
          maximum: 2,
          description: 'Maximum bounded graph hops; operation tooling must clamp to <=2.'
        },
        limit: operationLimitProperty
      },
      required: ['projectPath', 'query']
    }
  },
  {
    name: 'mem-lesson-list',
    description: 'List project-scoped procedural lessons as compact skill/runbook candidates without raw transcript or local path disclosure.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        skillCandidate: {
          type: 'boolean',
          description: 'Optional filter for lessons marked as manual skill candidates.'
        },
        minConfidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Optional minimum lesson confidence threshold.'
        },
        limit: {
          type: 'number',
          maximum: 100,
          description: 'Maximum lessons to return (default: 50, max: 100).'
        }
      },
      required: ['projectPath']
    }
  },
  {
    name: 'mem-actor-list',
    description: 'List project-scoped or global memory actors with compact privacy-safe identity metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        kind: {
          type: 'string',
          enum: ['user', 'assistant', 'subagent', 'tool', 'system', 'integration', 'unknown'],
          description: 'Optional actor kind filter.'
        },
        source: {
          type: 'string',
          description: 'Optional actor source filter such as hermes, claude, codex, discord, telegram, mcp, or tool.'
        },
        limit: operationLimitProperty
      },
      required: ['projectPath']
    }
  },
  {
    name: 'mem-actor-card-get',
    description: 'Read the compact actor card for one observer -> observed perspective without raw transcript disclosure.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        observerActorId: {
          type: 'string',
          description: 'Observer actor id for the perspective card.'
        },
        observedActorId: {
          type: 'string',
          description: 'Observed/target actor id for the perspective card.'
        },
        targetActorId: {
          type: 'string',
          description: 'Alias for observedActorId.'
        }
      },
      required: ['projectPath', 'observerActorId'],
      anyOf: targetActorAliasAnyOf
    }
  },
  {
    name: 'mem-actor-card-upsert',
    description: 'Create or replace a compact actor card through an audited state-changing perspective operation.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        observerActorId: {
          type: 'string',
          description: 'Observer actor id for the perspective card.'
        },
        observedActorId: {
          type: 'string',
          description: 'Observed/target actor id for the perspective card.'
        },
        targetActorId: {
          type: 'string',
          description: 'Alias for observedActorId.'
        },
        entries: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 40,
          description: 'Actor-card entries. Each entry must start with IDENTITY:, ATTRIBUTE:, RELATIONSHIP:, or INSTRUCTION:.'
        },
        sourceEventIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional bounded source event references used as evidence.'
        },
        actor: actorProperty
      },
      required: ['projectPath', 'observerActorId', 'entries', 'actor'],
      anyOf: targetActorAliasAnyOf
    }
  },
  {
    name: 'mem-perspective-query',
    description: 'Query observer -> observed perspective observations as a separate retrieval lane with source-reference hints.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        observerActorId: {
          type: 'string',
          description: 'Optional observer actor id filter.'
        },
        targetActorId: {
          type: 'string',
          description: 'Optional observed/target actor id filter.'
        },
        observedActorId: {
          type: 'string',
          description: 'Alias for targetActorId.'
        },
        sessionId: {
          type: 'string',
          description: 'Optional session id filter; durable observations are also eligible.'
        },
        levels: {
          type: 'array',
          items: { type: 'string', enum: ['explicit', 'deductive', 'inductive', 'contradiction'] },
          description: 'Optional observation levels to include.'
        },
        query: {
          type: 'string',
          description: 'Optional natural-language filter over observation content.'
        },
        includeDeleted: {
          type: 'boolean',
          description: 'Include soft-deleted observations (default: false).'
        },
        limit: operationLimitProperty
      },
      required: ['projectPath']
    }
  },
  {
    name: 'mem-perspective-context',
    description: 'Build a compact actor-card plus perspective-observation context bundle for one observer -> target actor pair.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        observerActorId: {
          type: 'string',
          description: 'Observer actor id for the context bundle.'
        },
        targetActorId: {
          type: 'string',
          description: 'Observed/target actor id for the context bundle.'
        },
        observedActorId: {
          type: 'string',
          description: 'Alias for targetActorId.'
        },
        sessionId: {
          type: 'string',
          description: 'Optional session id filter when limitToSession is true.'
        },
        query: {
          type: 'string',
          description: 'Optional natural-language filter over observation content.'
        },
        includeActorCard: {
          type: 'boolean',
          description: 'Include actor card entries when available (default: true).'
        },
        includePerspectiveObservations: {
          type: 'boolean',
          description: 'Include observations when available (default: true).'
        },
        limitToSession: {
          type: 'boolean',
          description: 'When true and sessionId is supplied, restrict observations to session-scoped plus durable observations.'
        },
        reasoningLevel: {
          type: 'string',
          enum: ['minimal', 'low', 'medium', 'high'],
          description: 'Context breadth hint controlling observation limit.'
        },
        limit: operationLimitProperty
      },
      required: ['projectPath', 'observerActorId'],
      anyOf: targetActorAliasAnyOf
    }
  },
  {
    name: 'mem-perspective-observation-create',
    description: 'Create an audited observer -> observed perspective observation with bounded evidence references.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        observerActorId: {
          type: 'string',
          description: 'Observer actor id.'
        },
        observedActorId: {
          type: 'string',
          description: 'Observed/target actor id.'
        },
        targetActorId: {
          type: 'string',
          description: 'Alias for observedActorId.'
        },
        sessionId: {
          type: 'string',
          description: 'Optional session id that scoped the observation.'
        },
        level: {
          type: 'string',
          enum: ['explicit', 'deductive', 'inductive', 'contradiction'],
          description: 'Observation level (default: explicit).'
        },
        content: {
          type: 'string',
          description: 'Observation content. Handler sanitizes before persistence.'
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Optional confidence for the observation.'
        },
        sourceEventIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Bounded source event references used as evidence.'
        },
        sourceObservationIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Bounded source observation references used as evidence for derived observations.'
        },
        createdBy: {
          type: 'string',
          enum: ['rule', 'llm', 'manual', 'import'],
          description: 'Creation source label (default: manual).'
        },
        metadata: {
          type: 'object',
          description: 'Optional sanitized metadata.'
        },
        actor: actorProperty
      },
      required: ['projectPath', 'observerActorId', 'content', 'actor'],
      anyOf: targetActorAliasAnyOf
    }
  },
  {
    name: 'mem-perspective-observation-delete',
    description: 'Soft-delete an audited perspective observation by id; hard deletion is not exposed.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: requiredProjectPathProperty,
        observationId: {
          type: 'string',
          description: 'Perspective observation id to soft-delete.'
        },
        actor: actorProperty
      },
      required: ['projectPath', 'observationId', 'actor']
    }
  }
];
