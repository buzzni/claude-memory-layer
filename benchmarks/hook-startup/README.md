# Hook startup cost and first-run durability (T11)

- Measured 2026-11-17 on `b99f62f` (base) and this branch, Node 22.23.1, macOS arm64.
- Questions: what each hook loads before it runs; what happens on a first run when a native dependency is missing; where a hook's cold start goes.
- Changes made from the findings: LanceDB is loaded only where vectors are used; PostToolUse decides whether to store a call before loading the store; doctor checks the SQLite binding, LanceDB and the PostToolUse handler.

**Read the timings as relative, not absolute.** Other jobs were running on the machine throughout (load average 50 to 180). Absolute times are roughly twice what an idle run of the same harness showed, and the spread is wide. Before and after were run in alternating rounds of 5 under the same conditions, so the differences between them are more trustworthy than the levels. A difference smaller than about 30 ms on wall time is within the noise seen on hooks that did not change.

## Scripts

| Script | What it does |
|---|---|
| `trace.cjs` | Preload (`NODE_OPTIONS=--require`) for the hook process. Records when the preload ran, the first `process.stdin` access, time inside better-sqlite3's native load, `Database` construction, `exec` and `pragma`, time inside synchronous `child_process` calls, and the exit time. Writes one JSON line per hook run. |
| `cold-start.mjs` | Runs the hooks through an installed package's `hook-launcher.cjs` with `trace.cjs` preloaded, in a temp HOME and a temp git project, and records each run. |
| `compare.mjs` | Phase tables (p50 / p90) per side and the p50 difference against the first side; `--csv` writes every run. |
| `first-run.mjs` | Two sessions through the launcher in a fresh temp HOME, then `search`, `status` and `doctor`, printing exit codes and output. |
| `count-tool-calls.mjs` | Share of tool calls the PostToolUse filter drops, from local Claude Code transcripts. Prints counts only. Not reproducible elsewhere: it depends on whose transcripts are read. |

### Phases

| Phase | From | To |
|---|---|---|
| boot | process start | preload runs (Node's own startup) |
| load | preload done | first `process.stdin` access: launcher plus every module the hook bundle loads before its hook starts |
| db | | time inside better-sqlite3 open, `exec` and `pragma` (schema setup included) |
| git | | time inside synchronous `child_process` calls (in practice `git` for project detection) |
| work | first stdin access | exit, minus db and git; a module the hook imports later (the PostToolUse handler) is counted here |
| exit | exit event | parent sees the process close |

### Reproducing

```bash
npm run build && npm pack --pack-destination /tmp/cml-pack
npm install -g --prefix /tmp/cml-normal /tmp/cml-pack/claude-memory-layer-*.tgz
PKG=/tmp/cml-normal/lib/node_modules/claude-memory-layer

# Cold start: alternate rounds of the two packages being compared.
CML_MODEL_SRC=~/.claude-code/memory/models/Xenova CML_EXTRA_ENV='{"CLAUDE_MEMORY_SUMMARY_MODE":"rule"}' \
  node benchmarks/hook-startup/cold-start.mjs --pkg "$PKG" --work /tmp/cml-cold-final --reps 5 --warmup 1 --label r1
node benchmarks/hook-startup/compare.mjs --side base=/tmp/cml-cold-base --side final=/tmp/cml-cold-final

# First run with a dependency removed (copy the prefix first; `cp -cR` clones on APFS).
cp -R /tmp/cml-normal /tmp/cml-nolance
rm -rf /tmp/cml-nolance/lib/node_modules/claude-memory-layer/node_modules/@lancedb/lancedb-darwin-arm64
node benchmarks/hook-startup/first-run.mjs --prefix /tmp/cml-nolance --work /tmp/cml-fr-nolance
```

The variants used: the embedding backend skipped (`CLAUDE_MEMORY_LAYER_SKIP_EMBEDDING_POSTINSTALL=1` at install), the LanceDB platform package removed, `better-sqlite3/build/Release/better_sqlite3.node` removed (what a binding built for another Node or never built looks like at first open), and the `better-sqlite3` package removed. `CLAUDE_MEMORY_SUMMARY_MODE=rule` keeps session end from calling an LLM CLI; `CML_MODEL_SRC` copies an existing model cache so the semantic daemon does not download one.

## 1. What each entry point loads

Before → after this branch. "Loads at start" means a static import in the built bundle, which runs before the hook. Everything not listed as external in `scripts/build.ts` is bundled.

| Entry point (bundle size) | Loads at start | Loads while running |
|---|---|---|
| SessionStart, UserPromptSubmit, Stop (0.78–0.85 MB each) | better-sqlite3, LanceDB, zod → better-sqlite3, zod | SQLite; the semantic daemon over its socket (SessionStart starts it). Never LanceDB in the hook process. |
| PostToolUse (0.77 MB → 9.8 KB entry + 0.77 MB handler) | better-sqlite3, LanceDB, zod → none (Node built-ins) | the handler (better-sqlite3, zod) only for a call it stores |
| PreToolUse (1.3 KB, unchanged) | none | the handler (better-sqlite3, zod) only when the pre-edit check is on |
| PreCompact (41 KB, unchanged) | better-sqlite3, zod | SQLite |
| SessionEnd (0.85 MB) | better-sqlite3, LanceDB, zod → better-sqlite3, zod | a detached worker (10 KB, built-ins), which loads session-end-handler (better-sqlite3, zod) |
| Plugin launcher | Node built-ins | imports the hook bundle in its own process |
| CLI (`status`, `doctor`, `search`), MCP server | better-sqlite3, LanceDB, zod, … → without LanceDB | `search` (except `--strategy fast`) loads LanceDB and the embedding backend |
| Semantic daemon | better-sqlite3, LanceDB, zod → without LanceDB | LanceDB, the embedding backend and its ONNX model |

Import cost of each heavy module alone (`node -e "import(...)"`, median of 5, lighter load): LanceDB 35 ms, zod 23 ms, better-sqlite3 6 ms (8 ms with an in-memory open). The embedding backend was already loaded only on use.

## 2. First run with a dependency missing

| Missing | Capture, keyword recall, session end | doctor and CLI |
|---|---|---|
| Embedding backend | all work (the next session recalled the earlier response); same before and after | doctor: `embedding-backend` fails with the fix; `search` fails with the reinstall hint, `search --strategy fast` works |
| LanceDB platform package | **before: all seven hooks exit 1 while loading, nothing is stored.** After: all work | before: `--version`, `status` and `doctor` crash. After: they run, doctor's `vector-store` fails; `search` fails, `--strategy fast` works |
| better-sqlite3 binding (`.node`) | before and after: every hook exits 0 and stores nothing; no store is created; the recall diagnostic on stderr says only `errorCode: "other"`. The session-end retry queue does not catch it: the handler imports, the open fails later | before: every doctor check passes ("native bindings are checked at first use"). After: `sqlite` fails with the cause and the reinstall command |
| better-sqlite3 package | every hook exits 1 while loading (after: PostToolUse and PreToolUse report the handler they could not load in one line, also exit 1) | the CLI crashes on start, doctor included |

Minimum for a first memory to be recalled, after this branch: Node ≥ 20.19, a better-sqlite3 binding that opens with that Node, and the hooks registered. LanceDB, the embedding backend, the model download and the semantic daemon are not needed. Before, LanceDB was needed too.

## 3. Cold start by phase

Base (`b99f62f`) and final (this branch), installed packages, 15 runs per hook each (3 alternating rounds × 5, after 1 warm-up iteration per round), ms p50 / p90. Rows: [`results/2026-11-17-three-way.csv`](results/2026-11-17-three-way.csv) (also has `lazy`, LanceDB lazy-loading alone).

| Hook | Side | wall | boot | load | db | git | work | exit |
|---|---|---|---|---|---|---|---|---|
| session-start | base | 416 / 588 | 19 / 40 | 173 / 257 | 7 / 9 | 134 / 247 | 34 / 53 | 37 / 55 |
| | final | 322 / 572 | 18 / 34 | 110 / 123 | 6 / 12 | 123 / 317 | 31 / 37 | 29 / 53 |
| user-prompt-submit | base | 323 / 527 | 17 / 23 | 154 / 219 | 9 / 30 | 37 / 92 | 55 / 97 | 30 / 65 |
| | final | 256 / 537 | 19 / 30 | 91 / 192 | 5 / 11 | 30 / 122 | 59 / 103 | 36 / 93 |
| post-tool-use, stored | base | 278 / 420 | 17 / 23 | 144 / 228 | 5 / 9 | 37 / 54 | 44 / 86 | 31 / 47 |
| | final | 273 / 389 | 16 / 24 | 6 / 11 | 5 / 8 | 32 / 115 | 135 / 211 | 35 / 76 |
| post-tool-use, dropped | base | 228 / 353 | 17 / 25 | 156 / 233 | 0 | 0 | 20 / 33 | 32 / 54 |
| | final | 73 / 117 | 18 / 39 | 6 / 13 | 0 | 0 | 4 / 10 | 32 / 64 |
| stop | base | 306 / 484 | 17 / 27 | 149 / 284 | 4 / 13 | 33 / 48 | 59 / 103 | 28 / 52 |
| | final | 241 / 300 | 18 / 25 | 94 / 127 | 4 / 7 | 30 / 56 | 56 / 77 | 36 / 47 |
| session-end | base | 238 / 308 | 18 / 26 | 129 / 150 | 0 | 0 | 55 / 78 | 26 / 59 |
| | final | 178 / 218 | 17 / 27 | 60 / 72 | 0 | 0 | 53 / 71 | 28 / 58 |
| pre-compact | base | 174 / 282 | 17 / 24 | 55 / 88 | 1 / 3 | 37 / 74 | 19 / 30 | 36 / 68 |
| | final | 172 / 209 | 15 / 25 | 65 / 79 | 2 / 3 | 33 / 55 | 17 / 24 | 28 / 42 |
| pre-tool-use, check off | base | 66 / 92 | 19 / 32 | 5 / 9 | 0 | 0 | 0 | 31 / 39 |
| | final | 59 / 95 | 18 / 27 | 5 / 11 | 0 | 0 | 0 | 31 / 60 |
| pre-tool-use, check on | base | 211 / 269 | 15 / 22 | 77 / 95 | 2 / 3 | 32 / 54 | 40 / 50 | 30 / 55 |
| | final | 193 / 313 | 18 / 22 | 75 / 96 | 2 / 5 | 31 / 60 | 42 / 73 | 27 / 55 |

PreCompact and PreToolUse never loaded LanceDB; their differences are the noise level of this run.

### PostToolUse only, more runs

LanceDB lazy-loading alone vs the final split, 40 runs each (4 alternating rounds × 10). Rows: [`results/2026-11-17-post-tool-use.csv`](results/2026-11-17-post-tool-use.csv).

| Call | wall p50 / p90, lazy only | wall p50 / p90, final |
|---|---|---|
| dropped (an excluded tool) | 125 / 153 | 48 / 61 |
| stored (an edit) | 165 / 202 | 158 / 189 |

For a stored call this measurement found no difference between loading the handler with the hook and importing it after the decision; 40 runs on a loaded machine can only rule out a large one.

### How many PostToolUse calls are dropped

`count-tool-calls.mjs --days 7 --max-files 100000` on one developer's machine (581 transcripts, the 7 days to 2026-11-17): 35,016 tool calls; 13.5% are tools the filter excludes by name; Bash is 76.0% of calls, and 36.4% of the 13,096 Bash results in the transcripts fall under the significance rule. Estimated share of calls dropped before the store: 41%. This depends on how that person works and is not reproducible elsewhere.

## Not done, and why

- **zod (about 23 ms per full hook):** its schemas are defined at module scope in about 30 core files; loading it later means restructuring them.
- **`git` in SessionStart (four synchronous calls, 123–134 ms p50 here):** not module loading, and caching the project root would change project detection. Follow-up candidate.
- **Splitting the other hooks:** they need SQLite and zod whatever they do. SessionEnd runs once per session.
- **Replacing better-sqlite3 (WASM, `node:sqlite`):** nothing here showed it to be the main cause of first-run failures, and it is a change to WAL, locking and concurrent-write safety.
