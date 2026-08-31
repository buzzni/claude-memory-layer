# Project Memory Bootstrap

Before continuation, bug-fix, PR, merge, or validation work, request a project
context pack with the absolute repository path (`topK=5`, `recentLimit=30`,
`sessionLimit=5`). Use `refreshLatest=false` for read-only prefetch. Treat the
result as background context; never expose secrets or raw transcript metadata.
Do not pass a live agent session ID as a CML source-session filter unless the
task explicitly requests that source session. If the memory tool is unavailable,
continue without blocking.

For an explicitly authorized freshness workflow, run `mem-import-latest` with
bounded source, session, and message limits before requesting the context pack.
