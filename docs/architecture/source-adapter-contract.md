# Source Adapter Contract

This document defines the Packet B source adapter contract for `claude-memory-layer`. It adapts the useful MemPalace pattern of explicit source contracts while preserving CML's rule that SQLite raw events and governed projections remain the source of truth.

A source adapter describes how an external or runtime source is captured, normalized, privacy-filtered, and linked back to bounded evidence. The adapter feeds the existing ingest/event pipeline; it must not become a second memory store or leak private source locations.

## Contract shape

The core declaration lives under `src/core/source/` and is exported from `src/core/index.ts`.

```ts
interface SourceAdapterCapabilities extends Readonly<Record<string, boolean | string | number>> {
  readonly currentnessStrategy: string;
}

interface SourceAdapterContract {
  identity: SourceAdapterIdentity;
  source: SourceSchemaDeclaration;
  transformations: readonly SourceTransformationDeclaration[];
  sampleSourceRefs?: readonly SourceRef[];
  capabilities: SourceAdapterCapabilities;
}
```

Runtime adapters can add methods around this declaration, but every adapter must publish the same contract fields before ingesting records.

## Required fields

### Source identity and source version

There are two stable identities:

1. `identity.id` and `identity.version` identify the adapter implementation and its contract behavior.
2. `source.id` and `source.version` identify the upstream source/schema being captured.

Rules:

- Ids must be stable identifiers such as `codex-session-importer`, `claude-history`, or `tool-observation`; they must not be local absolute paths, transient filenames, hostnames, user names, or raw database locations.
- `identity.version` changes when adapter behavior, currentness logic, declared transformations, or privacy handling changes in a way downstream readers must understand.
- `source.version` changes when the upstream record/schema shape changes.
- Display names are optional and human-facing only; code and evidence must use stable ids.

### Privacy class

`source.privacyClass` and each `SourceRef.privacyClass` must use the bounded enum:

- `public`
- `internal`
- `confidential`
- `restricted`

Rules:

- Choose the most conservative class that applies to the raw source, not merely the redacted preview.
- The privacy class determines how much of a source ref can be shown by MCP/API/UI disclosure surfaces.
- Adapters that mix classes must either split records into separate source declarations or conservatively mark the whole adapter/source as the highest applicable class.

### Declared transformations

Every adapter declares at least one `SourceTransformationDeclaration`:

- `id`
- `version`
- `kind`: one of `extract`, `normalize`, `privacy-filter`, `map`, or `enrich`
- `inputSchema`
- `outputSchema`
- optional `deterministic`
- optional `description`

Rules:

- Transformation ids must be stable and must not contain paths or secrets.
- Each transformation states what it consumes and emits, for example `codex-session@1` to `raw-event@1`.
- Privacy filtering must be declared explicitly when public handles, source refs, previews, or metadata are redacted.
- Transformations are metadata declarations, not hidden execution logs. The raw source and governed event/projection stores remain authoritative.

### Capture mode

`source.captureMode` and each `SourceRef.captureMode` must use the bounded enum:

- `snapshot`: bounded one-shot fixture or point-in-time read
- `append-only-log`: monotonic journal or transcript stream that can be resumed by cursor
- `stream`: live subscription or hook capture
- `metadata-only`: source metadata without raw payload capture
- `history_import`: bounded session/history import wrapper that preserves importer behavior while declaring provenance metadata

Rules:

- Capture mode describes how the source is observed, not where the data is stored.
- Live hook adapters usually use `stream`; session-history importers usually use `snapshot` or `append-only-log` depending on whether they can resume incrementally.
- A mode change is contract-relevant and should be reflected in adapter behavior/versioning.

### Schema declaration

`SourceSchemaDeclaration` records:

- `id`
- `version`
- `privacyClass`
- `captureMode`
- optional `description`
- optional `metadataSchema`

Rules:

- `metadataSchema` should be a stable schema handle such as `codex-session-metadata@1`, not an inline dump of private source data.
- Schema descriptions may explain field families and redaction policy, but must not include raw messages, tool payloads, credentials, or private local state paths.
- Schema ids and versions are used by transformation declarations and conformance tests, so they should be short and durable.

### Incremental/currentness checks

`capabilities.currentnessStrategy` is required for every adapter, even when the first implementation is snapshot-only.

Minimum currentness metadata:

- stable source key or event/source-ref handle
- source version seen at capture time
- adapter identity/version seen at capture time
- capture mode
- privacy class
- optional source cursor, monotonic sequence, timestamp, checksum, or event count when available

Rules:

- `isCurrent` style logic must compare stable metadata, not raw file paths or host-local locations.
- Snapshot adapters should be idempotent for the same stable source key and source version.
- Append-only and stream adapters should resume from durable cursors or event/source-ref handles, then emit only unseen records.
- If the adapter cannot prove currentness, it should report that it needs recapture instead of silently reusing stale derived rows.

### Close semantics

Adapters that open files, sockets, subprocesses, watchers, database clients, or subscription handles must expose idempotent close semantics.

Rules:

- `close()` may release runtime resources; it must not mutate canonical memory state except through explicit ingest/outbox APIs.
- `close()` must be safe to call more than once.
- History/snapshot adapters with no open resources can implement close as a no-op, but the behavior should still be documented in the adapter contract or conformance fixture.
- Failure during close should be reported as operational telemetry, not as an excuse to hide partially ingested records.

### Source refs and evidence handles

Every adapter should emit source refs that allow bounded evidence drill-down without exposing raw secrets, raw private content, absolute paths, or local state database paths.

`SourceRef` records:

- `kind`: for example `file`, `session`, `api`, `database`, `message`, or `unknown`
- `stableId`
- `publicHandle`
- optional `evidenceHandle`
- `privacyClass`
- `captureMode`
- optional scalar `metadata`

Rules:

- `stableId`, `publicHandle`, and `evidenceHandle` must not be local absolute paths, credentials, bearer tokens, raw prompts, raw tool payloads, or private database locations.
- Prefer stable handles such as `event:<id>`, `session:<redacted-session-id>`, `message:<redacted-message-id>`, or hashed/redacted source keys.
- `publicHandle` is safe for user-facing disclosure; `evidenceHandle` is a bounded internal pointer that can be resolved by approved source-ref tooling.
- Metadata values must be scalar and redacted. Do not attach raw source records, transcript fragments, connection strings, or nested private payloads.

## Conformance test requirements

Every production adapter or conformance fixture must have tests that prove:

1. Stable adapter identity and source version are present and reject empty or path-like ids.
2. Privacy class and capture mode use the bounded enums.
3. Schema declarations include stable ids and versions.
4. Transformations are declared, versioned, stable, immutable, and use bounded kinds.
5. Source refs reject public/evidence handles that look like local absolute paths and do not contain raw secrets.
6. Currentness checks are deterministic for repeated input and fail closed when required metadata is missing.
7. Close semantics are idempotent and do not write to canonical memory stores directly.
8. The adapter can be validated by `validateSourceAdapterContract` or `assertSourceAdapterContract` before ingest side effects run.

The current core conformance suite covers the declaration-level checks in `tests/core/source-adapter-contract.test.ts`. Runtime adapters should add focused tests around their incremental/currentness and close behavior.

## Packet B status and roadmap

Packet B starts with the core declaration, conformance contract, and a first production `hermes-history` wrapper that declares the existing Hermes SessionDB importer source without changing importer behavior. The core conformance fixture still models the Codex session/history shape with `codex-session-importer` and `source.id = codex-session` so the contract can be validated without coupling `src/core` to importer implementations.

Current adapter status:

1. `hermes-history`: implemented as a first-party wrapper under `src/adapters/hermes/source/`; it declares `history_import`, confidential privacy, redacted source refs, and `currentnessStrategy = session-started-at-and-message-id` while delegating actual imports to the existing Hermes history importer path.
2. `codex-history`: deferred production wrapper; the core conformance fixture already models its snapshot source, transformation to raw events, and session source refs.
3. `claude-history`: deferred until a second history importer can compare source refs, redaction, and currentness behavior against the Hermes wrapper.
4. `claude-hook`: intentionally deferred until stream mode, close semantics, and watcher/subscription cleanup are tested.
5. `tool-observation`: intentionally deferred until tool capture policy needs separate privacy/currentness controls from normal session import.

Intentional non-goals for this packet:

- Do not add new source types before the contract and at least one adapter wrapper are conformant.
- Do not copy MemPalace storage backends or terminology wholesale.
- Do not make source adapters bypass `MemoryIngestService`, SQLite event storage, governance audit records, or vector/outbox rebuild rules.
- Do not expose raw transcripts, tool payloads, credentials, user-specific absolute paths, or local state database paths in docs, tests, source refs, metadata, or MCP disclosure output.
