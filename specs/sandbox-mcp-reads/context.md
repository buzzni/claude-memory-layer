# Investigation state

- Working branch fix/sandbox-mcp-reads is based on remote main after CML 2.4.9.
- Host automatic recall is verified healthy; direct MCP failed on model-cache mkdir.
- MCP bootstrap later succeeds after host-side cache preparation; this does not
  demonstrate reliable cold/read-only operation.
- Independent review identified eager runtime initialization, writable service
  constructors, navigation telemetry initialization, hybrid lesson warmup and
  optional perspective writable contexts as the affected paths.
- Existing SQLite snapshot and fast lexical retrieval helpers will be reused.
- No source store or installed settings changes are authorized/needed for tests.

## Results

- Subagent-owned regressions first reproduced 11 failures; expanded final suite
  passed 14 tests, including both markers, host-worker exclusion, perspective,
  privacy, missing-store non-creation and snapshot cleanup.
- Built stdio MCP tested under sandbox-exec with network and filesystem writes
  denied except synthetic snapshot temp storage. A write probe confirmed the OS
  restriction was active. Ten reads and three rejected mutation/refresh requests
  passed; the tool list exposed only the ten supported names.
- Synthetic canonical SQLite DB/WAL/SHM and nonempty Lance index retained file
  hashes, sizes, modes and mtimes. No model cache or temporary snapshot remained.
- Denying source reads returned an error without exposing storage paths.
- Full suite: 258 files / 1,892 tests; final focused suite after the homedir-only
  fixture isolation change: 75 tests. Typecheck, build and architecture passed;
  lint: zero errors and 45 existing warnings.
- Independent product review found no new defect. Stats may count an existing
  Lance index through its established read-only path; no semantic retrieval is
  used by constrained context/search reads.

Reproduce the opt-in OS smoke on macOS after `npm run build`:
`node scripts/smoke-sandbox-mcp.mjs`. This script uses synthetic storage only,
does not change HOME, and removes its fixture after completion. It needs an
execution context allowed to start sandbox-exec; nested sandbox profiles may
prevent starting the test itself.
