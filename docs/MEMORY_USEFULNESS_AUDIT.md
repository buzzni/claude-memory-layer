# Memory Usefulness Audit — Real Scenario Test

Date: 2026-05-05
Target: `claude-memory-layer` built CLI (`dist/cli/index.js`)
Isolation: temporary `HOME` and temporary project directories; no real `~/.claude` or `~/.claude-code/memory` was touched.
Raw evidence: [`MEMORY_USEFULNESS_AUDIT_RAW.json`](./MEMORY_USEFULNESS_AUDIT_RAW.json)

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

Alpha query for `DuckDB legacy storage migrate` did **not** return the beta DuckDB memory. It returned only alpha-project memories.

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
   reasons: semantic_match, keyword_match, recent_relevance, continuity_link
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

### P1 — HuggingFace/transformer warnings are noisy in normal CLI flows

Every import/stats/search emitted:

```text
Unknown model class "eurobert", attempting to construct from base class.
dtype not specified for "model". Using the default dtype (fp32) for this device (cpu).
```

Functionally this did not fail. Import and search worked. But the warnings appear on every user-facing command, including read-only-looking commands like `stats` and `search`, which makes the product feel unstable.

Recommendation:

- Suppress or de-duplicate known benign transformer warnings in CLI output.
- Consider initializing the embedder only when vector search / embedding maintenance is actually needed; stats should not need to instantiate the HF model just to report counts.

### P1 — Search can return semantically plausible but irrelevant results on no-match queries

Noise query:

```bash
search "local-command-stdout command-name opus" --project alpha --top-k 5 --min-score 0.1
```

Expected:

- No results, because the command artifact was filtered from import.

Actual:

- One unrelated dashboard provenance memory, score `0.833`, confidence `suggested`.

This means imported noise is filtered, but query-time artifact/noise strings can still produce vector false positives.

Recommendation:

- Add query-time artifact detection using the same `isClaudeLocalCommandArtifact()` style logic.
- For queries dominated by XML-ish command tags, either return no results or force keyword-only retrieval.
- Add a regression test: artifact query against a clean project with no artifact memories should return zero results.

### P1 — Out-of-domain project-scoped queries return irrelevant in-project memories

Alpha query:

```bash
search "DuckDB legacy storage migrate" --project alpha --top-k 5 --min-score 0.1
```

Good:

- It did not leak beta memory. Project scoping works.

Bad:

- It returned five alpha memories, none actually about DuckDB.
- Highest score was `0.744`, so even default `minScore=0.7` could still return at least one irrelevant result.

Recommendation:

- Add a lexical-overlap or technical-token guard for high-specificity queries.
- If a query contains exact technical identifiers (`DuckDB`, `T.event_id`, `sourceProjectHash`), require at least one exact/keyword match for high confidence unless vector score is extremely high and corroborated.
- Calibrate default confidence/threshold so no-match queries become “no relevant memories found” rather than forced suggestions.

### P2 — Top-k includes adjacent but not always relevant memories

For the FTS query, top 1 and top 2 were excellent, but top 3 included dashboard provenance because it had general architecture/token similarity.

Recommendation:

- Keep top-k small by default for prompt injection.
- Consider MMR/diversity plus a score cliff cutoff: if score drops significantly after top results, stop returning additional memories.
- For prompt injection, prefer `confidence=high` results only, with suggested results separated from injected context.

### P2 — Progressive disclosure reason labels are slightly misleading in keyword-only mode

Disclosure meta said:

```text
vector=no keyword=yes
```

But result reasons included:

```text
semantic_match, keyword_match, recent_relevance, continuity_link
```

When vector is not used, `semantic_match` can confuse users/developers.

Recommendation:

- In disclosure reason mapping, omit `semantic_match` when `meta.usedVector === false` or when the retrieval trace shows fast keyword mode only.
- Preserve `keyword_match` and `continuity_link`.

## 6. Suggested next improvements, prioritized

### Priority 1 — Query-time noise/out-of-domain guard

Implement a small guard before vector retrieval:

- If query matches local-command artifacts, return empty result or force exact keyword search.
- If query contains high-specificity identifiers and keyword overlap is zero, avoid high-confidence semantic-only results.

Expected impact:

- Less irrelevant prompt injection.
- Better trust in memory suggestions.

### Priority 2 — Lightweight stats/search initialization

Current CLI read commands instantiate the embedder and print transformer warnings.

Improve:

- `stats` should use lightweight/read-only service path when possible.
- `search --strategy fast` or keyword-first paths should avoid embedder initialization until vector search is actually needed.
- Suppress known benign model warnings if initialization is unavoidable.

Expected impact:

- Faster and cleaner CLI/dashboard use.
- Less user anxiety about broken model loading.

### Priority 3 — Disclosure reason taxonomy cleanup

Make reasons match actual retrieval mechanics:

- `semantic_match` only when vector/semantic retrieval was actually used.
- `keyword_match` for FTS/fast mode.
- Consider showing `trace: fast keyword` or `trace: vector + keyword` in CLI output.

Expected impact:

- More trustworthy provenance and debugging.

### Priority 4 — No-match calibration / score cliff cutoff

Add score calibration:

- Default no-match queries should return zero or low-confidence results, not several loosely related memories.
- Apply score cliff cutoff for prompt injection and CLI display.

Expected impact:

- Higher precision, lower memory hallucination risk.

## 7. Overall verdict

The memory layer is already useful for durable engineering recall:

- It successfully remembered architectural constraints, bug-fix details, and UI provenance decisions.
- It recovered the right memories from later, differently phrased queries.
- Project scoping prevented a deliberately conflicting beta project memory from leaking into alpha search.
- Progressive disclosure gave enough context and raw source provenance to trust a retrieved memory.

The biggest remaining quality issue is not storage or basic retrieval. It is **precision control**:

- Avoid returning unrelated vector matches for command artifacts or out-of-domain technical queries.
- Make read/search paths less noisy and less eager to initialize embeddings.
- Make disclosure reasons reflect actual retrieval mode.
