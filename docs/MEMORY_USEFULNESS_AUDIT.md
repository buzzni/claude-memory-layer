# Memory Usefulness Audit — Real Scenario Test

Date: 2026-05-05
Target: `claude-memory-layer` built CLI (`dist/cli/index.js`)
Isolation: temporary `HOME` and temporary project directories; no real `~/.claude` or `~/.claude-code/memory` was touched.
Raw evidence: [`MEMORY_USEFULNESS_AUDIT_RAW.json`](./MEMORY_USEFULNESS_AUDIT_RAW.json)

## 0. Follow-up improvements applied and re-verified

After the first audit exposed precision/UX issues, the following improvements were implemented and the same real scenario was rerun:

1. Query-time command artifact guard
   - Queries such as `local-command-stdout command-name opus` now return zero memories.
2. Technical identifier lexical guard
   - Out-of-domain project-scoped queries such as `DuckDB legacy storage migrate` in the alpha project now return zero memories instead of loosely related semantic matches.
   - The same query in the beta project still returns the beta DuckDB memory, proving useful exact matches are preserved.
3. Score cliff cutoff
   - The FTS query now returns the two actually relevant memories instead of including an unrelated dashboard provenance third result.
4. Transformer warning suppression
   - Known benign HuggingFace warnings (`Unknown model class "eurobert"`, `dtype not specified`) no longer appear in CLI import/stats/search output.
5. Disclosure reason taxonomy cleanup
   - Keyword-only disclosure now reports `keyword_match` without `semantic_match` when `vector=no`.

The raw evidence file was regenerated after these improvements.

## 1. Test goal

This audit tested whether the memory layer is useful in the way a coding assistant actually needs it:

1. It can import real Claude-style JSONL conversation history.
2. It retrieves durable engineering decisions when asked later with different wording.
3. It keeps project memories scoped, so unrelated project decisions do not leak.
4. It filters low-value command artifacts from imported sessions.
5. The progressive `search -> expand -> source` workflow gives enough provenance to trust and inspect a memory.
6. The shipped CLI works after build, not only through source-level tests.

## 2. Scenario design

Two temporary projects were created:

- `alpha-commerce-ai`: current/refactor project memories.
- `beta-legacy-duckdb`: unrelated project with a deliberately conflicting storage decision.

The crafted Claude JSONL sessions contained the following durable memories.

### Alpha memories

1. **Retrieval disclosure lifecycle rule**
   - `expand` / `source` drill-down routes must stay lightweight.
   - They should not call full `MemoryService.initialize()` because that can start embedders, vector workers, or shared promotion machinery.

2. **SQLite FTS rebuild fix**
   - The `no such column: T.event_id` failure is fixed by making `events_fts` an internal FTS5 table with `content` and `event_id UNINDEXED`.
   - Rebuild by dropping/recreating FTS and triggers.

3. **Shared dashboard provenance decision**
   - Shared results should render as `shared_troubleshooting` provenance.
   - Show `sourceProjectHash`, `sourceEntryId`, `topics`, `rootCause`, `solution`, and state that no local raw event exists.

4. **Noise artifact**
   - `<command-name>/model</command-name>` + `<local-command-stdout>opus</local-command-stdout>` was included to verify command artifacts are not stored as useful user prompts.

### Beta memory

- A conflicting legacy decision: beta should keep DuckDB and not migrate to SQLite.
- This tests project scoping against alpha queries.

## 3. Commands executed

All commands used a temporary `HOME`.

```bash
node dist/cli/index.js import --session <alpha-session.jsonl> --project <alpha-project> --verbose
node dist/cli/index.js import --session <beta-session.jsonl> --project <beta-project> --verbose
node dist/cli/index.js stats --project <alpha-project>
node dist/cli/index.js search "disclosure expand source initialize vector workers lightweight" --project <alpha-project> --top-k 5 --min-score 0.1
node dist/cli/index.js search "T.event_id FTS rebuild internal table trigger event_id" --project <alpha-project> --top-k 5 --min-score 0.1
node dist/cli/index.js search "shared_troubleshooting rootCause solution sourceProjectHash" --project <alpha-project> --top-k 5 --min-score 0.1
node dist/cli/index.js search "local-command-stdout command-name opus" --project <alpha-project> --top-k 5 --min-score 0.1
node dist/cli/index.js search "DuckDB legacy storage migrate" --project <alpha-project> --top-k 5 --min-score 0.1
node dist/cli/index.js search "DuckDB legacy storage migrate" --project <beta-project> --top-k 5 --min-score 0.1
node dist/cli/index.js search "T.event_id FTS rebuild internal table" --project <alpha-project> --top-k 3 --min-score 0.1 --disclosure --strategy fast
node dist/cli/index.js expand <first-disclosure-result-id> --project <alpha-project> --window-size 2
node dist/cli/index.js source <first-disclosure-result-id> --project <alpha-project>
```

## 4. Verified working behavior

### 4.1 Import works and filters command-artifact noise

Alpha import result:

- Total messages: 7
- Imported prompts: 3
- Imported responses: 3
- Skipped duplicates/noise: 1
- Embeddings queued: 6

This is exactly expected: the three real user prompts and three assistant durable responses were imported, while the local-command artifact was skipped.

Beta import result:

- Total messages: 2
- Imported prompts: 1
- Imported responses: 1
- Embeddings queued: 2

### 4.2 Project-scoped markdown mirror writes to the target project

The audit verified markdown mirrors were written under each temporary target project, not under the `claude-memory-layer` repository working directory.

Examples:

- `<alpha-project>/memory/_index.md`
- `<alpha-project>/memory/agent_response/uncategorized/2026-05-05.md`
- `<alpha-project>/memory/user_prompt/uncategorized/2026-05-05.md`

`repo_memory_exists = false`, so the previous accidental `memory/` artifact in the repository did not recur.

### 4.3 Stats reflect imported memory and vectors

Alpha stats:

- Total Events: 6
- Vector Count: 6
- Memory Levels: `L0: 6`

This proves import, SQLite storage, embedding queue processing, and vector count all reached a coherent state.

### 4.4 Retrieval finds the right durable decisions

#### Query: lifecycle rule for disclosure expand/source

Top result:

- `agent_response`
- Score: `1.000`
- Correct memory: lightweight drill-down; do not call full `MemoryService.initialize()` for expand/source.

This is highly useful: it recovers a nuanced architectural constraint from a later query.

#### Query: SQLite FTS `T.event_id` fix

Top result:

- `agent_response`
- Score: `0.978`
- Correct memory: internal FTS5 table with `event_id UNINDEXED`, rebuild by dropping/recreating FTS and triggers.

Second result:

- Original user question, score `0.905`.

This is also useful. It retrieves both the answer and the originating question.

#### Query: dashboard shared provenance

Top and only result:

- `agent_response`
- Score: `1.000`
- Correct memory: `shared_troubleshooting`, `sourceProjectHash`, `sourceEntryId`, `topics`, `rootCause`, `solution`.

This is excellent for product/UX decision recall.

### 4.5 Project scoping works for cross-project conflict

Alpha query for `DuckDB legacy storage migrate` did **not** return the beta DuckDB memory and, after the technical-identifier guard, returned **zero** alpha-project false positives.

Beta query for the same phrase returned the beta DuckDB prompt/answer with high scores:

- `user_prompt`, score `1.000`
- `agent_response`, score `0.922`

So strict project isolation is working at the storage/retrieval boundary.

### 4.6 Progressive disclosure is useful and inspectable

Disclosure query for FTS returned:

```text
Meta: total=2 vector=no keyword=yes fallback=no
1. [source] Agent response
   id: event:<uuid>
   score: 1.000
   reasons: keyword_match, recent_relevance, continuity_link
```

`expand` on the first result returned surrounding turn context:

- previous lifecycle decision
- target FTS answer
- neighboring dashboard provenance question/answer

`source` returned raw event details:

- sourceRef
- sourceType: `imported_history`
- eventIds
- full raw event content
- session id
- canonical key

This is a strong product surface: the model/user can inspect not just the snippet but why the memory exists and what conversation context surrounded it.

## 5. Problems discovered

### P0 — Built CLI initially failed because of duplicate `fileURLToPath`

The first audit run found that `node dist/cli/index.js ...` failed before any memory command ran:

```text
SyntaxError: Identifier 'fileURLToPath' has already been declared
```

Cause:

- `scripts/build.ts` injects an esbuild banner that declares `fileURLToPath`.
- `src/apps/server/index.ts` also imported `fileURLToPath` under the same identifier.
- Because CLI bundles server/dashboard code, the duplicate identifier broke the built CLI.

Fix applied:

- Changed server import to alias the identifier:
  - `import { fileURLToPath as fileUrlToPath } from 'url';`
  - `fileUrlToPath(import.meta.url)`

Verification:

- `npm run build`
- `node dist/cli/index.js --help`
- full memory audit rerun successfully.

### P1 — HuggingFace/transformer warnings were noisy in normal CLI flows — fixed

The first run emitted known benign transformer warnings on import/stats/search. The improved run no longer shows these warnings in the raw CLI outputs.

Implemented:

- Known benign warnings are suppressed around lazy `@huggingface/transformers` pipeline loading/initialization.

Remaining recommendation:

- Consider further reducing embedder initialization on pure stats/read paths, but the user-facing warning noise is fixed.

### P1 — Search returned plausible but irrelevant results on no-match artifact queries — fixed

Noise query:

```bash
search "local-command-stdout command-name opus" --project alpha --top-k 5 --min-score 0.1
```

Improved result:

- `Confidence: none`
- `Total local memories found: 0`

Implemented:

- Query-time command artifact guard for `local-command-stdout`, `local-command-stderr`, `command-name`, and `command-message` patterns.
- Regression coverage in `tests/core/retriever-strategy-scope.test.ts`.

### P1 — Out-of-domain project-scoped queries returned irrelevant in-project memories — fixed

Alpha query:

```bash
search "DuckDB legacy storage migrate" --project alpha
```

Improved result:

- `Confidence: none`
- `Total local memories found: 0`

Beta query for the same phrase still returns the correct beta DuckDB memory, so the guard improves precision without breaking positive technical-identifier recall.

Implemented:

- Technical identifier lexical guard for terms such as `DuckDB`, `T.event_id`, and `sourceProjectHash`.
- Regression coverage proving false positives are filtered while exact technical matches are preserved.

### P2 — Top-k included adjacent but not always relevant memories — improved

For the FTS query, top 1 and top 2 were excellent, but the first run included an unrelated dashboard provenance third result.

Improved result:

- The same FTS query now returns only the two directly relevant memories.

Implemented:

- A conservative score-cliff cutoff after reranking/scope filtering.

Remaining recommendation:

- For prompt injection, continue to prefer `confidence=high` results and keep suggested results separated from injected context.

### P2 — Progressive disclosure reason labels were misleading in keyword-only mode — fixed

Disclosure meta says:

```text
vector=no keyword=yes
```

Improved result reasons now say:

```text
keyword_match, recent_relevance, continuity_link
```

Implemented:

- Disclosure reason mapping omits `semantic_match` when vector/deep retrieval was not used.
- Regression coverage in `tests/core/retrieval-disclosure-service.test.ts`.

## 6. Remaining next improvements, prioritized

The originally identified precision/UX items have mostly been addressed in this slice. Remaining useful follow-ups:

### Priority 1 — Further reduce unnecessary embedder initialization

Known warning noise is now suppressed, but read paths may still initialize the embedder.

Improve:

- `stats` should use a lightweight/read-only service path when possible.
- `search --strategy fast` should avoid embedder initialization until deep/vector search is actually needed.

Expected impact:

- Faster stats/search commands.
- Lower CPU/model-load overhead.

### Priority 2 — Make prompt-injection policy stricter than CLI search

CLI search can show suggested results, but prompt injection should be more conservative.

Improve:

- Inject only high-confidence memories by default.
- Keep suggested results visible in CLI/dashboard but separate from automatic context injection.

Expected impact:

- Lower memory hallucination risk in real Claude hooks.

### Priority 3 — Add more real-world benchmark scenarios

This audit used crafted sessions. Add broader replay suites:

- 20-50 actual anonymized coding sessions.
- Known-answer queries and negative/no-match queries.
- Precision@k / recall@k tracking across refactors.

## 7. Overall verdict

The memory layer is already useful for durable engineering recall:

- It successfully remembered architectural constraints, bug-fix details, and UI provenance decisions.
- It recovered the right memories from later, differently phrased queries.
- Project scoping prevented a deliberately conflicting beta project memory from leaking into alpha search.
- Progressive disclosure gave enough context and raw source provenance to trust a retrieved memory.

After the follow-up fixes, the biggest remaining quality issue is no longer basic precision; it is **operational efficiency and broader benchmarking**:

- Avoid unnecessary embedder/model initialization on pure read paths where possible.
- Keep automatic prompt injection stricter than exploratory CLI/dashboard search.
- Expand the benchmark from crafted scenarios to larger anonymized real-session replay suites.
