# RRF fusion and local cross-encoder reranking: offline evaluation (T12)

- Measured 2026-11-17 on `ccbc824` plus this branch.
- Question: should production ranking add reciprocal rank fusion (RRF, k=60) over the retrieval lanes, optionally followed by a local cross-encoder, as Hindsight and Graphiti do?
- Rule from the README roadmap: a ranking change is enabled only after retrieval/replay benchmarks support it. Related: #141 (candidate union, common lane scale; deferred until measurement supports it), #136 (FTS tail latency).
- **Outcome: no production change.** No arm showed a clear improvement on two or more datasets without a regression, and the cross-encoder is far over the latency budget. See [Decision](#decision).

`*` in the tables marks a 95% bootstrap interval that excludes 0. An interval that includes 0 is not evidence of equivalence. On small samples it only means the data cannot tell the arms apart.

## What is compared

### Qrels harness (`scripts/evaluate-rank-fusion.ts`)

The fixture's memories go into a throwaway SQLite store, which is the production FTS lane, and are embedded with the production embedder (`Xenova/multilingual-e5-small`). `current` is the production retriever called with the semantic daemon's options. Two separate comparisons follow.

- **Common pool (order only).** Every arm ranks the same set: the retriever's own filtered candidate list for the query (its debug candidates, capped at max(3·topK, 20) = 30).
  - `rrf` orders that set by RRF over each candidate's rank in the whole vector lane and in an FTS lane 1000 deep.
  - `rrf+ce` reranks the first 20 of that order with the cross-encoder.
  - `current` is the retriever's own order. Its returned list was the head of this set on every query of every dataset.
  - This set has already passed the retriever's quality filters and its score cliff, so it is small: p50 5, p90 12 on session-qrels; p50 6, p90 30 on LongMemEval_S; p50 2 on golden. Reordering it mostly decides which candidates take the first slots, not which candidates are available.
- **Pipeline comparison (candidates and order).** These arms build their own candidates, so they differ from `current` in candidate generation and filtering as well as in order. They do not isolate the effect of ranking.
  - `vector` and `keyword` are each lane alone (top 30).
  - `rrf` fuses those two lanes.
  - `rrf+ce` reranks the first 20 of `rrf` with the cross-encoder.

Both comparisons are scored **at each query's own budget**: k is the length of `current`'s list for that query, and nDCG is normalized by the ideal ranking at that k. Queries where `current` returned nothing are left out of these rows; the count is given per dataset. The pipeline arms are also scored at fixed k in the JSON report. Queries without expected ids (no-match traps) count forbidden memories within `current`'s budget.

### Hook replay (`scripts/replay-hook-grounding.ts --ranking-arms`)

The replay runs `selectHookInjection` on past hook traces in a store copy. Events after each trace are hidden. Each injected memory is scored against the session's later responses with the evaluator's `content_overlap_score`; a memory is grounded at 0.3. The ranking arms take the hook's eligible pool, reorder it, and then select by the hook's own rule:

1. Same budget: the number of candidates the hook's score cliff and `maxMemories` kept.
2. Answerability gate applied to that budgeted head, not to the whole pool. The gate's outcome depends on which candidates are in the head, so the number injected can differ from `current`.
3. Lesson slot reservation, as in the hook.

- `rrf` orders the pool by RRF over the hook's lanes: semantic, graduated, keyword, and lesson and episode evidence as lanes of their own.
- `rrf + cross-encoder` reranks the first 20 of that order.
- `hook order` runs the same machinery with the hook's own order. It reproduced `current` exactly on every turn of every store, which checks that the arms differ only in order.

### Cross-encoder choice

| preset | model | params | license | file | why |
|---|---|---|---|---|---|
| `mmarco-minilm` (primary) | `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`, ONNX `model_qint8_arm64` (arm64) / `model_quint8_avx2` (x64) | 118M | Apache-2.0 | 119 MB | smallest multilingual cross-encoder with an ONNX export that `@huggingface/transformers` 3.8.1 loads; trained on mMARCO (14 languages); the XLM-R vocabulary covers Korean |
| `bge-m3` (quality ceiling) | `onnx-community/bge-reranker-v2-m3-ONNX`, `onnx/model_quantized.onnx` (q8) | 568M | Apache-2.0 (from BAAI/bge-reranker-v2-m3) | 571 MB | strongest open multilingual reranker with an ONNX export; bounds what reranking can buy |

Rejected:
- `jinaai/jina-reranker-v2-base-multilingual`: CC-BY-NC-4.0.
- `Alibaba-NLP/gte-multilingual-reranker-base` and `dragonkue/bge-reranker-v2-m3-ko`: no ONNX export.
- `Xenova/ms-marco-MiniLM-L-6-v2`: English only.

Models are fetched from huggingface.co into `--model-cache` only when `--download-models` is passed; nothing is downloaded at install time. transformers.js does not record which hub revision it fetched, so every report carries a sha256 over the cached model files instead. The files measured here hash to:
- e5-small `a89c5cc413885d7c…`
- mmarco-minilm `999955e1c5e1b2d4…`
- bge-m3 `a67a1a6aedb444aa…`

## Data

| dataset | access | size | language |
|---|---|---|---|
| golden: `benchmarks/replay/golden-memory-usefulness-v1.json` | public, committed | 10 match queries + 8 no-match traps, 19 memories | ko/en |
| hook fixture: `benchmarks/replay/hook-grounding-fixture-v1.json` | public, committed | 8 traces, 25 events | en |
| LongMemEval_S: first 30 questions of `longmemeval_s_cleaned.json`, turn granularity, one shared corpus | public, downloaded | 30 queries, 15,150 turns | en |
| session-qrels: local Claude transcripts (368 files, read-only copies) through `scripts/generate-session-qrels.ts`, each prompt mapped to the answer that followed it | **private, local only** | 896 queries / 896 memories (28 duplicates not stored); first 150 for the bge-m3 comparison | 83% Korean |
| hook replay A–D: `.backup` copies of four local project stores | **private, local only** | A 180,936 events, B 110,853, C 2,583, D 16,377; up to 120 hook traces each (traces from 2026-11-04 to 11-16) | mostly Korean |

Private datasets cannot be reproduced outside this machine. Their numbers are reference measurements. Only aggregates left the runs, and the copies were deleted afterwards.

## Results

### Qrels, common pool (order only): Δ vs current at current's budget, %p (95% CI)

| arm | golden | session-qrels | session-qrels, first 150 | LongMemEval_S |
|---|---|---|---|---|
| queries scored (current empty) | 10 (0) | 818 (78) | 140 (10) | 30 (0) |
| current recall / nDCG | 0.600 / 0.870 | 0.249 / 0.202 | 0.321 / 0.262 | 0.800 / 0.648 |
| rrf Δrecall / ΔnDCG | +0.0 (+0.0..+0.0) / −2.9 (−8.7..+0.0) | +0.0 (−0.5..+0.5) / +0.2 (−0.5..+1.0) | −0.7 (−2.1..+0.0) / −0.5 (−2.3..+1.3) | −1.7 (−11.7..+8.3) / −5.2 (−15.6..+4.7) |
| rrf+ce, mmarco-minilm | −5.0 (−15.0..+0.0) / −10.0 (−30.0..+0.0) | −0.5 (−1.2..+0.1) / −1.0 (−2.0..−0.0) * | −2.1 (−5.0..+0.0) / −3.2 (−6.4..−0.4) * | −1.7 (−11.7..+8.3) / +3.4 (−5.3..+12.5) |
| rrf+ce, bge-m3 | +0.0 (+0.0..+0.0) / +0.0 (+0.0..+0.0) | not run | −0.7 (−2.1..+0.0) / +0.2 (−2.0..+2.4) | not run |

### Qrels, pipeline (candidates and order): Δ vs current at current's budget, %p (95% CI)

| arm | golden | session-qrels | session-qrels, first 150 | LongMemEval_S |
|---|---|---|---|---|
| vector | −5.0 (−20.0..+10.0) / −11.7 (−35.4..+9.9) | +5.1 (+1.8..+8.3) * / +3.3 (+0.8..+5.9) * | +5.7 (−2.9..+14.3) / +4.4 (−3.1..+11.3) | −23.3 (−43.3..+0.0) / −22.0 (−40.1..−4.4) * |
| keyword | −20.0 (−35.0..−5.0) * / −30.0 (−57.9..−7.9) * | +2.6 (+0.4..+4.8) * / +2.3 (+0.8..+3.9) * | −1.4 (−7.1..+4.3) / +0.4 (−3.6..+4.9) | −8.3 (−18.3..+0.0) / −11.7 (−21.9..−3.7) * |
| rrf | −10.0 (−25.0..+0.0) / −16.6 (−38.5..−2.1) * | +7.2 (+4.4..+10.0) * / +5.4 (+3.2..+7.5) * | +5.0 (−2.1..+12.1) / +3.9 (−1.7..+9.6) | −8.3 (−26.7..+10.0) / −10.0 (−25.0..+3.6) |
| rrf+ce, mmarco-minilm | −15.0 (−30.0..+0.0) / −22.1 (−50.0..+0.0) | +4.9 (+1.8..+7.8) * / +2.6 (+0.3..+4.9) * | +1.4 (−5.7..+9.3) / +0.3 (−6.4..+6.6) | −1.7 (−15.0..+11.7) / +3.3 (−6.9..+14.4) |
| rrf+ce, bge-m3 | +0.0 (−20.0..+20.0) / −6.1 (−30.0..+12.1) | not run | +10.7 (+4.3..+17.9) * / +8.7 (+3.0..+14.9) * | not run |

No-match traps (golden, 8 queries): `current` abstained on all 8, so no arm returned a forbidden memory within its budget. This says nothing about how the arms would behave on their own.

The two tables separate the questions. On session-qrels, the pipeline `rrf` gains (+7.2 %p recall) while the same fusion inside `current`'s candidates changes nothing (+0.0, −0.5..+0.5). So the pipeline gain comes with a different candidate set: candidates that the retriever's filters and score cliff remove, or that only the FTS lane finds. These runs do not separate how much each of those contributes, or whether those extra candidates would help or hurt an agent. Golden, whose queries test the retriever's stale-content and noise suppression, moves the other way.

### Hook replay

Counts are over all replayed turns that have later responses. "grounded turns" is the number of turns with at least one grounded injected memory. Mean overlap and grounded memories are per injected memory. Δ overlap is the paired difference of per-turn mean overlap against `current`, over turns where both arms injected a scored memory. An arm that injects on fewer turns is therefore not penalized in Δ; read Δ together with the turn counts.

| store | arm | turns injected | grounded turns | memories | mean overlap | grounded memories | Δ overlap vs current (95% CI) |
|---|---|---:|---:|---:|---:|---:|---|
| A (115 turns, selection reproduced 51.7%) | current | 69 | 18 | 114 | 0.113 | 20.2% | — |
| | rrf | 54 | 18 | 83 | 0.157 | 27.7% | +0.022 (−0.023..+0.075) |
| | rrf + cross-encoder | 39 | 9 | 65 | 0.117 | 20.0% | −0.016 (−0.081..+0.054) |
| B (117 turns, 66.7%) | current | 69 | 28 | 143 | 0.175 | 29.4% | — |
| | rrf | 54 | 21 | 89 | 0.185 | 31.5% | +0.018 (−0.021..+0.053) |
| | rrf + cross-encoder | 47 | 19 | 75 | 0.190 | 33.3% | +0.050 (+0.006..+0.099) * |
| C (55 turns, 92.9%) | current | 38 | 33 | 83 | 0.532 | 66.3% | — |
| | rrf | 36 | 31 | 74 | 0.623 | 78.4% | +0.066 (+0.016..+0.117) * |
| | rrf + cross-encoder | 16 | 14 | 31 | 0.452 | 67.7% | +0.083 (+0.024..+0.157) * |
| D (43 turns, 53.3%) | current | 24 | 8 | 51 | 0.092 | 15.7% | — |
| | rrf | 23 | 8 | 43 | 0.117 | 18.6% | +0.006 (−0.072..+0.068) |
| | rrf + cross-encoder | 20 | 7 | 32 | 0.142 | 21.9% | +0.021 (−0.037..+0.081) |
| fixture (8 turns, 37.5%) | all three | 6 | 5 | 6 | 0.643 | 83.3% | +0.000 (selection unchanged) |

- **Selection reproduced** is the share of turns where `current` in the replay injected exactly what the hook recorded at the time. Differences come from the approximations listed in the replay report (store-copy FTS statistics, memory levels, an in-process semantic lane).
- **Bias.** The responses were written after the historical injection, so overlap favors whatever was injected then. That advantages `current`.
- **Bias-free subset.** The turns where nothing was injected at the time are free of this bias. In the replay, per store and arm, only 0–11 of them received an injection (B: 0 for both ranking arms), too few to compare.
- **What reordering did.** Both ranking arms inject on fewer turns than `current` on every store. In the shared selection rule, the only step that can drop the whole budgeted head is the answerability gate, which does so when the head holds no answer-type memory (agent response, summary, lesson) on a non-continuation query. So the reordered heads more often held none. Neither arm increased the number of grounded turns on any store: rrf ties `current` on A and D and loses on B and C, and rrf + cross-encoder loses on all four.

### Latency

Apple M2 Max, 12 cores. The evaluation's own runs were sequential, but other work on the machine was not controlled. bge-m3 measured about 2.5× faster the day before (5 / 20 / 40 candidates p50 0.8 / 5.0 / 9.9 s), so treat its absolute times as approximate. Cross-encoder rows give wall time and process CPU per call.

| step | p50 | p90 | note |
|---|---:|---:|---|
| RRF of two lanes | < 0.1 ms | < 0.1 ms | every dataset |
| FTS lane, top 30 | 3.4 ms | 9.9 ms | session-qrels (896 memories); real stores: #136 (p90 0.6–3 s) |
| production retriever (`current`) | 25 ms | 58 ms | session-qrels |
| mmarco-minilm, 5 / 10 / 20 / 40 candidates | 109 / 305 / 657 / 1,243 ms | 187 / 394 / 787 / 1,480 ms | session-qrels sweep, 30 queries per size; CPU 0.6 / 1.3 / 2.8 / 5.7 s per call |
| mmarco-minilm per hook turn (≤ 20 candidates) | 189–376 ms | 425–1,246 ms | stores A–D |
| bge-m3, 5 / 10 / 20 / 40 candidates | 1,989 / 4,594 / 8,562 / 11,462 ms | 3,843 / 6,165 / 11,274 / 18,030 ms | session-qrels sweep; CPU 8.0 / 16.1 / 33.2 / 61.4 s per call |
| model load (warm cache) / first call | 0.5 s / 6–38 ms (mmarco-minilm); 0.7–0.8 s / 24–259 ms (bge-m3) | | first download: 21 s (mmarco-minilm), 105 s (bge-m3) |

The brief's budgets: a few tens of ms on the hook's lexical path, 15–20 ms for the semantic daemon (warm).

### Rerun deviation

- **Same process:** two passes gave identical metrics (max |Δ| 0.0000 on every qrels dataset).
- **Separate processes:** the e5 embeddings vary in the last bits, which reorders near-ties. On session-qrels, two processes differed by at most 0.12 %p on any non-cross-encoder metric. On the first 150 queries, the mmarco-minilm and bge-m3 runs differed by at most 0.71 %p on the metrics they share.
- **Hook replays:** reproduced exactly across processes.
- **Sampling error** (the bootstrap intervals above) is far larger than any of these.

## Decision

The stage-2 bar from the T12 brief has three parts. An arm must lift the main metric clearly beyond rerun deviation (about 3 %p) on two or more datasets. It must regress on none. Its added latency must fit the path's budget. Every number above was recomputed with the definitions in this document; none carries over from an earlier draft.

- **Cross-encoder (both models): does not qualify.**
  - Latency rules it out. At 20 candidates, mmarco-minilm takes 0.66 s wall and 2.8 s CPU per query, about 30× the daemon's warm budget. On the hook's own pools it adds 189–376 ms p50 per turn, many times the hook's lexical budget. Even 5 candidates take 109 ms.
  - mmarco-minilm's quality does not offset that. In the common pool it is lower than `current` on session-qrels (ΔnDCG −1.0 %p *, −3.2 %p * on the first 150). On the hook it cut the turns with a grounded memory on all four stores.
  - bge-m3: its one clear gain is in the pipeline comparison on the first 150 session-qrels queries (+10.7 %p recall *). Inside current's candidates it shows no clear difference (−0.7, +0.2 %p). Besides golden (no clear difference either), it was not run on more data, because one query takes 7 s and 35 CPU-seconds at 20 candidates.
- **RRF as a pipeline (`rrf`, own candidates): does not qualify.** It gains on session-qrels (+7.2 %p recall *), regresses on golden (nDCG −16.6 %p *), and is lower on LongMemEval_S (−8.3 / −10.0 %p, intervals include 0).
- **RRF as a reordering inside current's candidates (common pool, and the hook arm): no clear evidence of improvement.**
  - Common pool: on session-qrels the interval rules out a recall difference beyond ±0.5 %p; golden shows no clear difference; on LongMemEval_S it is lower, but the intervals include 0 (−1.7 / −5.2 %p).
  - Hook: Δ overlap is positive on all four stores but excludes 0 only on C (+0.066, 36 injected turns). It injects on fewer turns and never raises the count of grounded turns (A 18→18, B 28→21, C 33→31, D 8→8).

So T12 stops after stage 1. The evaluation code and this report land; production ranking is unchanged.

### What would reopen it

- A hook-replay rerun on enough bias-free turns (#141 asks for ≥ 100 per store) showing more grounded turns with a reordered pool. RRF itself costs nothing on the hook path, because the hook already runs every lane; the gate interaction above is what a change would have to handle.
- A reranker that scores 20 candidates in about 20 ms on CPU, roughly 30× faster than mmarco-minilm here. That needs a different class of model, not a smaller batch.
- The session-qrels gain appears only when the candidates differ (pipeline), not when only the order does (common pool). How it splits between candidates the filters remove and candidates only FTS finds is open. It is recorded on #141.

## Reproduce

Commands are split by data access. Everything writes aggregate-only output; `--format json` adds provenance (git SHA, fixture hash, every flag, model file hashes).

### Public data (reproducible anywhere)

```bash
mkdir -p /tmp/cml-models

# Golden fixture with mmarco-minilm. The first run downloads e5-small and the reranker.
npm run eval:rank-fusion -- --fixture benchmarks/replay/golden-memory-usefulness-v1.json \
  --model-cache /tmp/cml-models --download-models --format json > golden.json

# Golden with bge-m3 (its own first download).
npm run eval:rank-fusion -- --fixture benchmarks/replay/golden-memory-usefulness-v1.json \
  --model-cache /tmp/cml-models --reranker bge-m3 --repeat 1 --download-models --format json > golden-bge.json

# Hook replay on the committed fixture. The semantic lane is off for fixtures, so no embedder is needed.
npm run eval:hook-replay -- --ranking-arms --model-cache /tmp/cml-models --format json > hook-fixture.json

# LongMemEval_S subset (download per benchmarks/longmemeval/README.md).
tsx scripts/longmemeval-retrieval-smoke.ts --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity turn --retrieval-mode single --strategy fast --limit 30 --fixture-out /tmp/lme-turn-30.json
npm run eval:rank-fusion -- --fixture /tmp/lme-turn-30.json --label longmemeval-s-turn-30 \
  --model-cache /tmp/cml-models --format json > lme.json
```

### Private data (this machine only; reference numbers)

```bash
# Session qrels from read-only copies of local Claude transcripts. The fixture holds raw text; keep it out of the repo.
tsx scripts/generate-session-qrels.ts --sessions-dir <copy-of-transcripts> --out /tmp/session-qrels.json --ks 1,3,5,10
npm run eval:rank-fusion -- --fixture /tmp/session-qrels.json --label session-qrels \
  --model-cache /tmp/cml-models --repeat 1 --sweep --format json > sq.json
# Cross-process rerun check without the reranker.
npm run eval:rank-fusion -- --fixture /tmp/session-qrels.json --label session-qrels \
  --model-cache /tmp/cml-models --reranker none --repeat 1 --format json > sq-none.json
# The same first 150 queries with each reranker.
npm run eval:rank-fusion -- --fixture /tmp/session-qrels.json --label session-qrels-150 --limit 150 \
  --model-cache /tmp/cml-models --repeat 1 --format json > sq150.json
npm run eval:rank-fusion -- --fixture /tmp/session-qrels.json --label session-qrels-150 --limit 150 \
  --model-cache /tmp/cml-models --reranker bge-m3 --repeat 1 --sweep --format json > sq150-bge.json

# Hook replay on a store copy: sqlite3 events.sqlite ".backup ..." plus vectors/.
# HOME points at a scratch home whose .claude-code/memory/models holds e5-small (the semantic lane).
HOME=/tmp/cml-home tsx scripts/replay-hook-grounding.ts --store /tmp/copy/<hash> --label A --limit 120 \
  --ranking-arms --model-cache /tmp/cml-models --format json > hook-A.json
```
