# Completed Codex memory ingestion and hook target health

## Confirmed gaps

- Recent project Codex transcripts contain completed task frames absent from the
  canonical store; the last native automatic-import success is from September 23.
- Prompt-time Codex recall intentionally does not pre-store user prompts. Native
  SessionEnd launches a detached importer within the inherited sandbox. Happy's
  account-host recall owns only lookup, not transcript persistence.
- Claude's configured memory hooks point at a separate 2.4.7 checkout while the
  global package is 2.4.10. Existing status checks match filenames and miss this.
- Read-only MCP calls deliberately do not persist source-navigation telemetry.
  Candidate delivery and successful test lookups do not establish actual use.

## Implementation

1. Add a pure streaming Codex reader that requires matching provider session and
   task-start/completion ids. Read only through an acknowledged completed turn;
   exclude unfinished, aborted, orphaned, malformed, and foreign frames.
2. Export a separately negotiated CML host-ingest service. Persist normalized
   user prompts and final responses through a fresh lightweight SQLite service,
   use canonical project identity and idempotent event writes, and enqueue normal
   vector work without model initialization/migration or closing a live session.
   Write a privacy-safe status file with counts and enum failures.
3. In Happy owner-choice account sessions, obtain the native thread/path from
   app-server and dispatch a bounded host worker after authoritative successful
   turn completion. Coalesce jobs, reap workers at shutdown, and preserve native
   behavior when CML lacks the new capability. No model-supplied paths/commands,
   no sandbox widening, and no dropped/aborted turn ingestion.
4. Diagnose actual Claude hook targets, including symlinks, stale/missing paths,
   and unverifiable shell wrappers. Repair current-machine CML hook registration
   from the installed package while preserving a backup and unrelated settings.
5. Recover missing completed project history with the verified reader and normal
   append/dedup APIs; verify a second pass adds no duplicates. Keep originals.
6. Keep memory-use footers conditional on opened sources actually informing an
   answer. Do not manufacture citations to make the feature appear active.

### Importer ownership and fork boundaries

The completed-turn host importer is authoritative only after it has persisted
both a `user_prompt` and an `agent_response` for the same native `turnId`.
The legacy Codex history importer therefore skips that native turn as a unit;
it remains enabled for a partial host write so a retry can recover the missing
side.  Forced legacy reimports preserve transcripts containing native task
markers, because deleting a clean host turn and rebuilding it from commentary
records would weaken the host privacy and final-answer contract.  Setup-only
AGENTS/environment records are ignored by both paths.

Forked transcripts without a verified `subagent_history_start_ordinal` are
intentionally rejected (`invalid_transcript`).  A `forked_from_id` alone does
not identify which inherited records belong to the child, so accepting it
could replay a parent turn into the child project.  Support for other native
fork layouts requires a fixture that proves an equivalent boundary.

## Validation

- Parser and service tests cover completion cutoff, privacy/normalization,
  identity mismatch, append failure/cleanup, no pending writes, and dedup retry.
- Native host tests cover gating, unsupported old CML, completion observer,
  worker timeout/error/cleanup, queue coalescing, and safe counts only.
- Build/typecheck/lint and independent review before committing/PRs.
- Synthetic built-artifact import must work without embedding models and be
  idempotent. Live backfill reports counts only and never removes events.
- External Happy release requires the separate explicit approval in its AGENTS.

## Verified recovery and rollout

- The five current-machine Claude hook targets now match the installed 2.4.10
  package; unrelated settings were preserved and an original backup retained.
- Completed recent history recovered 29 prompts and 29 final responses. A
  second pass appended zero events. Recovery excludes inherited sub-agent
  history and setup-only messages; stored recovered prompts contain no memory
  index, environment, or role-context envelopes.
- Native lifecycle clocks can be Unix seconds or milliseconds. Both variants
  have regression coverage. Recovery source clocks were corrected against the
  matching native session/turn while preserving content and event identities.
- Assistant privacy filtering runs before truncation and storage. Malformed
  known text blocks invalidate their turn instead of silently losing fragments.
- CML whole-suite, build, typecheck, lint, import boundaries and isolated built
  parser/SQLite smoke checks pass. Lint retains pre-existing warnings.
- The current installed CML/Happy versions do not include the new automatic
  completion ingestion. This requires both PRs, release, and fresh sessions;
  local hook repair and completed-history recovery are already applied.
