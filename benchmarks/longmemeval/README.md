# LongMemEval × Claude Memory Layer Retrieval Evaluation

This benchmark adapter evaluates CML retrieval against the official LongMemEval data format without committing the LongMemEval dataset or raw chat histories into this repository.

## What this measures

Current support is **retrieval-only**:

1. Read LongMemEval JSON examples.
2. Convert each example's haystack into a CML replay fixture.
3. Isolate retrieval per question, matching LongMemEval's per-question haystack setup.
4. Run the CML replay retriever.
5. Report Precision@k, fractional Recall@k, Hit@k / `recall_any`, `recall_all`, nDCG@k, MRR, and failure classes.

It is **not yet** an official LongMemEval QA score because it does not generate answers and does not run `src/evaluation/evaluate_qa.py` with an LLM judge.

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

Hybrid session+turn retrieval, currently the default and best retrieval-only mode:

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
- `--retrieval-mode single|hybrid`: default is `hybrid` session+turn retrieval; use `single` to reproduce the baseline session-only or turn-only retriever. `--hybrid-retrieval` is a shortcut.
- `--expand-user-facts`: append answer-independent user preference/fact summaries extracted from haystack text. The first rule-based version did not change full LongMemEval_S aggregate metrics.
- `--include-abstention`: include `*_abs` questions as strict no-match qrels.
- `--skip-abstention`: default; matches LongMemEval retrieval reporting, which skips abstention instances.
- `--global-corpus`: search all converted examples together. Default is isolated per question, which better matches LongMemEval.
- `--fixture-out PATH`: inspect the converted replay fixture.
- `--no-per-query`: omit per-query rows for smaller output.

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
| hybrid session+turn | 22,419 session memories + turn reranking | 0.9362 | 60 | 0.8723 | 0.6979 | 0.7917 | 0.7234 | 0.7558 |

Interpretation: CML's default session retrieval already retrieves at least one relevant evidence session for ~75.5% of LongMemEval_S non-abstention questions. Hybrid session+turn retrieval raises that to ~87.2% and raises all-evidence recall from ~48.9% to ~69.8%.

## Score interpretation

Because this is retrieval-only, the official LongMemEval QA score is **N/A** until an answer-generation path and official judge run are added.

Using the transparent proxy documented in the report, the current default hybrid mode implies:

- conservative all-evidence proxy: **64.5 / 100**
- middle fractional-recall proxy: **73.2 / 100**
- optimistic any-evidence upper bound: **80.6 / 100**

A practical retrieval-grounded estimate is therefore **about 65–73/100**, with an optimistic ceiling near **81/100** if a reader model can answer from partial evidence.

## Next implementation steps

1. Add an answer-generation path that feeds retrieved CML context into a reader model.
2. Emit LongMemEval-compatible JSONL: `{ "question_id": "...", "hypothesis": "..." }`.
3. Run official `src/evaluation/evaluate_qa.py` from the cloned LongMemEval repo.
4. Compare QA against retrieval diagnostics to separate retriever misses from reader/reasoning misses.
5. Improve preference/user-fact retrieval beyond the initial lightweight rule-based extraction, which did not move aggregate metrics in this smoke.
