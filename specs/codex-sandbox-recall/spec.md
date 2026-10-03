# Codex sandbox recall recovery

## Problem and evidence

CML 2.4.8 automatic Codex hooks open writable SQLite and persist auxiliary state.
Happy's outer app-server sandbox does not allow writes to canonical CML storage.
A populated synthetic fixture returned context outside that boundary, returned
empty exit-0 envelopes with permission/open errors inside it, and recovered when
only the fixture storage was permitted. This is controlled reproduction; live
hook stderr and production recovery have not yet been verified.

Additionally, UserPromptSubmit routes through a session registry and silently
falls back to global storage when registration fails, despite receiving cwd.

## Required behavior

- Preserve sandbox filesystem/network policy and canonical memory permissions.
- A compatible host performs recall outside the app-server sandbox, using its
  authoritative project cwd and native thread identity. No agent-callable broker
  or renderer-controlled storage path/executable is added.
- CML publishes a small installed-artifact capability contract. Happy suppresses
  native event hooks only after this capability and both hook artifacts exist.
  Older/absent packages keep their existing native behavior.
- Host invocation uses the same bounded memory reference formatter and existing
  lesson ownership policy. Host workers do not pre-store incomplete Codex turns.
- SessionStart and UserPromptSubmit use cwd to resolve project storage, including
  canonical worktree normalization. Registry failure cannot cause global recall.
- Scoped semantic requests carry the same project path, and the client requires
  a matching project hash in the response. Legacy daemon responses without
  scope proof fall back to the project-local SQLite lane.
- Host workers do not start detached daemons, schedule graduation, auto-heal
  vectors, or backfill summaries. Existing daemon retrieval remains optional.
- Startup context stays pending until the provider accepts turn/start; cancelled
  or preparation-failed turns cannot consume the startup injection.
- Recall failure is distinguishable from a healthy empty result even though the
  native protocol continues to receive exactly one safe JSON envelope.
- Diagnostics contain fixed event/stage/outcome/error codes and numeric counts;
  no paths, raw prompts, credentials, session identifiers, or exception messages.
- Host context is incorporated before the user request. Returning/emitting context
  is not evidence that the model read a reference or relied on it in an answer.
- Managed sessions are not granted access to the host owner's memory.
- Raw event host execution is enabled only in owner-choice machine policy.
  Mandatory/shared machines require a signed project/actor-bound broker before
  any unsandboxed canonical-memory operation; this change does not enable one.

## Implementation plan

1. Add CML host capability artifact and explicit host/native ownership handling.
2. Route prompt hooks by cwd and add privacy-safe diagnostics for invalid input,
   selected/empty context, initialization/retrieval failures, and runtime timeout.
   Apply equivalent project scoping to the semantic protocol and reject old
   daemon replies that cannot prove the scope.
3. In a separate Happy worktree, gate host recall by account ownership, owner-choice machine policy, sandbox
   configuration, installed-artifact capability, and trusted hook resolution.
   Execute bounded host workers; suppress duplicate native event hooks through
   child-specific environment, preserving reconnect and cancellation behavior.
4. Test project routing without registry, ownership and legacy compatibility,
   diagnostic privacy, worker failures/cancellation/output limits, prompt assembly,
   and the built artifacts under the reproduced OS filesystem boundary.
5. Run CML typecheck/lint/tests/build and relevant Happy checks, review both diffs,
   and report release dependencies and remaining live verification requirements.

## Tradeoffs and rollout

Host execution avoids copying a whole database on every hook and avoids readonly
WAL sidecar/consistency problems. A general IPC broker is deferred: this fix needs
only the existing host turn assembly boundary. Native hooks retain safe envelopes
on errors, but diagnostics must prevent interpreting exit 0 as retrieval health.

Source fixes require a compatible CML release and Happy CLI release, followed by
a new/restarted Codex session. This implementation does not publish packages,
alter installed hooks/settings, restart the live session, or migrate original
memory storage. Production recovery is a separate post-release validation step.

## Implemented and verified

- CML: capability artifact, lazy native delegation, cwd-authoritative SQLite and
  scope-verified semantic retrieval, fixed-code stderr diagnostics, host-worker
  maintenance suppression, audit attribution for `codex-host`.
- Startup stdout telemetry uses a fresh uncached writer after the retrieval
  service closes. Evaluation startup no longer writes retrieval/delivery rows.
- Happy changes are isolated in branch `fix/codex-memory-recall-host` in the
  separate Happy worktree. The host checks artifact and native SQLite runtime
  compatibility before suppressing native recall, enforces output/time bounds,
  and retains pending startup context until accepted provider submission.
- Combined context overflow preserves prompt matches and defers startup context;
  a 30-second startup failure backoff avoids repeating both worker budgets on
  every turn. Opus 5.5/high implementation feedback prompted these corrections.
- CML full suite: 257 files / 1,879 tests passed; typecheck, build, architecture
  check passed. Full lint has 0 errors and 45 existing warnings; edited hook
  files pass lint. Registry/delivery focused tests also passed after the factory
  type annotation was widened to reflect its existing scoped runtime config.
- Happy full build/typecheck and five related suites: 193 tests passed.
- Real installed ASRT filesystem-boundary fixture: unchanged policy blocked
  native lookup with a structured error, delegated native hooks changed no
  canonical fixture files, host workers returned populated project references.
- Actual Happy-to-built-CML smoke: evaluation and ordinary execution both returned
  startup and prompt references before the request. Ordinary startup/prompt
  telemetry was emitted with matching traces; evaluation left no stray formatted
  rows. Synthetic fixtures were removed; original memory/settings were untouched.

## Remaining rollout requirement

Both CML and Happy fixes must ship together and be installed before restarting
the session. The current installed 2.4.8 package and running app-server have not
been replaced. Mandatory/shared machines remain on native behavior until a
signed actor/project-bound event recall broker is implemented. `emitted` proves
stdout transfer, not that the model opened a source or used a memory in its answer.
