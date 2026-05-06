/**
 * Product-level validation matrix for claude-memory-layer.
 *
 * This module is intentionally data-first so CLI/reporting/docs can reuse the
 * same surface -> requirement -> evidence map that tests assert stays covered.
 */

export type ProductValidationArea = 'claude' | 'codex' | 'hermes' | 'mcp' | 'cli' | 'safety';
export type ProductValidationStatus = 'ready' | 'covered' | 'partial' | 'planned';
export type ProductValidationEvidenceKind = 'test' | 'source' | 'command' | 'doc';

export interface ProductValidationEvidence {
  kind: ProductValidationEvidenceKind;
  ref: string;
  note: string;
}

export interface ProductValidationSurface {
  id: string;
  area: ProductValidationArea;
  title: string;
  status: ProductValidationStatus;
  requirements: string[];
  evidence: ProductValidationEvidence[];
}

export interface ProductValidationMatrixSummary {
  totalSurfaces: number;
  requirementCount: number;
  evidenceCount: number;
  surfacesByArea: Record<ProductValidationArea, number>;
  statusCounts: Record<ProductValidationStatus, number>;
}

export const productValidationMatrix: readonly ProductValidationSurface[] = [
  {
    id: 'claude.adapter.import',
    area: 'claude',
    title: 'Claude adapter import',
    status: 'covered',
    requirements: [
      'Import Claude Code JSONL transcripts without storing tool-result noise as user prompts.',
      'Preserve session/project mapping and turn grouping for retrieval continuity.'
    ],
    evidence: [
      { kind: 'test', ref: 'tests/core/session-history-importer-filter.test.ts', note: 'Filters local-command artifacts and keeps substantive prompts.' },
      { kind: 'source', ref: 'src/services/session-history-importer.ts', note: 'Claude JSONL import pipeline and project/session registration.' }
    ]
  },
  {
    id: 'claude.adapter.search',
    area: 'claude',
    title: 'Claude adapter search',
    status: 'covered',
    requirements: [
      'Expose semantic memory search with project/session scoping and fast/deep strategies.',
      'Return plain and disclosure-aware search output without mutating memory.'
    ],
    evidence: [
      { kind: 'test', ref: 'tests/core/retrieval-services.test.ts', note: 'Core retrieval service behavior.' },
      { kind: 'test', ref: 'tests/apps/cli-disclosure-output.test.ts', note: 'CLI disclosure output formatting.' },
      { kind: 'source', ref: 'src/apps/cli/index.ts', note: 'search command supports disclosure, scope, and strategy flags.' }
    ]
  },
  {
    id: 'claude.adapter.disclosure',
    area: 'claude',
    title: 'Claude adapter disclosure',
    status: 'covered',
    requirements: [
      'Support progressive search -> expand -> source disclosure flow.',
      'Render source/citation evidence for retrieved memories.'
    ],
    evidence: [
      { kind: 'test', ref: 'tests/core/retrieval-disclosure-service.test.ts', note: 'Disclosure service search/expand/source flow.' },
      { kind: 'test', ref: 'tests/apps/ui-disclosure-output.test.ts', note: 'Dashboard disclosure formatting.' },
      { kind: 'source', ref: 'src/core/engine/retrieval-disclosure-service.ts', note: 'Core disclosure orchestration.' }
    ]
  },
  {
    id: 'codex.adapter.scan',
    area: 'codex',
    title: 'Codex adapter scan',
    status: 'ready',
    requirements: [
      'Read ~/.codex/sessions recursively without writes by default.',
      'Match sessions to a project via session_meta.payload.cwd when available and summarize all sessions otherwise.',
      'Count missing cwd, malformed JSONL lines, and unsupported/tool-ish records.'
    ],
    evidence: [
      { kind: 'test', ref: 'tests/core/codex-session-history-importer-validation.test.ts', note: 'Dry-run scan, cwd matching, missing cwd, malformed and unsupported counts.' },
      { kind: 'source', ref: 'src/services/codex-session-history-importer.ts', note: 'validateCodexSessions and normalizeCodexSessionFile.' }
    ]
  },
  {
    id: 'codex.adapter.import',
    area: 'codex',
    title: 'Codex adapter import',
    status: 'covered',
    requirements: [
      'Import explicit Codex session files/project sessions into memory only through import APIs.',
      'Expose a user-facing codex import command for project, session, and all-session imports.',
      'Preserve turn grouping and truncate oversized assistant content before storage.'
    ],
    evidence: [
      { kind: 'test', ref: 'tests/apps/codex-import-runner.test.ts', note: 'Asserts project-scoped, session, and explicit global all-session import routing.' },
      { kind: 'source', ref: 'src/apps/cli/codex-import-runner.ts', note: 'Safe Codex import command runner with project/default/global storage decisions.' },
      { kind: 'source', ref: 'src/services/codex-session-history-importer.ts', note: 'CodexSessionHistoryImporter importProject/importAll/importSessionFile.' },
      { kind: 'doc', ref: 'docs/PRODUCT_VALIDATION_MATRIX.md', note: 'Documents that validation/replay is read-only; mutation remains explicit import-only.' }
    ]
  },
  {
    id: 'codex.adapter.replay',
    area: 'codex',
    title: 'Codex adapter replay',
    status: 'ready',
    requirements: [
      'Normalize response_item message records with user/assistant roles and text/input_text/output_text blocks.',
      'Handle string content, empty assistant turns, large/truncated content, malformed lines, and tool-ish records robustly.',
      'Emit aggregate replay counts without transcript content.'
    ],
    evidence: [
      { kind: 'test', ref: 'tests/core/codex-session-history-importer-validation.test.ts', note: 'Realistic fixture replay covers supported and malformed Codex JSONL shapes.' },
      { kind: 'source', ref: 'src/services/codex-session-history-importer.ts', note: 'normalizeCodexSessionFile parses and counts replay records.' }
    ]
  },
  {
    id: 'hermes.adapter.scan',
    area: 'hermes',
    title: 'Hermes adapter scan',
    status: 'ready',
    requirements: [
      'Read Hermes ~/.hermes/state.db in read-only mode by default.',
      'Match sessions to a project via Hermes session context/title when available.',
      'Count unsupported/tool messages, empty assistant messages, missing project context, and truncated content without exposing transcript text.'
    ],
    evidence: [
      { kind: 'test', ref: 'tests/core/hermes-session-history-importer-validation.test.ts', note: 'Dry-run SessionDB fixture covers project matching, unsupported/tool skipping, empty assistant messages, and transcript exclusion.' },
      { kind: 'source', ref: 'src/services/hermes-session-history-importer.ts', note: 'validateHermesSessions reads SessionDB and emits aggregate replay reports.' }
    ]
  },
  {
    id: 'hermes.adapter.import',
    area: 'hermes',
    title: 'Hermes adapter import',
    status: 'covered',
    requirements: [
      'Import explicit Hermes SessionDB project/session/all selections into memory only through import APIs.',
      'Default to project-scoped memory for current-project imports and require --all for intentional global imports.',
      'Skip tool/system records and redact sensitive user/assistant content before storage.'
    ],
    evidence: [
      { kind: 'test', ref: 'tests/core/hermes-session-history-importer-validation.test.ts', note: 'Imports only matched user/assistant turns, redacts secrets, and skips tool messages.' },
      { kind: 'test', ref: 'tests/apps/hermes-import-runner.test.ts', note: 'Asserts project-scoped, session, and explicit global all-session import routing.' },
      { kind: 'source', ref: 'src/apps/cli/hermes-import-runner.ts', note: 'Safe Hermes import command runner with project/default/global storage decisions.' },
      { kind: 'source', ref: 'src/services/hermes-session-history-importer.ts', note: 'HermesSessionHistoryImporter importProject/importAll/importSession.' }
    ]
  },
  {
    id: 'hermes.adapter.replay',
    area: 'hermes',
    title: 'Hermes adapter replay',
    status: 'ready',
    requirements: [
      'Normalize Hermes SessionDB user/assistant rows into aggregate replay counts.',
      'Keep Hermes raw transcript source-of-truth in SessionDB and treat CML as explicit derived memory.',
      'Emit validation reports without transcript content or secrets.'
    ],
    evidence: [
      { kind: 'test', ref: 'tests/core/hermes-session-history-importer-validation.test.ts', note: 'Validation report excludes prompt/response text and synthetic secrets.' },
      { kind: 'source', ref: 'src/apps/cli/hermes-validation-output.ts', note: 'JSON/Markdown report output helpers for Hermes aggregate replay.' },
      { kind: 'doc', ref: 'docs/HERMES_MEMORY_INGESTION_ANALYSIS.md', note: 'Documents explicit import first; live sync later if needed.' }
    ]
  },
  {
    id: 'mcp.context.pack',
    area: 'mcp',
    title: 'MCP context pack',
    status: 'covered',
    requirements: [
      'Expose an agent-ready project context pack that combines relevant retrieval results with recent project timeline.',
      'Support projectPath scoping so Hermes, Codex, and Claude Code can share the same project memory backend.',
      'Keep output compact and citation-oriented so agents can follow up with source-ref or timeline tools.'
    ],
    evidence: [
      { kind: 'test', ref: 'tests/extensions/mcp-context-tools.test.ts', note: 'Asserts context-pack output, projectPath routing, compact relevant memory citations, and recent timeline inclusion.' },
      { kind: 'source', ref: 'src/extensions/mcp/handlers.ts', note: 'mem-context-pack handler formats relevant memories plus session summaries.' },
      { kind: 'source', ref: 'src/extensions/mcp/tools.ts', note: 'MCP tool schema advertises projectPath, topK, recentLimit, and sessionLimit options.' }
    ]
  },
  {
    id: 'mcp.project.timeline',
    area: 'mcp',
    title: 'MCP project timeline',
    status: 'covered',
    requirements: [
      'Summarize recent project memories by session, source agent, event counts, and last safe preview.',
      'Avoid raw transcript dumps while still giving enough continuity for another agent to resume work.'
    ],
    evidence: [
      { kind: 'test', ref: 'tests/extensions/mcp-context-tools.test.ts', note: 'Asserts session grouping, source-agent metadata, and event type counts.' },
      { kind: 'source', ref: 'src/extensions/mcp/handlers.ts', note: 'mem-project-timeline groups recent events by session and source.' },
      { kind: 'source', ref: 'src/extensions/mcp/tools.ts', note: 'MCP tool schema advertises limit/sessionLimit/projectPath options.' }
    ]
  },
  {
    id: 'mcp.source.ref',
    area: 'mcp',
    title: 'MCP source reference',
    status: 'covered',
    requirements: [
      'Resolve event IDs, event: references, and mem citation IDs into source references.',
      'Return privacy-safe redacted previews and a narrow allowlist of metadata instead of raw transcript content.',
      'Support projectPath scoping for project-specific memory stores.'
    ],
    evidence: [
      { kind: 'test', ref: 'tests/extensions/mcp-context-tools.test.ts', note: 'Asserts citation lookup, secret redaction, and safe metadata allowlist.' },
      { kind: 'source', ref: 'src/extensions/mcp/handlers.ts', note: 'mem-source-ref applies privacy filtering and safe metadata selection.' },
      { kind: 'source', ref: 'src/core/privacy/filter.ts', note: 'Shared privacy filter masks sensitive patterns before output.' }
    ]
  },
  {
    id: 'cli.api.reporting',
    area: 'cli',
    title: 'CLI / API / reporting',
    status: 'ready',
    requirements: [
      'Expose user-facing Codex validation commands with --project, --sessions-dir, --limit, --format, --output, and --dry-run options.',
      'Expose user-facing Hermes validation commands with --project, --state-db, --limit, --format, --output, and --dry-run options.',
      'Expose explicit Codex and Hermes import commands with project, session, all-session, limit, force, and no-process-embeddings options.',
      'Render JSON and Markdown reports with totals, warnings, top projects/sources, and source paths.'
    ],
    evidence: [
      { kind: 'test', ref: 'tests/apps/codex-validation-output.test.ts', note: 'Codex JSON/Markdown report formatting.' },
      { kind: 'test', ref: 'tests/apps/codex-import-runner.test.ts', note: 'Codex import CLI runner behavior and storage-scope routing.' },
      { kind: 'test', ref: 'tests/apps/hermes-import-runner.test.ts', note: 'Hermes import CLI runner behavior and storage-scope routing.' },
      { kind: 'source', ref: 'src/apps/cli/index.ts', note: 'codex and hermes validate/replay/import commands.' },
      { kind: 'source', ref: 'src/apps/cli/codex-validation-output.ts', note: 'Codex report output helpers.' },
      { kind: 'source', ref: 'src/apps/cli/hermes-validation-output.ts', note: 'Hermes report output helpers.' },
      { kind: 'source', ref: 'src/apps/cli/codex-import-runner.ts', note: 'Codex import runner.' },
      { kind: 'source', ref: 'src/apps/cli/hermes-import-runner.ts', note: 'Hermes import runner.' }
    ]
  },
  {
    id: 'safety.dryRun',
    area: 'safety',
    title: 'Safety / dry-run',
    status: 'ready',
    requirements: [
      'Codex validation/replay is read-only by default and never initializes memory storage or changes Claude settings.',
      'Reports exclude transcript content and can anonymize project paths for real-data validation artifacts.'
    ],
    evidence: [
      { kind: 'test', ref: 'tests/core/codex-session-history-importer-validation.test.ts', note: 'Asserts dryRun=true, willMutate=false, and no transcript content in reports.' },
      { kind: 'command', ref: 'claude-memory-layer codex validate --dry-run', note: 'User-facing dry-run validation command.' },
      { kind: 'doc', ref: 'docs/PRODUCT_VALIDATION_MATRIX.md', note: 'Documents safety expectations and read-only validation scope.' }
    ]
  }
];

function emptyAreaCounts(): Record<ProductValidationArea, number> {
  return { claude: 0, codex: 0, hermes: 0, mcp: 0, cli: 0, safety: 0 };
}

function emptyStatusCounts(): Record<ProductValidationStatus, number> {
  return { ready: 0, covered: 0, partial: 0, planned: 0 };
}

export function getProductValidationMatrixSummary(
  matrix: readonly ProductValidationSurface[] = productValidationMatrix
): ProductValidationMatrixSummary {
  const summary: ProductValidationMatrixSummary = {
    totalSurfaces: matrix.length,
    requirementCount: 0,
    evidenceCount: 0,
    surfacesByArea: emptyAreaCounts(),
    statusCounts: emptyStatusCounts()
  };

  for (const surface of matrix) {
    summary.surfacesByArea[surface.area] += 1;
    summary.statusCounts[surface.status] += 1;
    summary.requirementCount += surface.requirements.length;
    summary.evidenceCount += surface.evidence.length;
  }

  return summary;
}

export function renderProductValidationMatrixMarkdown(
  matrix: readonly ProductValidationSurface[] = productValidationMatrix
): string {
  const summary = getProductValidationMatrixSummary(matrix);
  const lines: string[] = [
    '# Product Validation Matrix',
    '',
    `Surfaces: ${summary.totalSurfaces}`,
    `Requirements: ${summary.requirementCount}`,
    `Evidence items: ${summary.evidenceCount}`,
    '',
    '| Area | Surface | Status | Requirements | Evidence |',
    '| --- | --- | --- | --- | --- |'
  ];

  for (const surface of matrix) {
    const requirements = surface.requirements.map((requirement) => requirement.replace(/\|/g, '\\|')).join('<br>');
    const evidence = surface.evidence
      .map((item) => `${item.kind}: ${item.ref}`.replace(/\|/g, '\\|'))
      .join('<br>');
    lines.push(`| ${surface.area} | ${surface.title} | ${surface.status} | ${requirements} | ${evidence} |`);
  }

  return `${lines.join('\n')}\n`;
}
