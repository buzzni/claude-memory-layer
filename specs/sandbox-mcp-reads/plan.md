# Execution plan

1. Trace initialization and reproduce write requirements. Done.
2. Add failing regressions for constrained direct reads and mutation refusal. Done: initial 11/11 failed, final suite 14/14 passed.
3. Implement marker-controlled snapshot reads and model-free lexical retrieval. Done.
4. Verify privacy, scope, no-write invariants and built sandboxed MCP behavior. Done: real macOS sandbox, 10 reads and 3 rejected writes/refreshes, no canonical changes or snapshot leaks. Source read denial remains a sanitized error.
5. Run repository checks, review final diff and report rollout requirements. Done: typecheck, lint (0 errors, 45 existing warnings), architecture, build, full suite (258 files / 1,892 tests) and final focused suite (75 tests) passed. Independent product review found no additional defect.

## Rollout

Release and install a new CML version, then restart native MCP processes. Existing
Happy 1.1.10-aplus.281 already propagates the host ownership marker, so this
change requires no new Happy release. Live installations/settings/stores have
not been changed during development. Restricted reads need readable sources
and writable temporary storage; semantic-only recall and a read-denied source
broker are outside this change.
