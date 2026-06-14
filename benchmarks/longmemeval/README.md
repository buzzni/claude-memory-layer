# LongMemEval × Claude Memory Layer Retrieval Evaluation

This benchmark adapter evaluates CML retrieval against the official LongMemEval data format without committing the LongMemEval dataset or raw chat histories into this repository.

## What this measures

Current support has two layers:

1. Read LongMemEval JSON examples.
2. Convert each example's haystack into a CML replay fixture.
3. Isolate retrieval per question, matching LongMemEval's per-question haystack setup.
4. Run the CML replay retriever.
5. Report Precision@k, fractional Recall@k, Hit@k / `recall_any`, `recall_all`, nDCG@k, MRR, and failure classes.
6. Optionally feed the retrieved CML context into an external reader/model wrapper and emit LongMemEval-compatible hypothesis JSONL.

The retrieval report is **not by itself** an official LongMemEval QA score. To get the official QA score, generate hypotheses with `--answers-out` and run LongMemEval's `src/evaluation/evaluate_qa.py` with an LLM judge.

## Dataset setup

Clone/download external assets outside the repo, for example:

```bash
rm -rf /tmp/LongMemEval
git clone --depth 1 https://github.com/xiaowu0162/LongMemEval.git /tmp/LongMemEval
mkdir -p /tmp/LongMemEval/data
curl -L --fail \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json \
  -o /tmp/LongMemEval/data/longmemeval_s_cleaned.json
```

The cleaned LongMemEval_S JSON is roughly 277MB. Do not commit it.

## Run retrieval-only smoke

Baseline session-level retrieval, official-style non-abstention only:

```bash
npm run eval:longmemeval:retrieval-smoke -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity session \
  --retrieval-mode single \
  --strategy fast \
  --format json \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-full-nonabs-session-fast.json
```

Baseline turn-level retrieval:

```bash
npm run eval:longmemeval:retrieval-smoke -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity turn \
  --retrieval-mode single \
  --strategy fast \
  --format json \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-full-nonabs-turn-fast.json
```

Hybrid session+turn replay retrieval, currently the default retrieval-only benchmark mode:

```bash
npm run eval:longmemeval:retrieval-smoke -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity session \
  --strategy fast \
  --format json \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-full-nonabs-hybrid-fast.json
```

Current best retrieval-only smoke with preference query expansion, safe temporal date boost, and tuned hybrid fusion weights:

```bash
npm run eval:longmemeval:retrieval-smoke -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity session \
  --retrieval-mode hybrid \
  --strategy fast \
  --expand-preference-queries \
  --temporal-date-boost \
  --hybrid-session-weight 1.75 \
  --hybrid-turn-weight 5 \
  --format json \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-hybrid-fast-expand-preference-temporal-date-boost-tuned.json
```

Useful flags:

- `--limit N`: run a small sample first.
- `--retrieval-mode single|hybrid`: benchmark fixture mode. Default is `hybrid` session+turn replay retrieval; use `single` to reproduce the baseline session-only or turn-only retriever. `--hybrid-retrieval` is a shortcut.
- Do not confuse benchmark `--retrieval-mode hybrid` with production MCP/core `retrievalMode=session-event-hybrid`: the benchmark combines session and turn replay fixtures to score LongMemEval qrels, while production context packs rescue query-relevant sibling events from already-hit sessions.
- `--expand-preference-queries`: append retrieval-only preference/context hint terms to `single-session-preference` questions. In the 2026-06-13 smoke this improved hybrid Hit@10 from `0.8723` to `0.8745` and nDCG@10 from `0.7234` to `0.7264` before weight tuning.
- `--expand-temporal-queries`: append question-date and generic temporal relation hint terms to `temporal-reasoning` questions. This is intentionally opt-in and **not recommended for scoring** after the 2026-06-13 full smoke: combined with the current best weights it reduced overall nDCG@10 from `0.7335` to `0.7066` and temporal nDCG@10 from `0.7405` to `0.6408`. Prefer `--temporal-date-boost` for temporal experiments.
- `--temporal-date-boost`: attach structured question-date metadata and rerank explicit relative-date temporal candidates by timestamp proximity only when candidate content overlaps extracted entity terms. It does **not** append date tokens to query text. On LongMemEval_S it was narrow but safe: 9/127 temporal questions were eligible, 2 reranked, Recall@10 stayed unchanged, and nDCG@10/MRR improved from `0.7335`/`0.7683` to `0.7340`/`0.7694`.
- `--hybrid-session-weight RATE` / `--hybrid-turn-weight RATE`: tune session-vs-turn rank fusion in benchmark hybrid mode. The best nDCG/MRR smoke so far uses `--hybrid-session-weight 1.75 --hybrid-turn-weight 5` plus `--temporal-date-boost`, improving nDCG@10 to `0.7340`, MRR to `0.7694`, and Recall_all@10 to `0.7021`. A recall-all-oriented preset, `1.25/1`, reached Recall_all@10 `0.7064` but reduced nDCG/MRR, so it is not the default recommended scoring command.
- `--expand-user-facts`: append answer-independent user preference/fact summaries extracted from haystack text directly into replay memory content. Current rule-based extraction is useful for fixture inspection, but it did **not** improve the full LongMemEval_S aggregate; prefer `--expand-preference-queries` for the current retrieval smoke.
- `--expand-user-facts-to-search-content`: append the same extracted summaries to private replay `searchContent` only, preserving raw reader context/report content. This validates indexing-stage key expansion plumbing, but the 2026-06-13 full smoke was also a scoring no-go: best tuned mode fell from Hit@10 `0.8745` / nDCG@10 `0.7335` to Hit@10 `0.8723` / nDCG@10 `0.7326`.
- `--include-abstention`: include `*_abs` questions as strict no-match qrels.
- `--skip-abstention`: default; matches LongMemEval retrieval reporting, which skips abstention instances.
- `--global-corpus`: search all converted examples together. Default is isolated per question, which better matches LongMemEval.
- `--answers-out PATH`: write official evaluator hypothesis JSONL with one object per line: `{ "question_id": "...", "hypothesis": "..." }`.
- `--reader-command PATH`: required with `--answers-out`; executable wrapper for your reader model. CML sends JSON on stdin with `question_id`, `question`, optional `category`, and retrieved `contexts: [{ id, rank, content }]`. The wrapper must write the answer text to stdout.
- `--reader-arg VALUE`: repeatable extra argument passed to the reader command.
- `--reader-timeout-ms N` or `LONGMEMEVAL_READER_TIMEOUT_MS`: per-question outer timeout for the reader command; defaults to `60000` ms. For slow wrappers such as Codex, set this higher than the wrapper's own model timeout.
- `--fixture-out PATH`: inspect the converted replay fixture.
- `--no-per-query`: omit per-query rows for smaller output.

## Generate QA hypotheses for the official judge

The benchmark script can produce the LongMemEval hypothesis file consumed by `evaluate_qa.py`. The repo includes two reusable reader wrappers:

- `scripts/longmemeval-openai-reader.ts`: OpenAI-compatible `/chat/completions` reader. Use this for the cleanest path to upstream official QA.
- `scripts/longmemeval-codex-reader.ts`: local `codex exec` reader for environments with Codex subscription auth but no `OPENAI_API_KEY` in the shell. This generates hypotheses, but it is not itself the unmodified upstream official evaluator.

Use a small `--limit` first to verify credentials, cost, and provider behavior:

```bash
LONGMEMEVAL_READER_API_KEY="$OPENAI_API_KEY" \
LONGMEMEVAL_READER_MODEL=gpt-4o-mini \
npm run eval:longmemeval:retrieval-smoke -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity session \
  --retrieval-mode hybrid \
  --strategy fast \
  --expand-preference-queries \
  --temporal-date-boost \
  --hybrid-session-weight 1.75 \
  --hybrid-turn-weight 5 \
  --limit 5 \
  --format json \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-hybrid-reader-smoke.json \
  --answers-out /tmp/LongMemEval/reports/cml-longmemeval-s-hypotheses-smoke.jsonl \
  --reader-command npx \
  --reader-arg tsx \
  --reader-arg scripts/longmemeval-openai-reader.ts
```

Then run the full hypothesis generation when ready to spend the reader-model tokens:

```bash
LONGMEMEVAL_READER_API_KEY="$OPENAI_API_KEY" \
LONGMEMEVAL_READER_MODEL=gpt-4o-mini \
npm run eval:longmemeval:retrieval-smoke -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity session \
  --retrieval-mode hybrid \
  --strategy fast \
  --expand-preference-queries \
  --temporal-date-boost \
  --hybrid-session-weight 1.75 \
  --hybrid-turn-weight 5 \
  --format json \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-hybrid-reader-report.json \
  --answers-out /tmp/LongMemEval/reports/cml-longmemeval-s-hypotheses.jsonl \
  --reader-command npx \
  --reader-arg tsx \
  --reader-arg scripts/longmemeval-openai-reader.ts
```

OpenAI-compatible reader wrapper environment:

- `LONGMEMEVAL_READER_API_KEY` or `OPENAI_API_KEY`: required. `LONGMEMEVAL_READER_API_KEY` is preferred so the reader key can be separated from the official judge key.
- `LONGMEMEVAL_READER_BASE_URL`: optional OpenAI-compatible base URL; defaults to `https://api.openai.com/v1`.
- `LONGMEMEVAL_READER_MODEL`: optional reader model; defaults to `gpt-4o-mini`.
- `LONGMEMEVAL_READER_MAX_TOKENS`: optional positive integer; defaults to `256`.
- `LONGMEMEVAL_READER_CONTEXT_CHAR_LIMIT`: optional positive integer; defaults to `24000`.

Codex subscription reader fallback:

```bash
LONGMEMEVAL_CODEX_TIMEOUT_MS=120000 \
LONGMEMEVAL_READER_TIMEOUT_MS=180000 \
npm run eval:longmemeval:retrieval-smoke -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity session \
  --retrieval-mode hybrid \
  --strategy fast \
  --expand-preference-queries \
  --temporal-date-boost \
  --hybrid-session-weight 1.75 \
  --hybrid-turn-weight 5 \
  --limit 5 \
  --format json \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-codex-reader-smoke-report.json \
  --answers-out /tmp/LongMemEval/reports/cml-longmemeval-s-codex-hypotheses-smoke.jsonl \
  --reader-command npx \
  --reader-arg tsx \
  --reader-arg scripts/longmemeval-codex-reader.ts
```

Codex reader environment:

- `LONGMEMEVAL_CODEX_BIN`: optional Codex executable path; defaults to `codex`.
- `LONGMEMEVAL_CODEX_MODEL`: optional Codex model override passed as `--model`.
- `LONGMEMEVAL_CODEX_SANDBOX`: optional Codex sandbox mode; defaults to `read-only`.
- `LONGMEMEVAL_CODEX_TIMEOUT_MS`: optional per-question timeout; defaults to `120000`.
- `LONGMEMEVAL_CODEX_CONTEXT_CHAR_LIMIT`: optional retrieved-context prompt budget; defaults to `24000`.
- When this wrapper is invoked through `eval:longmemeval:retrieval-smoke`, also set `LONGMEMEVAL_READER_TIMEOUT_MS` or `--reader-timeout-ms` to a value greater than `LONGMEMEVAL_CODEX_TIMEOUT_MS` so the outer benchmark process does not kill the wrapper first.

For Codex-subscription-only full runs, prefer the resumable batch runner instead of manually chaining `retrieval-smoke`, reader, and judge commands. It writes every completed hypothesis/judge row immediately and stores `checkpoint.json`, so interrupted 470-question LongMemEval_S runs can continue with `--resume` without duplicating completed `question_id`s:

```bash
LONGMEMEVAL_CODEX_TIMEOUT_MS=120000 \
LONGMEMEVAL_BATCH_READER_TIMEOUT_MS=180000 \
LONGMEMEVAL_BATCH_JUDGE_TIMEOUT_MS=180000 \
npm run eval:longmemeval:codex-batch -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --out-dir /tmp/LongMemEval/reports/cml-longmemeval-s-codex-full-batch \
  --granularity session \
  --retrieval-mode hybrid \
  --strategy fast \
  --expand-preference-queries \
  --temporal-date-boost \
  --hybrid-session-weight 1.75 \
  --hybrid-turn-weight 5 \
  --top-k 10
```

Resume the same run after a terminal/network/Codex interruption. `--resume` requires the existing `checkpoint.json` and validates its fingerprint, so use the same input path, managed output paths, and retrieval options; use a new `--out-dir` or `--force` to restart with different options. Do not combine `--resume` and `--force`:

```bash
LONGMEMEVAL_CODEX_TIMEOUT_MS=120000 \
LONGMEMEVAL_BATCH_READER_TIMEOUT_MS=180000 \
LONGMEMEVAL_BATCH_JUDGE_TIMEOUT_MS=180000 \
npm run eval:longmemeval:codex-batch -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --out-dir /tmp/LongMemEval/reports/cml-longmemeval-s-codex-full-batch \
  --resume
```

Default batch outputs inside `--out-dir`:

- `checkpoint.json`: current phase/status, completed reader/judge counts, managed file paths, and the retrieval-option fingerprint used to validate `--resume`.
- `retrieval-report.json` and `fixture.json`: reusable retrieval artifacts; `--resume` reuses them if present.
- `hypotheses.jsonl`: LongMemEval-compatible `{ "question_id", "hypothesis" }` rows.
- `eval-results-codex.jsonl`: Codex-compatible judge rows with `autoeval_label`.

The runner rejects duplicate/stale `question_id` rows in resumed hypothesis/judge JSONL files and refuses managed output path collisions or attempts to write over the input file.

Use `--skip-judge` when you only want resumable hypothesis generation for the upstream official evaluator. Label `eval-results-codex.jsonl` precisely as a Codex-compatible judge score, not as unmodified upstream LongMemEval QA.

The generated JSONL rows are intentionally minimal and official-compatible:

```jsonl
{"question_id":"...","hypothesis":"..."}
```

Then run the upstream evaluator from the cloned LongMemEval repo:

```bash
cd /tmp/LongMemEval
python src/evaluation/evaluate_qa.py \
  gpt-4o-mini \
  /tmp/LongMemEval/reports/cml-longmemeval-s-hypotheses.jsonl \
  /tmp/LongMemEval/data/longmemeval_s_cleaned.json
```

`evaluate_qa.py` requires the judge model credentials expected by LongMemEval (for example `OPENAI_API_KEY` for OpenAI-backed metric models). Treat this as a separate, cost-incurring official judge step: the reader wrapper only creates hypotheses; it does not grade them or produce an official LongMemEval QA score.

If only Codex subscription auth is available, you can run a Codex-compatible judge wrapper that reuses the upstream answer-check prompt through `codex exec`:

```bash
LONGMEMEVAL_CODEX_TIMEOUT_MS=120000 \
npm run eval:longmemeval:codex-judge -- \
  --hyp /tmp/LongMemEval/reports/cml-longmemeval-s-codex-hypotheses-smoke.jsonl \
  --ref /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-codex-hypotheses-smoke.jsonl.eval-results-codex
```

Label this result precisely as `Codex-compatible judge score`, not `official upstream LongMemEval QA`, because the unmodified upstream evaluator did not run.

## Metric mapping

LongMemEval retrieval reporting uses `recall_any`, `recall_all`, and `nDCG`.

CML replay report fields map as follows:

- `Hit@k` ≈ LongMemEval `recall_any@k`.
- `Recall@k` = fractional recall averaged across expected evidence IDs; this is stricter than `recall_any` and softer than `recall_all` for multi-evidence questions.
- `recall_all@k` is computed from per-query rows as `query.at[k].recall === 1`.
- `nDCG@k` is directly comparable in spirit, though CML uses graded qrels relevance value `3` for expected evidence IDs.

## Current smoke result

See `benchmarks/longmemeval/reports/2026-06-13-cml-longmemeval-s-retrieval-smoke.md`.

Summary from LongMemEval_S cleaned, 470 non-abstention questions:

| Mode | Memories | Query yield | Failed queries | Recall_any@10 / Hit@10 | Recall_all@10 | Fractional Recall@10 | nDCG@10 | MRR |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| session | 22,419 | 0.9191 | 115 | 0.7553 | 0.4894 | 0.6250 | 0.5560 | 0.6094 |
| turn | 231,606 | 0.8979 | 164 | 0.6511 | 0.3830 | 0.5087 | 0.4522 | 0.5068 |
| hybrid session+turn replay | 22,419 session memories + turn reranking | 0.9362 | 60 | 0.8723 | 0.6979 | 0.7917 | 0.7234 | 0.7558 |
| hybrid + preference query expansion | 22,419 session memories + turn reranking | 0.9383 | 59 | 0.8745 | 0.7000 | 0.7938 | 0.7264 | 0.7591 |
| hybrid + preference query expansion + tuned weights `1.75/5` | 22,419 session memories + turn reranking | 0.9383 | 59 | 0.8745 | 0.7021 | 0.7939 | 0.7335 | 0.7683 |
| hybrid + preference query expansion + temporal date boost + tuned weights `1.75/5` | 22,419 session memories + turn reranking | 0.9383 | 59 | 0.8745 | 0.7021 | 0.7939 | 0.7340 | 0.7694 |
| hybrid + preference query expansion + key-only user-fact `searchContent` + tuned weights `1.75/5` | 22,419 session memories + turn reranking | 0.9404 | 60 | 0.8723 | 0.7000 | 0.7918 | 0.7326 | 0.7676 |

Interpretation: CML's default session retrieval already retrieves at least one relevant evidence session for ~75.5% of LongMemEval_S non-abstention questions. Hybrid session+turn replay retrieval raises that to ~87.2% and raises all-evidence recall from ~48.9% to ~69.8%. The best current nDCG/MRR retrieval-only smoke is hybrid plus opt-in preference query expansion, temporal date boost, and tuned `session=1.75, turn=5` rank fusion: Hit@10 ~87.4%, all-evidence recall ~70.2%, fractional recall ~79.4%, nDCG@10 ~73.4%, and MRR ~76.9%. The temporal date boost is rank-only and narrow, so the retrieval-grounded score proxy is unchanged. Key-only user-fact `searchContent` expansion is implemented for isolated replay/indexing experiments, but it is not part of the current best scoring command because it slightly reduced full-smoke metrics.

## Score interpretation

Because the committed report is still retrieval-only, the official LongMemEval QA score is **N/A until a reader run plus official judge output are recorded**.

Using the transparent proxy documented in the report, the current best hybrid + preference-query-expansion + temporal-date-boost + tuned-weight mode implies:

- conservative all-evidence proxy: **64.9 / 100**
- middle fractional-recall proxy: **73.4 / 100**
- optimistic any-evidence upper bound: **80.8 / 100**

A practical retrieval-grounded estimate is therefore **about 65–73/100**, with an optimistic ceiling near **81/100** if a reader model can answer from partial evidence. The official QA score remains **N/A** until a reader + official judge run is recorded.

## Next implementation steps

1. For upstream official QA, provide API-compatible judge credentials and run full `--answers-out` on LongMemEval_S followed by `src/evaluation/evaluate_qa.py`.
2. For Codex-subscription-only environments, use `npm run eval:longmemeval:codex-batch -- ...` with `--out-dir` and `--resume` to expand beyond the current `--limit 5` smoke. A full Codex CLI path requires roughly 470 reader calls plus 470 judge calls, so checkpointed resume is recommended.
3. Compare QA against retrieval diagnostics to separate retriever misses from reader/reasoning misses.
4. Continue preference-category work beyond query expansion; current `--expand-user-facts` and key-only `--expand-user-facts-to-search-content` are no-gos for default scoring because they add/rank distractor noise and do not improve full LongMemEval_S aggregate metrics.
5. Continue temporal work beyond the safe `--temporal-date-boost` baseline: it improves rank metrics only for explicit relative-date questions, while broader ordering/multi-evidence temporal questions still require reasoning-aware retrieval or reader-side support.
