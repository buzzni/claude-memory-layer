# Memory Operational Quality Roadmap Specification

> **Version**: 0.1.1
> **Status**: Draft
> **Created**: 2026-08-12
> **Baseline**: `v2.2.10`

## 1. Goal

Improve the shipped memory layer without expanding its product scope. The result should have:

1. side-effect-free read operations,
2. explicit, verified recovery for derived layers,
3. presentation-aware usefulness telemetry,
4. representative retrieval regression benchmarks,
5. a smaller selectable MCP surface,
6. measured and bounded model/runtime resource usage,
7. stronger core/adapter/extension boundaries.

## 2. Non-goals

- Replacing SQLite as canonical storage.
- Rewriting all retrieval code in one change.
- Automatically deleting empty/tiny stores.
- Automatically rebuilding corrupted vectors during maintenance.
- Automatically retrying quarantined work forever.
- Shipping a shared embedding broker without evidence.
- Adding full code graph, full autonomous learning, mesh, or new remote API products.
- Removing advanced MCP tools without a compatibility period.

## 3. Global invariants

### INV-001 — Canonical data safety

Raw events and governed SQLite records must not be deleted, rewritten, or inferred away by GC or derived-layer repair.

### INV-002 — Read means no write

A command/API advertised as status, stats, audit, list, preview, health, or dry-run must not:

- create a project directory,
- create an SQLite file,
- run a schema migration,
- create a Lance table,
- enqueue an outbox job,
- change registry state,
- update access/helpfulness telemetry unless the endpoint explicitly documents that mutation.

### INV-003 — Dry-run first

Cleanup and rebuild operations default to dry-run. Mutation requires explicit `--apply` or an equivalent audited API option. Project GC apply stages data into recoverable quarantine with a restore manifest; irreversible purge is a separate operation with an explicit retention policy.

### INV-004 — Derived layers are replaceable

Vectors and other declared projections are built from canonical inputs into a separate location, verified, and atomically activated. Failed verification leaves the current active layer untouched.

### INV-005 — Privacy-safe output

Operational output contains aggregate counts, opaque ids, categories, and bounded redacted previews only. It must not expose raw transcript text, credentials, or private source paths.

### INV-006 — Backward compatibility

Existing public CLI/MCP behavior remains compatible unless a release explicitly introduces a migration period. MCP `all` must initially preserve the shipped tool list.

## 4. Workstream A — Existing-store read paths

### RO-001 — Existing-store resolver

Provide a resolver that accepts a project path or supported project hash and returns one of:

- existing readable store,
- missing store,
- invalid project argument,
- unreadable/corrupt store.

The resolver must not create directories or initialize/migrate storage.

### RO-002 — Read-only service composition

Stats, health, vector status, project audit, dashboard reads, and other read surfaces must use a read-only service/store that does not cache or own background workers.

### RO-003 — Filesystem invariance test helper

Add a reusable test helper that snapshots a temporary memory root before and after a read command and asserts no filesystem or database change.

### RO-004 — Empty/tiny-store GC

Add a project GC workflow with:

- dry-run default,
- exact target enumeration,
- registry-reference check,
- active lock/process check,
- symlink rejection,
- minimum age,
- canonical row/outbox/governance checks,
- aggregate reclaimable-byte report,
- explicit apply that moves exact candidates to quarantine,
- durable restore manifest and restore command,
- separately authorized purge after a retention interval.

Empty and tiny stores must be separate categories. Tiny stores are not automatically disposable.

### RO-005 — Maintenance discovery

Maintenance should distinguish existing meaningful stores from empty skeletons and report both counts without migrating empty stores during inspection.

## 5. Workstream B — Derived-layer audit and rebuild

### DL-001 — Descriptor contract

Introduce a typed descriptor concept with at least:

```ts
interface DerivedLayerDescriptor {
  name: string;
  version: string;
  inputs: readonly string[];
  outputs: readonly string[];
  audit(context: LayerContext): Promise<LayerAuditReport>;
  rebuild(context: LayerRebuildContext): Promise<LayerRebuildResult>;
  verify(context: LayerVerificationContext): Promise<LayerVerification>;
}
```

The exact API may change, but audit, rebuild, verification, version, and declared inputs/outputs are required concepts.

### DL-002 — Layer audit CLI

Provide privacy-safe commands equivalent to:

```bash
claude-memory-layer layer audit -p <project> [--json]
```

Reports should identify missing, stale, corrupt, version-mismatched, quarantined, and healthy states without mutation.

### DL-003 — Vector rebuild

Provide a vector rebuild command with:

- project lock,
- disk preflight,
- explicit embedding version,
- temporary output location,
- deterministic input selection,
- bounded progress reporting,
- count and sampled-query verification,
- atomic activation,
- rollback preservation,
- cleanup only after success.

### DL-004 — Quarantine graduation

Quarantined jobs are only retired/unquarantined when the replacement layer has been verified to contain the corresponding canonical inputs or when an explicit audited policy says those inputs are intentionally non-vectorized.

### DL-005 — Health remediation

Health must distinguish:

- pending/retryable backlog,
- stuck processing,
- quarantined-only failure,
- derived-layer corruption,
- disk-pressure block,
- healthy state.

Each state must recommend the correct next command. A quarantined-only store must not be told to run generic pending processing.

## 6. Workstream C — Presentation-aware telemetry

### TEL-001 — Delivery mode

Retrieval/helpfulness records must identify at least:

- `evidence`,
- `reference`,
- `core`,
- `session_start`,
- `user_prompt`.

Existing `source` data may be extended or normalized rather than duplicated.

### TEL-002 — Reference use

When a referenced memory is opened through source/expand/details, record a privacy-safe linkage when attribution is unambiguous:

- source-open count/time,
- originating injection/trace when available,
- whether the source was later cited/used.

Do not record raw output solely for this telemetry.

### TEL-003 — Source-specific scoring

Evidence injection may use grounding/content overlap. Reference delivery must not be classified as unhelpful solely because the summary text was not repeated in the answer.

### TEL-004 — SessionStart variants

Support deterministic, configurable variants:

- current three-item behavior,
- one summary plus one recent outcome,
- reference-only index with question-time resolution.

The shipped default remains unchanged until sufficient telemetry selects a winner.

### TEL-005 — Rollback

Variant assignment must be feature-flagged and reversible without schema rollback.

## 7. Workstream D — Retrieval benchmark expansion

### BENCH-001 — Corpus

Create an anonymized fixture with at least 50 labeled queries spanning:

- continuation,
- bug/incident diagnosis,
- architectural decision recall,
- file/symbol-specific recall,
- negative/no-match.

Aim for 50-100 queries before using it to approve retrieval phase/ranking changes.

### BENCH-002 — Privacy

Fixture generation must redact secrets and local identities/paths. Public reports include ids and aggregate metrics, not raw text.

### BENCH-003 — Metrics

Report at least:

- Precision@k,
- Recall@k,
- nDCG@k,
- Hit@k,
- MRR,
- no-match accuracy,
- forbidden hits,
- failed queries,
- category breakdown,
- query yield,
- optional token/injection cost.

### BENCH-004 — CI tiers

- Every PR: small deterministic smoke.
- Retrieval/injection PR: full anonymized replay.
- Scheduled/manual: larger LongMemEval/provider-assisted evaluation.

### BENCH-005 — Initial gates

- no-match accuracy: 100%,
- forbidden hits: 0,
- failed queries: 0,
- MRR and Hit@3: no regression from the accepted baseline,
- category failures cannot be hidden by aggregate averages.

## 8. Workstream E — MCP registry and profiles

### MCP-001 — Single tool registry

Tool name, description, schema, handler, profile, and mutation classification should be declared through a registry or generated mapping. Mutation classification must support `read_only`, `conditional`, and `mutating`; conditional tools declare the arguments/default behavior that trigger writes. Tests must fail for missing or duplicate handlers.

### MCP-002 — Handler modules

Split the monolithic handler into bounded modules such as:

- context/search,
- source/import,
- operations,
- graph/lessons,
- governance/assets,
- perspective/shared.

Keep a compatibility `handleToolCall` entry point if needed.

### MCP-003 — Profiles

Support:

- `core`,
- `operations`,
- `governance`,
- `experimental`,
- `all`.

`all` must initially be the compatibility default. Profile selection may use environment/config first; per-client negotiation is optional.

### MCP-004 — Core budget

Target core profile:

- at most 10 tools,
- at most 20 KB serialized tool schema,
- includes context pack, search, source navigation, and project timeline/stats,
- excludes always-mutating tools; explicit import belongs in `operations`,
- identifies context-pack auto-refresh as conditional mutation and preserves an explicit read-only opt-out.

### MCP-005 — Mutation disclosure

Registry metadata must identify read-only, conditional, and mutating tools so clients and tests can enforce safer defaults. Preview/apply tools and context-pack auto-refresh are conditional; their write-triggering inputs and default behavior must be machine-readable.

## 9. Workstream F — Runtime resource efficiency

### RES-001 — Resource telemetry

Expose privacy-safe process-local signals:

- model loaded state/name or opaque backend id,
- model load count/time,
- last MCP activity,
- idle resource release count/time,
- cold/hot retrieval latency,
- process memory totals where supported.

### RES-002 — Fast path

Stats and lexical/fast retrieval must not initialize the embedding model unless a semantic/vector lane is actually required.

### RES-003 — Broker decision gate

A shared local embedding broker is implemented only if post-telemetry evidence shows sustained duplicate model memory or repeated load cost. The decision record must compare:

- in-process plus idle release,
- shared broker,
- external/provider embedding options,
- failure and security boundaries.

### RES-004 — Broker requirements, if approved

- local-only transport,
- one model instance,
- lazy start and idle shutdown,
- bounded requests and timeouts,
- client identity/audit as appropriate,
- in-process fallback,
- no canonical storage ownership.

Target at least 50% aggregate embedding-related RSS reduction without retrieval-quality regression.

## 10. Workstream G — Architecture closure

### ARCH-001 — Boundary baseline to zero

Remove the remaining architecture-guard baseline violations. No new baseline entries are allowed.

### ARCH-002 — Retrieval phases

Only after BENCH-001 through BENCH-005 exist, split retrieval into independently testable phases:

- query plan,
- candidate generation,
- ranking,
- expansion,
- context assembly.

Public output and trace semantics must remain compatible.

### ARCH-003 — Documentation drift

Update stale references to removed `src/ui` paths. Where `src/server`, `src/hooks`, or `src/mcp` compatibility entrypoints still exist, documentation must distinguish those shims from canonical implementations under `src/apps`, `src/adapters`, and `src/extensions`.

### ARCH-004 — Advanced surface policy

Features with low/no adoption remain available through explicit profiles/extensions. Do not expand default tool/context surfaces solely because the underlying tables exist.

## 11. Acceptance metrics

The roadmap is complete when:

1. Read-only commands create zero files/directories and perform zero migrations in invariant tests.
2. Empty-store count no longer grows from diagnostics.
3. GC identifies candidates safely, never selects a store containing canonical/governance data, and can restore every applied quarantine before purge.
4. The quarantined vector canary can be audited, rebuilt, verified, and rolled back without modifying canonical events.
5. Health gives state-specific remediation.
6. Reference opens are attributable and reference delivery is evaluated separately from evidence delivery.
7. The accepted replay corpus has at least 50 queries and blocks no-match/privacy regressions.
8. MCP `core` meets the tool/schema budget while `all` preserves compatibility.
9. Resource telemetry supports an evidence-based broker decision.
10. Architecture guard baseline violations reach zero and retrieval phase extraction is benchmark-protected.

## 12. Release compatibility

Suggested release grouping:

- Patch: read-only invariant.
- Separate patch/minor: recoverable project GC with quarantine/restore; defer purge until policy review.
- Minor: layer audit/rebuild commands and state-specific health remediation.
- Patch/minor: telemetry schema and SessionStart experiment behind flags.
- Minor: MCP registry/profiles with `all` default.
- Later minor only if approved: shared embedding broker.

No release should combine a storage repair primitive, a retrieval ranking change, and an MCP default change in the same rollout.
