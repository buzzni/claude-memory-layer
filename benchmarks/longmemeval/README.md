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

Hybrid session+turn replay retrieval, currently the default and best retrieval-only benchmark mode:

```bash
npm run eval:longmemeval:retrieval-smoke -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity session \
  --strategy fast \
  --format json \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-full-nonabs-hybrid-fast.json
```

Useful flags:

- `--limit N`: run a small sample first.
- `--retrieval-mode single|hybrid`: benchmark fixture mode. Default is `hybrid` session+turn replay retrieval; use `single` to reproduce the baseline session-only or turn-only retriever. `--hybrid-retrieval` is a shortcut.
- Do not confuse benchmark `--retrieval-mode hybrid` with production MCP/core `retrievalMode=session-event-hybrid`: the benchmark combines session and turn replay fixtures to score LongMemEval qrels, while production context packs rescue query-relevant sibling events from already-hit sessions.
- `--expand-user-facts`: append answer-independent user preference/fact summaries extracted from haystack text. The first rule-based version did not change full LongMemEval_S aggregate metrics.
- `--include-abstention`: include `*_abs` questions as strict no-match qrels.
- `--skip-abstention`: default; matches LongMemEval retrieval reporting, which skips abstention instances.
- `--global-corpus`: search all converted examples together. Default is isolated per question, which better matches LongMemEval.
- `--answers-out PATH`: write official evaluator hypothesis JSONL with one object per line: `{ "question_id": "...", "hypothesis": "..." }`.
- `--reader-command PATH`: required with `--answers-out`; executable wrapper for your reader model. CML sends JSON on stdin with `question_id`, `question`, optional `category`, and retrieved `contexts: [{ id, rank, content }]`. The wrapper must write the answer text to stdout.
- `--reader-arg VALUE`: repeatable extra argument passed to the reader command.
- `--fixture-out PATH`: inspect the converted replay fixture.
- `--no-per-query`: omit per-query rows for smaller output.

## Generate QA hypotheses for the official judge

The benchmark script can produce the LongMemEval hypothesis file consumed by `evaluate_qa.py`. The repo includes a reusable OpenAI-compatible reader wrapper at `scripts/longmemeval-openai-reader.ts`; it reads the retrieved-context JSON payload on stdin and writes only the final hypothesis text to stdout.

Use a small `--limit` first to verify credentials, cost, and provider behavior:

```bash
LONGMEMEVAL_READER_API_KEY="$OPENAI_API_KEY" \
LONGMEMEVAL_READER_MODEL=gpt-4o-mini \
npm run eval:longmemeval:retrieval-smoke -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity session \
  --retrieval-mode hybrid \
  --strategy fast \
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
  --format json \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-hybrid-reader-report.json \
  --answers-out /tmp/LongMemEval/reports/cml-longmemeval-s-hypotheses.jsonl \
  --reader-command npx \
  --reader-arg tsx \
  --reader-arg scripts/longmemeval-openai-reader.ts
```

Reader wrapper environment:

- `LONGMEMEVAL_READER_API_KEY` or `OPENAI_API_KEY`: required. `LONGMEMEVAL_READER_API_KEY` is preferred so the reader key can be separated from the official judge key.
- `LONGMEMEVAL_READER_BASE_URL`: optional OpenAI-compatible base URL; defaults to `https://api.openai.com/v1`.
- `LONGMEMEVAL_READER_MODEL`: optional reader model; defaults to `gpt-4o-mini`.
- `LONGMEMEVAL_READER_MAX_TOKENS`: optional positive integer; defaults to `256`.
- `LONGMEMEVAL_READER_CONTEXT_CHAR_LIMIT`: optional positive integer; defaults to `24000`.

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

## Metric mapping

LongMemEval retrieval reporting uses `recall_any`, `recall_all`, and `nDCG`.

CML replay report fields map as follows:

- `Hit@k` ≈ LongMemEval `recall_any@k`.
- `Recall@k` = fractional recall averaged across expected evidence IDs; this is stricter than `recall_any` and softer than `recall_all` for multi-evidence questions.
- `recall_all@k` is computed from per-query rows as `query.at[k].recall === 1`.
- `nDCG@k` is directly comparable in spirit, though CML uses graded qrels relevance value `3` for expected evidence IDs.

## Current smoke result

See `benchmarks/longmemeval/reports/2026-06-12-cml-longmemeval-s-retrieval-smoke.md`.

Summary from LongMemEval_S cleaned, 470 non-abstention questions:

| Mode | Memories | Query yield | Failed queries | Recall_any@10 / Hit@10 | Recall_all@10 | Fractional Recall@10 | nDCG@10 | MRR |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| session | 22,419 | 0.9191 | 115 | 0.7553 | 0.4894 | 0.6250 | 0.5560 | 0.6094 |
| turn | 231,606 | 0.8979 | 164 | 0.6511 | 0.3830 | 0.5087 | 0.4522 | 0.5068 |
| hybrid session+turn replay | 22,419 session memories + turn reranking | 0.9362 | 60 | 0.8723 | 0.6979 | 0.7917 | 0.7234 | 0.7558 |

Interpretation: CML's default session retrieval already retrieves at least one relevant evidence session for ~75.5% of LongMemEval_S non-abstention questions. Hybrid session+turn replay retrieval raises that to ~87.2% and raises all-evidence recall from ~48.9% to ~69.8%.

## Score interpretation

Because the committed report is still retrieval-only, the official LongMemEval QA score is **N/A until a reader run plus official judge output are recorded**.

Using the transparent proxy documented in the report, the current default hybrid mode implies:

- conservative all-evidence proxy: **64.5 / 100**
- middle fractional-recall proxy: **73.2 / 100**
- optimistic any-evidence upper bound: **80.6 / 100**

A practical retrieval-grounded estimate is therefore **about 65–73/100**, with an optimistic ceiling near **81/100** if a reader model can answer from partial evidence.

## Next implementation steps

1. Run a small `--limit` hypothesis smoke with real reader credentials.
2. Run full `--answers-out` on LongMemEval_S and evaluate with upstream `src/evaluation/evaluate_qa.py` when ready to spend reader + judge model tokens.
3. Compare QA against retrieval diagnostics to separate retriever misses from reader/reasoning misses.
4. Improve preference/user-fact retrieval beyond the initial lightweight rule-based extraction, which did not move aggregate metrics in this smoke.
