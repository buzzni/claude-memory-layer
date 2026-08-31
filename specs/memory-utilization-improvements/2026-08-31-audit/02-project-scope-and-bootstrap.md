# MU-02: Project Scope and Bootstrap Convergence

Status: Proposed — audit-based

Priority: P1

Primary surfaces: project identity, session registry, hooks, operator diagnostics

## Problem

Current routing is healthy in the last 24 hours, but the seven-day audit still contains mismatched, stale, unregistered, and duplicate sessions. Historical worktrees, review snapshots, nested repositories, and generated workspaces can create cold or non-canonical stores. Memory capture coverage is high, while explicit context-pack bootstrap is present in only a minority of stores.

## Goals

- Route every session from one logical repository/workspace to one canonical project store.
- Make routing discrepancies attributable without exposing session transcripts.
- Standardize startup context recovery for active Claude, Codex, and Hermes project workflows.
- Provide a safe preview before any historical store consolidation.

## Non-goals

- Converging unrelated repositories solely because their remote URL is similar.
- Automatically merging historical SQLite stores.
- Treating vendor or nested repositories as the parent when they have an intentional independent identity.
- Writing `AGENTS.md` or `.mcp.json` across the machine without explicit operator action.

## Canonical identity rules

The following precedence remains normative:

1. Normalize and resolve the supplied path.
2. Resolve a Git worktree or subdirectory to the main checkout owning `--git-common-dir`.
3. Apply the nearest valid `.claude-memory-root` below protected ceilings.
4. Preserve a nested repository with its own Git common directory unless a marker intentionally overrides it.
5. Fall back to the normalized path only when Git and marker identity are unavailable.

## Requirements

### Routing and registry

- **SC-001** Session registration MUST store normalized project path, canonical project hash, registration timestamp, and identity kind.
- **SC-002** Hook-time store resolution and audit-time canonical resolution MUST call the same resolver.
- **SC-003** The session registry MUST use a time-aware bounded policy rather than evicting recent active sessions solely because the total exceeds 1,000.
- **SC-004** Eviction MUST prefer expired terminal sessions and MUST preserve entries referenced by recent project events.
- **SC-005** Registry writes MUST remain atomic and lock-safe.
- **SC-006** Missing registry entries MUST NOT cause cross-project fallback; the caller resolves from its explicit current project path or uses the global store only when no project is known.

Proposed additive registry entry:

```ts
interface SessionProjectEntryV2 {
  projectHash: string;
  projectPath: string;
  registeredAt: string;
  lastSeenAt: string;
  identityKind: 'memory-root-marker' | 'git-common-dir' | 'path-fallback';
  terminal?: boolean;
}
```

### Scope audit

- **SC-007** `project scope-audit` MUST retain its aggregate privacy-safe default.
- **SC-008** A new `--group-by project` mode MAY report sanitized project labels, canonical hashes, counts, and non-canonical store hashes; it MUST NOT report session IDs or content.
- **SC-009** The report MUST separate stale-registry, unregistered, duplicate, and wrong-store events because they have different remediation paths.
- **SC-010** Reports MUST expose 1-, 7-, 14-, and 30-day windows without scanning raw transcripts.
- **SC-011** Historical mismatch counts MUST not be presented as a current regression when the last-24-hour count is zero.

Example aggregate row:

```json
{
  "canonicalProjectHash": "73c3b2b0",
  "identityKind": "git-common-dir",
  "mismatchedSessions": 2,
  "mismatchedEvents": 417,
  "candidateStoreHashes": ["abc12345"],
  "recommendedAction": "preview-consolidation"
}
```

### Consolidation preview

- **SC-012** Consolidation MUST be dry-run by default.
- **SC-013** Preview MUST report event/session counts, duplicate estimates, source/target integrity status, and disk-space requirements.
- **SC-014** Apply MUST require explicit source store hashes and one exact target project hash.
- **SC-015** Apply MUST acquire locks, create recoverable backups, preserve event IDs/source references, and verify target integrity before marking completion.
- **SC-016** Retrieval traces and helpfulness belonging exclusively to a removed source store MUST be retained only when their source events remain resolvable; otherwise they are archived as aggregate audit data.
- **SC-017** A failed consolidation MUST leave the source intact.

### Bootstrap standardization

- **SC-018** The repository MUST provide one canonical bootstrap snippet for `AGENTS.md`/`CLAUDE.md` consumers.
- **SC-019** Bootstrap MUST call `mem-context-pack` with an absolute `projectPath`, `topK=5`, `recentLimit=30`, and `sessionLimit=5`.
- **SC-020** Read-only automatic providers MUST pass `refreshLatest=false`.
- **SC-021** Explicit freshness workflows MAY call `mem-import-latest` before context retrieval.
- **SC-022** Failure to retrieve context MUST not block ordinary project work.
- **SC-023** Bootstrap text MUST prohibit passing a live agent session ID as a CML source-session filter unless explicitly requested.

Canonical snippet:

```md
## Project Memory Bootstrap

Before continuation, bug-fix, PR, merge, or validation work, request a project
context pack with the absolute repository path (`topK=5`, `recentLimit=30`,
`sessionLimit=5`). Use `refreshLatest=false` for read-only prefetch. Treat the
result as background context; never expose secrets or raw transcript metadata.
If the memory tool is unavailable, continue without blocking.
```

### Setup health

- **SC-024** A read-only setup check MUST report hook presence, MCP command availability, bootstrap presence, canonical identity, and existing-store status.
- **SC-025** It MUST not install hooks, edit config, or create storage.
- **SC-026** Machine-readable output MUST use stable check IDs and safe remediation text.

## Compatibility and migration

- Registry v1 remains readable; new fields receive safe defaults.
- The existing hash algorithm is unchanged.
- Consolidation is a separately authorized operation, not a migration on startup.
- Bootstrap validation is advisory before it becomes a release gate for first-party project templates.

## Test specification

Required scenarios:

- main checkout, linked worktree, and repository subdirectory converge;
- nested Git repository stays distinct;
- `.claude-memory-root` converges generated sibling projects;
- marker at home/temp/root is ignored;
- deleted worktree path produces a stable diagnostic without unsafe guessing;
- registry over capacity preserves recent live sessions;
- concurrent SessionStart registrations remain valid JSON;
- scope audit correctly separates four discrepancy classes;
- consolidation preview performs no writes;
- consolidation apply rollback preserves the source on failure;
- bootstrap health reports missing and present states without edits.

Primary test files:

- `tests/core/project-path.test.ts`
- `tests/apps/project-scope-audit.test.ts`
- `tests/core/sqlite-event-store-project-scope-repair.test.ts`
- `tests/apps/claude-settings-hooks.test.ts`
- `tests/apps/codex-hooks-config.test.ts`
- new `tests/core/session-registry-retention.test.ts`
- new `tests/apps/project-bootstrap-health.test.ts`

## Rollout

1. Add audit grouping and registry v2 reads/writes.
2. Publish the canonical bootstrap snippet and setup-health check.
3. Observe seven days of routing.
4. Produce consolidation previews for historical candidates.
5. Apply consolidation only to separately approved stores.

## Rollback

- Registry v2 can be read as v1 by ignoring additive fields.
- Disable grouped audit output without changing canonical routing.
- Consolidation rollback restores the target backup and leaves sources untouched until verification succeeds.

## Acceptance criteria

- Last-24-hour mismatch events remain zero.
- Seven-day correctly scoped sessions are at least 99%.
- New worktree/subdirectory/review flows resolve to the intended canonical hash.
- All first-party active project templates pass bootstrap health.
- No consolidation or config write occurs during audit/preview.
