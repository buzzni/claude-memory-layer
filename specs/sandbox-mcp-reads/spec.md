# Sandboxed direct MCP memory reads

## Problem

The released Happy host recall path works, but native CML MCP context-pack may
initialize embeddings and write model caches. Source-ref/details can open
canonical SQLite in writable mode before disclosure. A read-permitted,
write-denied sandbox therefore cannot reliably expand returned references.

## Requirements

- A CML MCP process inheriting CLAUDE_MEMORY_RECALL_OWNER=host uses constrained
  reads. Operators may independently request the same mode with
  CLAUDE_MEMORY_MCP_READ_ONLY=1. These markers restrict access, never grant it.
- Context-pack/search/navigation use uncached SQLite snapshots, fast lexical
  retrieval, no model/vector initialization, and no canonical writes.
- Disable implicit freshness imports; explicit imports, refreshes and unsupported
  operation tools fail before storage access. Allow existing snapshot-backed
  lesson get/list and stats. External market context remains independent.
- Context-pack lesson ranking is lexical; optional perspective reads use snapshots.
- Skip query/navigation telemetry in constrained mode. Never claim source use or
  delivery merely because a reference is returned.
- Preserve ordinary non-constrained MCP behavior. Explicit refreshLatest=false
  uses the same model-free context-pack path, with its read-only capabilities.
- Keep scope checks, permission enforcement, privacy filtering, and cleanup.
- A denied source read remains an error. Snapshot reads are best-effort around
  concurrent checkpointing; this feature provides no unsandboxed broker.

## Validation

Regression tests with model initialization and canonical writes disallowed;
source-ref/details with neighbors; context-pack/search lexical matches;
explicit mutation refusal; missing-store non-creation; open WAL and closed-store
file hashes unchanged; cleanup and unsafe snapshot directories; built MCP process
under actual filesystem sandbox with synthetic storage. Then typecheck/lint,
full tests, build, and architecture checks. Live settings/stores stay unchanged.
