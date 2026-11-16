# RRF fusion and local cross-encoder reranking: offline evaluation (T12)

- Date: 2026-11-17, base `4b98172`
- Question: should the production ranking add reciprocal rank fusion (RRF, k=60) over the retrieval lanes, optionally followed by a local cross-encoder, as Hindsight and Graphiti do?
- Rule from the README roadmap: a ranking change is enabled only after retrieval/replay benchmarks support it. Related: #141 (candidate union, common lane scale, deferred until measurement supports it), #136 (FTS tail latency).
- **Outcome: no production change.** No arm met the bar on two datasets without a regression, and the cross-encoder is one to two orders of magnitude over the latency budget. Details under [Decision](#decision).

## Arms

Every arm ranks the same candidates for the same query.

| arm | qrels harness (`scripts/evaluate-rank-fusion.ts`) | hook replay (`scripts/replay-hook-grounding.ts --ranking-arms`) |
|---|---|---|
| current | production retriever with the semantic daemon's options | `selectHookInjection` as the hook runs it |
| rrf | RRF of the vector lane (top 30) and the FTS lane (top 30), no filters | — |
| rrf-filtered | the rrf order, kept to the candidates the retriever's scope and quality filters pass | RRF over the hook lanes (semantic, graduated, keyword, lesson, episode), kept to the hook's eligible pool |
| rrf+ce | RRF head (20) reranked by the cross-encoder | the hook's RRF order, head (20) reranked by the cross-encoder |

The qrels harness also reports the vector and keyword lanes alone. The hook-replay ranking arms inject exactly as many memories as `current` did for the turn, so they differ only in which memories fill the budget; the hook's abstention and budget decisions are unchanged. The qrels "same budget" rows apply the same rule: every arm is cut to the length of current's list for that query.

### Cross-encoder choice

| preset | model | params | license | file | why |
|---|---|---|---|---|---|
| `mmarco-minilm` (primary) | `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`, ONNX `model_qint8_arm64` / `model_quint8_avx2` | 118M | Apache-2.0 | 119 MB | smallest multilingual cross-encoder with an ONNX export that `@huggingface/transformers` 3.8.1 loads; mMARCO training (14 languages), XLM-R vocabulary covers Korean |
| `bge-m3` (quality ceiling) | `onnx-community/bge-reranker-v2-m3-ONNX`, `model_quantized.onnx` (q8) | 568M | Apache-2.0 (BAAI/bge-reranker-v2-m3) | 571 MB | strongest open multilingual reranker with an ONNX export; bounds what reranking can buy |

Rejected: `jinaai/jina-reranker-v2-base-multilingual` (CC-BY-NC-4.0), `Alibaba-NLP/gte-multilingual-reranker-base` and `dragonkue/bge-reranker-v2-m3-ko` (no ONNX export; custom architecture or full-size weights only), `Xenova/ms-marco-MiniLM-L-6-v2` (English only).
Both models are downloaded from huggingface.co into the directory passed as `--model-cache`, only with `--download-models`; nothing is fetched at install time.

## Data

| dataset | kind | size | language |
|---|---|---|---|
| golden | committed fixture `benchmarks/replay/golden-memory-usefulness-v1.json` | 10 match queries + 8 no-match traps, 19 memories | ko/en |
| session-qrels | local Claude transcripts (366 files, read-only copies), `scripts/generate-session-qrels.ts`: prompt → the answer that followed it | 874 queries, 874 memories | 83% Korean |
| LongMemEval_S | first 30 questions of `longmemeval_s_cleaned.json`, turn granularity, one shared corpus | 30 queries, 15,150 turns | English |
| hook replay A–D | `.backup` copies of four local project stores; 120 sampled hook traces (all traces for C, D) | A 181k events, B 111k, C 2.3k, D 16k | mostly Korean |

Only aggregates leave the run. Store copies, transcripts, and the downloaded dataset stayed in a scratch directory.

## Results

### Qrels: same budget as current (recall and nDCG at current's list length, Δ in %p with paired 95% bootstrap CI)

| arm | golden Δrecall / ΔnDCG | session-qrels Δrecall / ΔnDCG | LongMemEval Δrecall / ΔnDCG |
|---|---|---|---|
| current (absolute) | 0.600 / 0.785 | 0.229 / 0.184 | 0.800 / 0.648 |
| vector | −5.0 (−20..+10) / −9.5 (−30..+10) | **+5.4 (+2.5..+8.4)** / **+3.7 (+1.3..+6.1)** | −23.3 (−43..0) / **−22.0 (−40..−4)** |
| keyword | **−20.0 (−35..−5)** / **−25.7 (−49..−8)** | +2.5 (+0.5..+4.6) / +2.3 (+0.8..+3.8) | −8.3 (−18..0) / **−11.7 (−22..−4)** |
| rrf | −10.0 (−25..0) / **−14.5 (−31.5..−2.1)** | **+7.3 (+4.8..+10.0)** / **+5.6 (+3.6..+7.8)** | −8.3 (−27..+10) / −10.0 (−25..+4) |
| rrf-filtered | 0.0 (0..0) / −2.9 (−8.7..0) | 0.0 (−0.5..+0.5) / +0.4 (−0.2..+1.1) | −1.7 (−12..+8) / −4.6 (−15..+5) |
| rrf+ce (mmarco-minilm) | −15.0 (−30..0) / −17.9 (−39..0) | +4.7 (+2.2..+7.6) / +3.1 (+1.0..+5.4) | −1.7 (−15..+12) / +3.3 (−7..+14) |
| rrf+ce (bge-m3) | 0.0 (−20..+20) / −3.9 (−24..+12) | **+10.7 (+4.0..+18.0)** / **+9.4 (+4.0..+15.2)** (first 150 queries; mmarco-minilm on the same 150: +2.0 / +2.6, n.s.) | not run |

Bold: the interval excludes 0. No-match traps (golden, 8 queries): no arm returned a forbidden memory within current's budget; current abstained on all 8.

Unbudgeted top-k (recall@10): golden current 0.600, rrf 0.900; session-qrels current 0.229, rrf 0.404; LongMemEval current 0.800, rrf 0.817. The production retriever's lists are short because its filters and score cliff abstain, so unbudgeted recall flatters every arm without them. That is why the decision uses the same-budget rows.

### Hook replay: paired difference in mean overlap per turn vs current (95% bootstrap CI)

Overlap is the evaluator's `content_overlap_score` of each injected memory against the session's later responses; a memory is grounded at 0.3.

| store | turns (injected) | current mean overlap | rrf-filtered Δ (arm `rrf` in the replay output) | rrf+ce (mmarco-minilm) Δ | selection changed (rrf / rrf+ce) |
|---|---|---:|---|---|---|
| A | 120 (69) | 0.113 | +0.020 (−0.016..+0.056) | +0.001 (−0.044..+0.042) | 19 / 29 |
| B | 120 (62) | 0.167 | +0.006 (−0.024..+0.032) | +0.018 (−0.022..+0.056) | 19 / 27 |
| C | 49 (32) | 0.506 | **+0.072 (+0.031..+0.122)** | +0.006 (−0.050..+0.058) | 10 / 11 |
| D | 43 (22) | 0.102 | +0.039 (−0.047..+0.120) | +0.034 (−0.046..+0.117) | 10 / 11 |

Turns where the hook injected nothing at the time (the unbiased subset) had only 2–11 turns per store where the replay injected something. Mean overlap there was identical across arms except D (rrf and rrf+ce 0.240 vs current 0.000, 2 turns) and A (rrf+ce 0.085 vs 0.048, 11 turns), which is far too few turns to separate the arms. The full-turn rows favor `current`, because the responses were written after the historical injection (see the replay's caveats).

### Latency (Apple M2 Max, 12 cores; cross-encoder wall time and process CPU)

| step | p50 | p90 | note |
|---|---:|---:|---|
| RRF of two lanes | < 0.1 ms | < 0.1 ms | all datasets |
| FTS lane (fixture stores) | 2.6 ms | 8.0 ms | 874 memories; 15 / 29 ms at 15k turns. Real stores: #136 (p90 0.6–3 s) |
| production retriever (current arm) | 24 ms | 54 ms | session-qrels |
| mmarco-minilm, 5 / 10 / 20 / 40 candidates | 98 / 301 / 611 / 1,217 ms | 190 / 367 / 746 / 1,498 ms | session-qrels sweep, 30 queries each; CPU 0.5 / 1.2 / 2.6 / 5.6 s per call |
| mmarco-minilm in the hook replay (≤ 20 candidates) | 76–160 ms | 237–673 ms | per turn, stores A–D |
| bge-m3, 5 / 20 / 40 candidates | 789 / 4,958 / 9,911 ms | 1,741 / 7,069 / 13,797 ms | CPU 5 / 25 / 53 s per call |
| model load (cache warm) / first call | 0.4–0.7 s / 5–45 ms (mmarco); 0.7 s / 0.3 s (bge-m3) | | cold download: 21 s (mmarco), 105 s (bge-m3) |

Budgets from the brief: hook lexical path a few tens of ms; semantic daemon warm 15–20 ms.

### Rerun deviation

Two passes in one process gave identical metrics (max |Δ| 0.0000 on every dataset). Across separate processes, the e5 embeddings and cross-encoder logits vary in the last bits, which reorders near-ties. On the 874-query set the largest cross-process difference was 0.2 %p, and on the 150-query subset 0.7 %p (vector recall@10 0.420 vs 0.413). The hook replays reproduced exactly across processes. Sampling error (the bootstrap intervals above) is much larger than either.

## Decision

The stage-2 bar (from the T12 brief): an arm must lift the main metric clearly beyond rerun deviation (about 3 %p) on two or more datasets, regress on none, and fit the path's latency budget.

- **Cross-encoder (both models): no.** At 20 candidates, mmarco-minilm costs 0.6 s wall and 2.6 s CPU per query, about 30× the daemon's warm budget. Even on the hook's small pools it adds 76–160 ms p50 and 237–673 ms p90 per turn, several times the hook's whole lexical budget. Cutting to 5 candidates still costs 98 ms. Quality does not pay for it either: mmarco-minilm is below plain rrf on session-qrels, significantly worse than current on golden top ranks (nDCG −17.9 %p, upper bound 0), and not significant elsewhere. bge-m3 is the only arm with a large clear gain on Korean data (+10.7 %p), at 5 s and 25 CPU-seconds per query.
- **RRF without the retriever's filters (`rrf`): no.** It gains on session-qrels (+7.3 %p) but regresses on golden (nDCG −14.5 %p, interval excludes 0) and is worse on LongMemEval. The `rrf` vs `rrf-filtered` gap shows where the session-qrels gain comes from: candidates that the retriever's quality filters reject or that only the FTS lane finds, not the fused order.
- **RRF inside the existing filters (`rrf-filtered`, the shape a production stage would take): no.** It is neutral on all three qrels sets (|Δ| ≤ 4.6 %p, no interval excludes 0). On the hook replay it is positive on all four stores but clearly so only on the smallest (C, 32 injected turns). The two large stores move by +0.006 and +0.020 overlap, inside their intervals. One store is not "two or more datasets", and the unbiased subset is too small to confirm C.

So T12 stops after stage 1: the evaluation code and this report land, and production ranking is unchanged.

### What would reopen it

- A hook-replay rerun with more unbiased turns (#141 asks for ≥ 100 uninjected turns per store) showing the `rrf-filtered` gain on at least one large store. RRF itself is free on the hook path, because the hook already runs every lane.
- A cross-encoder that scores 20 candidates in about 20 ms on CPU. That is roughly 30× faster than mmarco-minilm here, so it needs a different class of model (for example a distilled, few-layer reranker), not a smaller batch.
- The session-qrels result points at the retriever's quality filters, not fusion: the plain vector lane beats current there by +5.4 %p at the same budget, and golden shows why the filters exist. That trade-off belongs with #141, not here.

## Reproduce

```bash
# Models: the e5 embedder (copy from an existing cache or download) and the reranker.
mkdir -p /tmp/cml-models
npm run eval:rank-fusion -- --fixture benchmarks/replay/golden-memory-usefulness-v1.json \
  --model-cache /tmp/cml-models --download-models --sweep

# Session qrels from local transcripts (raw text; keep the output outside the repo).
tsx scripts/generate-session-qrels.ts --sessions-dir <copy-of-transcripts> --out /tmp/session-qrels.json --ks 1,3,5,10
npm run eval:rank-fusion -- --fixture /tmp/session-qrels.json --label session-qrels --model-cache /tmp/cml-models --sweep
npm run eval:rank-fusion -- --fixture /tmp/session-qrels.json --limit 150 --reranker bge-m3 --repeat 1 --model-cache /tmp/cml-models

# LongMemEval_S subset (download per benchmarks/longmemeval/README.md).
tsx scripts/longmemeval-retrieval-smoke.ts --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity turn --retrieval-mode single --strategy fast --limit 30 --fixture-out /tmp/lme-turn-30.json
npm run eval:rank-fusion -- --fixture /tmp/lme-turn-30.json --label longmemeval-s-turn-30 --model-cache /tmp/cml-models

# Hook replay on a store copy (sqlite3 events.sqlite ".backup ..." plus vectors/).
# HOME points at a scratch home whose .claude-code/memory/models holds the e5 model.
HOME=/tmp/cml-home tsx scripts/replay-hook-grounding.ts --store /tmp/copy/<hash> --label A --limit 120 \
  --ranking-arms --model-cache /tmp/cml-models
npm run eval:hook-replay -- --ranking-arms --model-cache /tmp/cml-models   # committed fixture
```

`--format json` prints the full aggregate report with provenance (git SHA, fixture hash, flags).
