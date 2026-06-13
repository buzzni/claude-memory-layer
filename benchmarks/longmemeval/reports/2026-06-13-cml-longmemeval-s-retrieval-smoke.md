# CML × LongMemEval_S Retrieval-only Smoke Report

- Date: 2026-06-13
- Dataset: `longmemeval_s_cleaned.json` from `xiaowu0162/longmemeval-cleaned`
- Dataset location during run: `/tmp/LongMemEval/data/longmemeval_s_cleaned.json`
- Evaluation mode: retrieval-only, non-abstention questions only
- Question count: 470
- Retriever: CML replay retriever, `strategy=fast`
- Corpus mode: isolated per question, matching LongMemEval's haystack-per-question setup
- Raw dataset/report artifacts: kept under `/tmp/LongMemEval`, not committed

## Overall metrics

| Mode | Memories | Query yield | MRR | Failed queries | Recall_any@1 | Recall_any@5 | Recall_any@10 | Recall_all@10 | Fractional Recall@10 | nDCG@10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| session | 22,419 | 0.9191 | 0.6094 | 115 | 0.5362 | 0.7128 | 0.7553 | 0.4894 | 0.6250 | 0.5560 |
| turn | 231,606 | 0.8979 | 0.5068 | 164 | 0.4277 | 0.6085 | 0.6511 | 0.3830 | 0.5087 | 0.4522 |
| hybrid session+turn | 22,419 session memories + turn reranking | 0.9362 | 0.7558 | 60 | 0.6915 | 0.8468 | 0.8723 | 0.6979 | 0.7917 | 0.7234 |
| hybrid + preference query expansion | 22,419 session memories + turn reranking | 0.9383 | 0.7591 | 59 | 0.6957 | 0.8468 | 0.8745 | 0.7000 | 0.7938 | 0.7264 |

`--expand-user-facts` was also tested for hybrid mode after adding broader preference/context extraction. It did not improve full-dataset aggregate metrics and reduced preference-category recall when combined with query expansion, so the best current smoke uses `--expand-preference-queries` without `--expand-user-facts`.

## Baseline session failure breakdown

| failure_type | count |
|---|---:|
| hit | 230 |
| multi_evidence_partial | 125 |
| lexical_mismatch | 40 |
| no_candidate | 26 |
| answer_below_k | 25 |
| candidate_but_filtered | 24 |

## Hybrid session+turn failure breakdown

| failure_type | count |
|---|---:|
| hit | 328 |
| multi_evidence_partial | 82 |
| no_candidate | 24 |
| lexical_mismatch | 21 |
| candidate_but_filtered | 9 |
| answer_below_k | 6 |

## Hybrid + preference query expansion failure breakdown

| failure_type | count |
|---|---:|
| hit | 329 |
| multi_evidence_partial | 82 |
| no_candidate | 24 |
| lexical_mismatch | 20 |
| answer_below_k | 8 |
| candidate_but_filtered | 7 |

Hybrid retrieval reduced failed queries from 115 to 60 and converted many `multi_evidence_partial`, `lexical_mismatch`, `candidate_but_filtered`, and `answer_below_k` cases into hits.

## Baseline session category breakdown

| category | queries | Recall_any@10 | Recall_all@10 | Fractional Recall@10 | nDCG@10 | MRR | top failure |
|---|---:|---:|---:|---:|---:|---:|---|
| knowledge-update | 72 | 0.8333 | 0.4167 | 0.6250 | 0.5736 | 0.6902 | hit |
| multi-session | 121 | 0.8595 | 0.4545 | 0.6567 | 0.5933 | 0.6875 | hit |
| single-session-assistant | 56 | 0.7321 | 0.7321 | 0.7321 | 0.6258 | 0.5929 | hit |
| single-session-preference | 30 | 0.2000 | 0.2000 | 0.2000 | 0.1710 | 0.1611 | lexical_mismatch |
| single-session-user | 64 | 0.5313 | 0.5313 | 0.5313 | 0.3824 | 0.3343 | hit |
| temporal-reasoning | 127 | 0.8661 | 0.5039 | 0.6951 | 0.6582 | 0.7411 | hit |

## Hybrid session+turn category breakdown

| category | queries | Recall_any@10 | Recall_all@10 | Fractional Recall@10 | nDCG@10 | MRR | top failure |
|---|---:|---:|---:|---:|---:|---:|---|
| knowledge-update | 72 | 0.9861 | 0.8194 | 0.9028 | 0.8611 | 0.9178 | hit |
| multi-session | 121 | 0.8926 | 0.6116 | 0.7653 | 0.6947 | 0.7594 | hit |
| single-session-assistant | 56 | 0.8036 | 0.8036 | 0.8036 | 0.7136 | 0.6857 | hit |
| single-session-preference | 30 | 0.3333 | 0.3333 | 0.3333 | 0.2161 | 0.1801 | hit |
| single-session-user | 64 | 0.9063 | 0.9063 | 0.9063 | 0.8414 | 0.8199 | hit |
| temporal-reasoning | 127 | 0.9291 | 0.6457 | 0.7992 | 0.7375 | 0.7951 | hit |


## Hybrid + preference query expansion category breakdown

| category | queries | Recall_any@10 | Recall_all@10 | Fractional Recall@10 | nDCG@10 | MRR | notes |
|---|---:|---:|---:|---:|---:|---:|---|
| knowledge-update | 72 | 0.9861 | 0.8194 | 0.9028 | 0.8611 | 0.9178 | unchanged vs hybrid |
| multi-session | 121 | 0.8926 | 0.6116 | 0.7653 | 0.6947 | 0.7594 | unchanged vs hybrid |
| single-session-assistant | 56 | 0.8036 | 0.8036 | 0.8036 | 0.7136 | 0.6857 | unchanged vs hybrid |
| single-session-preference | 30 | 0.3667 | 0.3667 | 0.3667 | 0.2626 | 0.2318 | improved from Hit@10 0.3333 / nDCG 0.2161 |
| single-session-user | 64 | 0.9063 | 0.9063 | 0.9063 | 0.8414 | 0.8199 | unchanged vs hybrid |
| temporal-reasoning | 127 | 0.9291 | 0.6457 | 0.7992 | 0.7375 | 0.7951 | unchanged vs hybrid |

## Interpretation

- Baseline session retrieval is stronger than turn-only retrieval overall, but it misses too many all-evidence cases.
- Hybrid session+turn retrieval is the strongest default retrieval smoke mode.
- Opt-in `--expand-preference-queries` is the best current retrieval-only configuration for CML on LongMemEval_S. It raises `Recall_any@10` from 0.8723 to 0.8745, `Recall_all@10` from 0.6979 to 0.7000, nDCG@10 from 0.7234 to 0.7264, and reduces failed queries from 60 to 59.
- `single-session-preference` remains the weakest category, but preference query expansion improves it from Hit@10 0.3333 to 0.3667 and nDCG@10 0.2161 to 0.2626.
- `--expand-user-facts` is not currently recommended for scoring: broader extracted facts added distractor noise and did not improve full LongMemEval_S aggregate metrics.

## LongMemEval-style QA proxy

This is not an official QA score. Official LongMemEval QA requires answer generation and the official evaluator. The proxy below multiplies retrieval coverage by the previously used GPT-4o/Chain-of-Note reader upper-bound proxy `0.924`.

| Mode | Coverage assumption | Calculation | Proxy score |
|---|---|---:|---:|
| baseline session | optimistic: any evidence session in top 10 | 0.7553 × 0.924 | 69.8 / 100 |
| baseline session | middle: fractional evidence recall@10 | 0.6250 × 0.924 | 57.8 / 100 |
| baseline session | conservative: all evidence sessions in top 10 | 0.4894 × 0.924 | 45.2 / 100 |
| hybrid session+turn | optimistic: any evidence session in top 10 | 0.8723 × 0.924 | 80.6 / 100 |
| hybrid session+turn | middle: fractional evidence recall@10 | 0.7917 × 0.924 | 73.2 / 100 |
| hybrid session+turn | conservative: all evidence sessions in top 10 | 0.6979 × 0.924 | 64.5 / 100 |
| hybrid + preference query expansion | optimistic: any evidence session in top 10 | 0.8745 × 0.924 | 80.8 / 100 |
| hybrid + preference query expansion | middle: fractional evidence recall@10 | 0.7938 × 0.924 | 73.3 / 100 |
| hybrid + preference query expansion | conservative: all evidence sessions in top 10 | 0.7000 × 0.924 | 64.7 / 100 |

Practical estimate for current CML on LongMemEval_S before answer generation: **roughly 65–73/100** in the current best hybrid + preference-query-expansion retrieval mode, with an optimistic upper bound near **81/100** if the reader can answer from partial evidence. The official QA score remains **N/A** until a reader + official judge run is added.

## Reproduction commands

```bash
rm -rf /tmp/LongMemEval
git clone --depth 1 https://github.com/xiaowu0162/LongMemEval.git /tmp/LongMemEval
mkdir -p /tmp/LongMemEval/data /tmp/LongMemEval/reports
curl -L --fail \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json \
  -o /tmp/LongMemEval/data/longmemeval_s_cleaned.json

npm run eval:longmemeval:retrieval-smoke -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity session \
  --retrieval-mode single \
  --strategy fast \
  --format markdown \
  --no-per-query \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-session-fast.md

npm run eval:longmemeval:retrieval-smoke -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity turn \
  --retrieval-mode single \
  --strategy fast \
  --format markdown \
  --no-per-query \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-turn-fast.md

npm run eval:longmemeval:retrieval-smoke -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity session \
  --strategy fast \
  --format markdown \
  --no-per-query \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-hybrid-fast.md

npm run eval:longmemeval:retrieval-smoke -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity session \
  --retrieval-mode hybrid \
  --expand-preference-queries \
  --strategy fast \
  --format markdown \
  --no-per-query \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-hybrid-expand-preference-queries-fast.md

npm run eval:longmemeval:retrieval-smoke -- \
  --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity session \
  --expand-user-facts \
  --strategy fast \
  --format markdown \
  --no-per-query \
  --out /tmp/LongMemEval/reports/cml-longmemeval-s-hybrid-expand-fast.md
```
