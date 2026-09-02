# MU-07: Runtime and Session Lifecycle Follow-up

Status: Implemented

Priority: P1

## Evidence

The post-install machine audit showed that project-scoped retrieval and vector
storage were healthy, while mixed-version MCP processes remained resident,
almost every registry entry appeared non-terminal, and usefulness outcome
coverage was concentrated in Claude hook sessions.

## Requirements

- `runtime-status` reports version-mismatched, uninstrumented, and orphan MCP
  process counts and gives a privacy-safe restart recommendation. It never
  signals or terminates a process.
- A registry entry with no refresh for seven days stops acting as a live
  cleanup protection. Its project mapping remains available for late writes,
  and a new SessionStart registration makes it active again.
- Completed Claude, Codex, and Hermes history imports are registered terminal.
- Completed imports run best-effort usefulness evaluation after their events
  are durable. Analytics failure cannot fail or roll back an import.
- Project-store cleanup remains preview-only. Terminalizing an old registry
  entry alone never authorizes deletion; age, recent events, and locks remain
  independent protection gates.

## Acceptance criteria

- Mixed release or uninstrumented MCP processes produce a restart advisory.
- Unsupported process observation produces neutral advisory counters.
- A stale non-terminal registry entry becomes terminal without losing its
  project path/hash mapping.
- A current or resumed registration remains non-terminal.
- Each supported importer attempts usefulness evaluation exactly once after
  ending the imported session.
- Related tests, type checking, lint, the full test suite, and build pass.

## Rollback

Revert the advisory fields and importer evaluation calls. Registry entries
marked terminal remain valid routing mappings; a later SessionStart naturally
reactivates them, so no data migration or destructive rollback is required.
