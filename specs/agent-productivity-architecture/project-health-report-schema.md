# Project Health Report Schema — Agent Productivity Architecture

> **Status**: Draft contract for Phase 0 → field-readiness → Phase 2 implementation
> **Spec**: `specs/agent-productivity-architecture/spec.md` v1.0.2
> **Baseline values last revalidated**: 2026-07-14
> **Primary principle**: CLI/API first, dashboard second. Dashboard v2 must render this report; it must not duplicate memory selection or business logic.

## 1. Purpose

`Project Health Report` is the safe, aggregate, actionable output that tells an agent or human:

1. what the project is ready to continue,
2. whether memory quality is trustworthy enough to inject,
3. whether import/vector/outbox pipelines are healthy,
4. what risks should block automatic context injection or team export,
5. which maintenance actions are recommended next.

It is the product-facing replacement for ad hoc dashboard-only diagnostics. The same service should power:

- `claude-memory-layer health --productivity`
- `claude-memory-layer health --productivity --json`
- read-only API: `GET /api/health/productivity?project=<project-id-or-current>`
- Dashboard v2 cards and drill-downs

### 1.1 Implementation scope note

This document intentionally separates the **Phase 0 MVP contract** from the richer
**Phase 2 target contract**:

- **Phase 0 MVP, implemented in the current slice**: aggregate storage/outbox
  signals, project/profile/mode validation, three initial risk gates, safe next
  action text, and public-output privacy guarantees. This is the contract locked
  by `productivity-health-{cli,api}.test.ts`.
- **Phase 2 target, not yet fully implemented**: frontier, memory quality,
  Project Brief readiness, richer pipeline health, evidence, redaction summary,
  and dashboard card mapping. These fields are product direction and acceptance
  criteria for later phases, not missing Phase 0 implementation.
- **Field-readiness additive slice, partially implemented**: graduation worker
  liveness (`attempts`, last attempt/success/status/error category) and
  graduated/curated source readiness are now included. Canonical repo alias
  count, installed/hook version skew, consolidation, injection
  abstention/score buckets, and direct-label coverage remain future additions.

The schema version remains `agent-productivity-health-v1` across the MVP and
target shape. Additive fields are allowed; incompatible removals or semantic
changes require a new schema version.

## 2. Non-negotiable Output Rules

The report is safe-by-default.

MUST NOT include:

- raw prompt text
- raw retrieval query text
- raw memory body text
- raw tool observation payload
- local absolute filesystem paths
- transcript DB paths or session-storage paths
- credential-looking values
- authorization headers
- private actor perspective content in team/export surfaces

MAY include:

- relative repo paths when they are already part of the repository
- stable source reference IDs (`event:<id>`, `mem:<id>`, `action:<id>`) after redaction
- aggregate counts, statuses, timestamps, score buckets, and category labels
- redacted previews capped by policy only in local/private CLI views, never in public dashboard/export views by default

If sanitization finds a forbidden class, the report must fail closed:

```json
{
  "status": "blocked",
  "blockingReasons": ["privacy_leak_detected"],
  "redactionSummary": {
    "blockedClasses": ["local_path"],
    "blockedCount": 1
  }
}
```

The blocked payload must not echo the matched value.

## 3. CLI Contract

### 3.1 Human-readable command — Phase 2 target

Phase 0 intentionally supports JSON only. Invoking productivity health without
`--json` should fail with a clear remediation instead of creating a second,
divergent renderer before the schema stabilizes. The target human-readable
command is:
```bash
claude-memory-layer health --productivity [--project <project-id-or-path>] [--profile coder|reviewer|pm|support|researcher|team] [--mode observe|preview|enforce]
```

Required sections:

1. `Overall Status`
2. `Current Frontier`
3. `Memory Quality`
4. `Agent Readiness`
5. `Pipeline Health`
6. `Risk Gates`
7. `Suggested Maintenance`

The eventual human-readable output should be concise and should point to source
refs, not raw transcript content.

### 3.2 JSON command

```bash
claude-memory-layer health --productivity --json [--project <project-id-or-path>] [--profile coder|reviewer|pm|support|researcher|team] [--mode observe|preview|enforce]
```

The JSON command currently returns the Phase 0 MVP subset in §5.1. Later phases
should extend it toward the target shape in §5.2 without breaking existing MVP
fields.

## 4. API Contract

```http
GET /api/health/productivity?project=<project-id-or-current>&profile=coder&mode=preview
```

Response constraints:

- read-only
- no side effects
- default mode is `preview` or `observe`, never `enforce`
- p95 target: ≤3s on a typical project DB
- response is already sanitized; dashboard does not need to reimplement sanitization, only render safely

Phase 0 status codes are intentionally simple: `200` for generated reports,
`400` for invalid profile/mode, and `500` for sanitized operational failures.
Target status codes for later phases:

| Code | Meaning |
|---:|---|
| 200 | report generated |
| 400 | invalid profile/mode/project identifier |
| 404 | project not found or not initialized |
| 409 | report blocked by safety/privacy gate |
| 503 | storage/vector/outbox health unavailable |

## 5. JSON Schema Shape

### 5.1 Phase 0 MVP JSON Schema — implemented

This is the minimal CLI/API contract that Phase 0 currently implements and tests.
It is deliberately aggregate-only and safe-by-default.

```ts
type MvpHealthStatus = 'ok' | 'needs-attention';
type InjectionMode = 'observe' | 'preview' | 'enforce';
type AgentProfile = 'coder' | 'reviewer' | 'pm' | 'support' | 'researcher' | 'team';
type MvpRiskGateStatus = 'pass' | 'warn';

interface OutboxQueueStats {
  pending: number;
  processing: number;
  failed: number;
  retryableFailed: number;
  quarantinedFailed: number;
  total: number;
  stuckProcessing: number;
  oldestProcessingAgeMs: number | null;
}

interface ProductivityHealthReportMvp {
  schemaVersion: 'agent-productivity-health-v1';
  generatedAt: string; // ISO timestamp
  status: MvpHealthStatus;
  profile: AgentProfile;
  mode: InjectionMode;
  project: {
    scope: 'project' | 'global';
    id: string; // project hash or 'global'; never a local absolute path
  };
  summary: {
    warningReasons: string[];
  };
  signals: {
    storage: {
      totalEvents: number;
      vectorCount: number;
      levelStats: Array<{ level: string; count: number }>;
    };
    outbox: {
      embedding: OutboxQueueStats;
      vector: OutboxQueueStats;
      totals: OutboxQueueStats;
    };
  };
  riskGates: Array<{
    id: 'project-scope-known' | 'outbox-healthy' | 'memory-density';
    severity: 'blocker' | 'warning';
    status: MvpRiskGateStatus;
    message?: string;
  }>;
  nextBestAction: string;
}
```

### 5.2 Phase 2 target JSON Schema — planned additive expansion

This is a TypeScript-oriented target schema sketch. Implementation can use Zod
or equivalent runtime validation. Fields in this section are planned additive
expansions unless they already appear in the MVP schema above.

```ts
type HealthStatus = 'healthy' | 'degraded' | 'blocked' | 'unknown';
type InjectionMode = 'observe' | 'preview' | 'enforce';
type AgentProfile = 'coder' | 'reviewer' | 'pm' | 'support' | 'researcher' | 'team';
type Severity = 'info' | 'warning' | 'error' | 'blocker';

interface ProjectHealthReport {
  schemaVersion: 'agent-productivity-health-v1';
  generatedAt: string; // ISO timestamp
  project: {
    id: string;
    displayName?: string;
    repoIdentity?: string; // normalized/redacted, never local absolute path
    aliasCount?: number; // physical stores/legacy hashes represented by the canonical identity
    identityStatus?: 'canonical' | 'path-fallback' | 'ambiguous' | 'unknown';
    sourceScope: 'project' | 'workspace' | 'team' | 'unknown';
  };
  requestedProfile: AgentProfile;
  requestedMode: InjectionMode;
  status: HealthStatus;
  summary: {
    headline: string;
    blockingReasons: string[];
    warningReasons: string[];
    nextBestAction?: string;
  };
  currentFrontier: FrontierSummary;
  memoryQuality: MemoryQualitySummary;
  agentReadiness: AgentReadinessSummary;
  pipelineHealth: PipelineHealthSummary;
  riskGates: RiskGateSummary[];
  suggestedMaintenance: MaintenanceSuggestion[];
  redactionSummary: RedactionSummary;
  evidence: EvidenceSummary;
}

interface FrontierSummary {
  pendingActions: number;
  inProgressActions: number;
  blockedActions: number;
  staleCompletedActionsSurfaced: number;
  checkpoints: number;
  topSafeRefs: SafeRef[];
}

interface MemoryQualitySummary {
  replayGate?: {
    lastRunAt?: string;
    failedQueries: number;
    forbiddenHits: number;
    noMatchAccuracy?: number;
    queryYieldRate?: number;
    sourceReportRef?: string;
  };
  retrievalTraces: {
    totalRecentTraces: number;
    selectedRate?: number;
    injectionRate?: number;
    abstentionRate?: number;
    injectionWasteRate?: number;
    scoreBuckets?: Record<string, number>;
    directLabelCoverage?: number;
    harmfulLabelCount?: number;
    legacyHelpfulnessProxy?: {
      average?: number;
      ceilingWarning: boolean;
    };
    lowConfidenceTraceCount: number;
    emptyCandidateCount: number;
  };
  longMemorySmoke?: {
    datasetLabel: string;
    recallAnyAt10?: number;
    recallAllAt10?: number;
    fractionalRecallAt10?: number;
    ndcgAt10?: number;
    mrr?: number;
    sourceReportRef?: string;
  };
}

interface AgentReadinessSummary {
  brief: {
    exists: boolean;
    tokenEstimate?: number;
    stale: boolean;
    sourceRefs: SafeRef[];
  };
  injection: {
    mode: InjectionMode;
    enforceEligible: boolean;
    tokenBudget: {
      sessionStartMax: number;
      userPromptSubmitMax: number;
      estimatedCurrent: number;
    };
    blockedBy: string[];
  };
  profilePolicy: {
    profile: AgentProfile;
    allowedMemoryTypes: string[];
    excludedMemoryTypes: string[];
    freshnessWindowMinutes?: number;
    privacyBudget: 'local' | 'project' | 'team-safe';
  };
}

interface PipelineHealthSummary {
  sqlite: ComponentHealth;
  runtime?: { // required by the field-readiness slice; optional for legacy v1 payloads
    installedVersion?: string;
    hookTargetVersion?: string;
    versionSkew: boolean | 'unknown';
    daemon: ComponentHealth;
  };
  derivation?: { // required by the field-readiness slice; optional for legacy v1 payloads
    l0Count?: number;
    derivedCount?: number;
    graduation: WorkerHealth;
    consolidation: WorkerHealth;
    briefSourceReady: boolean;
    blockedReasons: string[];
  };
  vectorOutbox: ComponentHealth & {
    pendingRows?: number;
    failedRows?: number;
    lastDrainAt?: string;
  };
  imports: {
    claude?: SourceHealth;
    codex?: SourceHealth;
    hermes?: SourceHealth;
  };
  sync?: ComponentHealth & {
    mode: 'disabled' | 'local' | 'team';
    lastPullAt?: string;
    lastPushAt?: string;
  };
}

interface ComponentHealth {
  status: HealthStatus;
  message?: string;
}

interface SourceHealth {
  status: HealthStatus;
  lastImportedAt?: string;
  freshnessMinutes?: number;
  importedSessionsRecent?: number;
  blockedReasons: string[];
}

interface WorkerHealth extends ComponentHealth {
  enabled?: boolean;
  running?: boolean;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastResult?: 'success' | 'not_eligible' | 'failed' | 'never_run';
  lastErrorCategory?: string; // category only; never raw error content/path
}

interface RiskGateSummary {
  id: string;
  severity: Severity;
  passed: boolean;
  title: string;
  safeDetails?: string;
  remediation?: string;
}

interface MaintenanceSuggestion {
  id: string;
  priority: 'p0' | 'p1' | 'p2';
  title: string;
  reason: string;
  command?: string; // safe command only, no secrets or local absolute paths
  expectedImpact?: string;
}

interface RedactionSummary {
  policyVersion: string;
  blockedClasses: string[];
  blockedCount: number;
  redactedCount: number;
  publicOutputSafe: boolean;
}

interface EvidenceSummary {
  reportRefs: SafeRef[];
  generatedFrom: string[]; // e.g. ['sqlite', 'retrieval_traces', 'memory_actions']; no file paths
}

interface SafeRef {
  id: string;
  kind: 'memory' | 'event' | 'action' | 'lesson' | 'checkpoint' | 'report' | 'trace';
  label?: string;
}
```

## 6. Phase 2 Target Example JSON Response

The following example describes the richer target shape. It is **not** the exact
Phase 0 MVP payload; use §5.1 and the CLI/API tests as the current contract.

```json
{
  "schemaVersion": "agent-productivity-health-v1",
  "generatedAt": "2026-07-07T13:07:08Z",
  "project": {
    "id": "project_abc123",
    "displayName": "claude-memory-layer",
    "repoIdentity": "github:owner/repo",
    "sourceScope": "project"
  },
  "requestedProfile": "coder",
  "requestedMode": "preview",
  "status": "degraded",
  "summary": {
    "headline": "Phase 0 health MVP is available; Project Brief, frontier, and replay gates still need Phase 2 expansion before dashboard rendering.",
    "blockingReasons": [],
    "warningReasons": ["project_brief_missing", "full_frontier_not_integrated"],
    "nextBestAction": "Extend the health report with Project Brief, frontier, replay evidence, and redaction summaries before dashboard rendering."
  },
  "currentFrontier": {
    "pendingActions": 3,
    "inProgressActions": 1,
    "blockedActions": 0,
    "staleCompletedActionsSurfaced": 0,
    "checkpoints": 1,
    "topSafeRefs": [{ "id": "action:next", "kind": "action", "label": "safe next action" }]
  },
  "memoryQuality": {
    "replayGate": {
      "failedQueries": 0,
      "forbiddenHits": 0,
      "noMatchAccuracy": 1,
      "queryYieldRate": 1,
      "sourceReportRef": "report:phase-0-baseline"
    },
    "retrievalTraces": {
      "totalRecentTraces": 0,
      "lowConfidenceTraceCount": 0,
      "emptyCandidateCount": 0
    },
    "longMemorySmoke": {
      "datasetLabel": "LongMemEval_S cleaned retrieval-only smoke",
      "recallAnyAt10": 0.8809,
      "recallAllAt10": 0.7404,
      "fractionalRecallAt10": 0.816,
      "ndcgAt10": 0.749,
      "mrr": 0.771,
      "sourceReportRef": "report:phase-0-baseline"
    }
  },
  "agentReadiness": {
    "brief": {
      "exists": false,
      "stale": false,
      "sourceRefs": []
    },
    "injection": {
      "mode": "preview",
      "enforceEligible": false,
      "tokenBudget": {
        "sessionStartMax": 1500,
        "userPromptSubmitMax": 800,
        "estimatedCurrent": 0
      },
      "blockedBy": ["project_brief_missing", "enforce_gate_not_validated"]
    },
    "profilePolicy": {
      "profile": "coder",
      "allowedMemoryTypes": ["brief", "decision", "frontier", "lesson", "checkpoint"],
      "excludedMemoryTypes": ["raw_event", "raw_tool_observation", "private_actor_perspective"],
      "freshnessWindowMinutes": 10080,
      "privacyBudget": "project"
    }
  },
  "pipelineHealth": {
    "sqlite": { "status": "healthy" },
    "vectorOutbox": { "status": "unknown" },
    "imports": {
      "claude": { "status": "unknown", "blockedReasons": [] },
      "codex": { "status": "unknown", "blockedReasons": [] },
      "hermes": { "status": "unknown", "blockedReasons": [] }
    },
    "sync": { "status": "unknown", "mode": "disabled" }
  },
  "riskGates": [
    {
      "id": "privacy-public-output",
      "severity": "blocker",
      "passed": true,
      "title": "Public output contains no raw local paths, credential-looking values, or raw transcript/query text."
    },
    {
      "id": "replay-forbidden-hits",
      "severity": "blocker",
      "passed": true,
      "title": "Golden replay forbidden hit count is zero."
    }
  ],
  "suggestedMaintenance": [
    {
      "id": "fix-longmemeval-script-input",
      "priority": "p1",
      "title": "Make LongMemEval retrieval smoke one-command reproducible.",
      "reason": "The current npm script fails without an explicit input path.",
      "command": "npm run eval:longmemeval:retrieval-smoke -- --input <dataset-json>",
      "expectedImpact": "Turns the retrieval smoke from a manual baseline into a reusable gate."
    }
  ],
  "redactionSummary": {
    "policyVersion": "phase-0-draft",
    "blockedClasses": [],
    "blockedCount": 0,
    "redactedCount": 0,
    "publicOutputSafe": true
  },
  "evidence": {
    "reportRefs": [{ "id": "report:phase-0-baseline", "kind": "report", "label": "Phase 0 baseline" }],
    "generatedFrom": ["sqlite", "retrieval_traces", "memory_actions", "benchmark_reports"]
  }
}
```

## 7. Risk Gates

Phase 0 MVP gates:

| Gate ID | Severity | Pass condition | Blocks enforce injection? | Blocks team export? |
|---|---|---|---:|---:|
| `project-scope-known` | blocker | project scope is not global/ambiguous | yes | yes |
| `outbox-healthy` | warning | no failed or stuck outbox rows | no | no |
| `memory-density` | warning | at least one event exists for the selected scope | no | no |

Phase 2 target gates:

| Gate ID | Severity | Pass condition | Blocks enforce injection? | Blocks team export? |
|---|---|---|---:|---:|
| `privacy-public-output` | blocker | zero forbidden output classes | yes | yes |
| `project-scope-known` | blocker | project identity is unambiguous | yes | yes |
| `replay-forbidden-hits` | blocker | forbidden hits = 0 | yes | yes |
| `replay-no-match-accuracy` | blocker | no-match accuracy = 1 for trap cases | yes | no |
| `brief-token-budget` | error | Project Brief ≤1,500 tokens | yes | no |
| `turn-token-budget` | error | turn injection ≤800 tokens | yes | no |
| `stale-action-suppression` | blocker | completed/cancelled actions do not appear as next action | yes | no |
| `vector-outbox-health` | warning/error | failed rows below threshold | no | no |
| `source-freshness` | warning/error | configured source freshness within threshold | no | no |
| `private-tags-export` | blocker | private-tagged artifacts excluded | no | yes |
| `project-identity-canonical` | blocker | repo identity is canonical and unambiguous | yes | yes |
| `derivation-pipeline-observed` | blocker | eligible input has an explicit worker result; not `never_run` | yes | no |
| `brief-source-ready` | blocker | L1+/operations or approved safe fallback source exists | yes | no |
| `injection-direct-evidence` | blocker | direct-label/replay coverage is sufficient and harmful labels are zero | yes | no |

## 8. Dashboard Mapping

Dashboard v2 should map report fields directly:

| Dashboard card | Schema source | Rule |
|---|---|---|
| Overall status | `status`, `summary` | render only |
| Continue next | `currentFrontier.topSafeRefs`, `summary.nextBestAction` | no custom selection logic |
| Memory quality | `memoryQuality.replayGate`, `memoryQuality.retrievalTraces` | aggregate only |
| Agent readiness | `agentReadiness` | show mode/profile gates |
| Pipeline health | `pipelineHealth` | show component status |
| Risk gates | `riskGates` | blocker/warning list |
| Maintenance | `suggestedMaintenance` | safe commands only |
| Redaction | `redactionSummary` | show counts/classes, never matched values |

Dashboard tests must verify that UI payloads do not include raw prompt/query/memory text or local absolute paths.

## 9. Implementation Order

Phase 0 MVP, implemented in the current slice:

1. Implement `buildProductivityHealthReport({ stats, outbox, project, profile, mode })` in a core layer.
2. Implement CLI JSON output first.
3. Add read-only API endpoint backed by the lightweight service.
4. Add smoke tests for project-path redaction, invalid profile validation, aggregate-only API output, warning gates, and sanitized error output.

Phase 2+ follow-up:

5. Add runtime schema validation for the richer target `ProjectHealthReport`.
6. Add replay/frontier/Project Brief/evidence/redaction fields as additive schema expansions.
7. Add field-readiness runtime/derivation/identity/injection evidence fields before Brief or enforce rollout.
8. Render in dashboard as a thin client only after CLI/API pilot use.
9. Only after the report is stable, add richer drill-down endpoints.

## 10. Acceptance Criteria

Phase 0 MVP acceptance criteria:

- `claude-memory-layer health --productivity --json` emits schemaVersion `agent-productivity-health-v1`.
- CLI output does not include the raw `--project` absolute path.
- API output uses the lightweight read service and never initializes the full/writable service.
- Invalid profile/mode input fails before exposing raw project path or raw operational errors.
- Public JSON output includes only aggregate storage/outbox counts, risk-gate metadata, warning reasons, and safe next-action text.

Phase 2+ target acceptance criteria:

- CLI and API outputs are byte-for-byte equivalent after stable fields are normalized.
- No public output includes raw local path, raw query, raw prompt, raw memory body, or credential-looking values.
- Dashboard renders the report without independently querying or selecting memories.
- Risk gates can block `enforce` injection and team export separately.
- Report generation p95 target is ≤3s for a typical project DB.
