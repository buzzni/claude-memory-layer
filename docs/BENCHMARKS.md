# Benchmarks

Retrieval numbers for claude-memory-layer (CML) that anyone can rerun, with the command, the data, the baseline and the limits of each. Rules for this page:

- Only numbers from runs listed here. What was not run says **not measured**.
- Every result sits next to a baseline. Where the baseline wins, the table says so.
- No side-by-side table with other memory projects: their datasets, metrics and settings differ.
- These are **retrieval** metrics. They are not question-answering accuracy and not token savings.

## Summary

Measured 2026-11-17. Details, commands and limits are in the sections below.

| set | data | what is scored | CML | baseline | who wins |
|---|---|---|---|---|---|
| [LongMemEval_S, replay retriever](#1-longmemeval_s-replay-retriever) | public download, 470 questions | evidence sessions in the top 10 (recall_any@10 / nDCG@10) | session 0.755 / 0.556; opt-in hybrid 0.881 / 0.749 | grep 0.962 / 0.816 | **grep** |
| [LongMemEval_S, production lanes](#2-longmemeval_s-production-lanes) | public download, first 30 questions, 15,150 turns | evidence turns in the top 10 (recall@10 / nDCG@10) | 0.800 / 0.647 | FTS5 alone 0.750 / 0.552 | CML on nDCG; recall interval includes 0 |
| [Golden replay fixture](#3-golden-replay-fixture) | committed, 10 queries + 8 no-match traps | recall@5 / no-match traps passed | 0.70 / 8 of 8 | grep 0.70 / 1 of 8 | tie on recall, CML on traps |
| [Lesson recall](#4-lesson-recall) | committed, 2 × 100 cases | recall@3 / false injection on negatives | lexical (default): release-v1 0.217 / 0, release-v2 0.833 / 0 | no simpler baseline run | the opt-in hybrid recalls more but fails its own gate on both sets |
| [Hook replay fixture](#5-hook-replay-fixture) | committed, 8 synthetic turns | memories injected per turn | 6 memories on 6 of 8 turns | — | fidelity check, too small to rank |

Not measured: QA accuracy on LongMemEval, tokens injected by the hooks, any result on a real user store (see [What these numbers do not say](#what-these-numbers-do-not-say)).

## Reproduce

```bash
# LongMemEval_S cleaned, pinned to a dataset revision (MIT license, ~277 MB; do not commit it).
mkdir -p /tmp/LongMemEval/data
curl -L --fail \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json \
  -o /tmp/LongMemEval/data/longmemeval_s_cleaned.json
shasum -a 256 /tmp/LongMemEval/data/longmemeval_s_cleaned.json
# d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442

# Every run on this page, 26–36 minutes on the machine below. The first run downloads
# Xenova/multilingual-e5-small into --model-cache and into .cache/lesson-hybrid-e5.
npm run --silent benchmark:public -- --out-dir /tmp/cml-bench \
  --model-cache /tmp/cml-models --download-models \
  --longmemeval /tmp/LongMemEval/data/longmemeval_s_cleaned.json
```

`benchmark:public` writes one JSON report per run and `summary.json` (commit, Node version, platform, CPU, dataset hash, and the metrics this page quotes) into `--out-dir`. It refuses a LongMemEval file with a different hash. Without `--longmemeval` it runs only the committed fixtures; without `--model-cache` it skips the runs that need the embedder and lists them as `not run`. The individual commands are given per set below; use `npm run --silent` when redirecting output, or npm's banner ends up in the JSON.

### Environment of the published run

| | |
|---|---|
| code | `cfdbdd7`: main at `b99f62f` plus the runner and grep baseline from the change that added this page, which do not touch `src/` |
| machine | Apple M2 Max, 12 cores, 64 GB, macOS 27.0.1 (darwin 27.0.0 arm64); other jobs ran on the machine, so latencies are approximate |
| Node | v22.23.1 |
| embedder | `Xenova/multilingual-e5-small`, model files sha256 `a89c5cc413885d7c2af5906da0f77f30d2ce4ef4bb11751fc7e22d652373ec4d` |
| LongMemEval_S | `xiaowu0162/longmemeval-cleaned` revision `98d7416c24c7`, `longmemeval_s_cleaned.json` sha256 `d6f21ea9…3a442` |
| clock | the retriever's rerank has a recency term from the wall clock that stops changing once a memory is 60 days old; the LongMemEval memories are dated 2023 and the golden ones 2026-01-01, so the date of a run does not move those results |
| reruns | `benchmark:public` ran twice; every metric was identical in both runs and only times differed. An earlier exploratory run of set 2 in a third process gave `current` nDCG@10 0.648 and MRR 0.604 (0.001 higher); no other metric on this page moved |

## 1. LongMemEval_S, replay retriever

**Data.** LongMemEval_S cleaned: 500 questions, each with its own haystack of about 50 chat sessions. The 30 abstention questions are left out (`--skip-abstention`, the default), as LongMemEval's retrieval reporting does, which leaves 470. Each question searches only its own haystack. The expected ids are the evidence sessions (or turns) from the dataset's labels.

**What runs.** `scripts/longmemeval-retrieval-smoke.ts` converts the haystacks into replay memories and runs CML's retrieval orchestrator (`strategy fast`) over them. The orchestrator is the production code, but the stores under it are in-memory stand-ins from `src/core/replay-evaluator.ts`: the keyword lane is token overlap, not SQLite FTS5, and the vector lane is a 64-dimension hashed bag of words, not e5. **So these rows measure CML's fusion and filtering on two lexical signals, not the production embedder.** Set 2 runs the production lanes.

**Baseline.** `benchmarks/public/grep-baseline.ts` scores each memory by how many distinct query terms it contains as a case-insensitive substring (terms: letter/digit runs of 2+ characters minus a short English stopword list) and keeps fixture order on ties. No index, no weighting. It goes through the same evaluator, so every metric has the same definition.

```bash
npm run --silent eval:longmemeval:retrieval-smoke -- --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity session --retrieval-mode single --strategy fast --format json --no-per-query \
  --fixture-out /tmp/lme-session.fixture.json --out /tmp/lme-session.json
npm run --silent eval:longmemeval:retrieval-smoke -- --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity turn --retrieval-mode single --strategy fast --format json --no-per-query \
  --fixture-out /tmp/lme-turn.fixture.json --out /tmp/lme-turn.json
npm run --silent eval:longmemeval:retrieval-smoke -- --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity session --retrieval-mode hybrid --strategy fast --expand-preference-queries --temporal-date-boost \
  --hybrid-session-weight 1.75 --hybrid-turn-weight 5 --format json --no-per-query --out /tmp/lme-hybrid.json
npx tsx benchmarks/public/grep-baseline.ts --fixture /tmp/lme-session.fixture.json > /tmp/lme-session-grep.json
npx tsx benchmarks/public/grep-baseline.ts --fixture /tmp/lme-turn.fixture.json > /tmp/lme-turn-grep.json
```

470 questions, k = 10. recall_any: at least one evidence item in the top 10. recall_all: every evidence item in the top 10. Fractional: share of evidence items in the top 10.

| run | memories | recall_any@10 | recall_all@10 | fractional recall@10 | nDCG@10 | MRR | wall time |
|---|---:|---:|---:|---:|---:|---:|---:|
| **grep baseline, sessions** | 22,419 | **0.962** | **0.849** | **0.910** | **0.816** | **0.828** | 3 s |
| CML, sessions | 22,419 | 0.755 | 0.489 | 0.625 | 0.556 | 0.609 | 38–44 s |
| CML, hybrid session + turn with the opt-in flags above | 22,419 sessions, 231,606 turns | 0.881 | 0.740 | 0.816 | 0.749 | 0.771 | 5–7 min |
| grep baseline, turns | 231,606 | 0.749 | 0.526 | 0.626 | 0.483 | 0.488 | 11–13 s |
| CML, turns | 231,606 | 0.651 | 0.383 | 0.509 | 0.452 | 0.507 | 28–32 s |

**Reading.** The grep baseline beats every CML configuration here, including the tuned hybrid mode, on every metric at session granularity, and on every metric except MRR at turn granularity. Two properties of the data favor it: each haystack is small (about 48 sessions), so counting matched terms is enough to separate the evidence, and evidence sessions are longer than the rest (median 14.5k vs 10.6k characters), so they contain more of any query's terms. The session headers in the converted data contain the session id (`answer_…` for evidence sessions); masking them changed no grep metric, so the baseline does not exploit them.

**Limits.** English only. Isolated 50-session haystacks are far smaller than a long-lived project store. The hybrid row uses flags tuned on this same dataset (see `benchmarks/longmemeval/README.md`), so it is optimistic. Bootstrap intervals were not computed for this set.

## 2. LongMemEval_S, production lanes

**What runs.** `scripts/evaluate-rank-fusion.ts` (from the RRF evaluation in [`benchmarks/rank-fusion/README.md`](../benchmarks/rank-fusion/README.md)) puts the memories into a throwaway SQLite store, the production FTS5 lane, and embeds them with the production embedder. `current` is the production retriever with the semantic daemon's options. `keyword` is the FTS5 lane alone and `vector` is the e5 lane alone, each taking its own top 30. The reranker is off.

**Data.** The first 30 non-abstention questions at turn granularity, all in one shared corpus of 15,150 turns (a harder setting than set 1's per-question haystacks). Embedding the corpus takes almost all of the 20–26 minute run, which is why it is a subset.

```bash
npx tsx scripts/longmemeval-retrieval-smoke.ts --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity turn --retrieval-mode single --strategy fast --limit 30 --format json --no-per-query \
  --fixture-out /tmp/lme-turn-30.json --out /tmp/lme-turn-30-report.json
npm run --silent eval:rank-fusion -- --fixture /tmp/lme-turn-30.json --label longmemeval-s-turn-30 \
  --model-cache /tmp/cml-models --reranker none --format json > /tmp/lme-turn-30-lanes.json
```

| arm | recall@10 | nDCG@10 | hit@10 | MRR |
|---|---:|---:|---:|---:|
| current (production) | 0.800 | 0.647 | 0.800 | 0.603 |
| keyword (FTS5 alone) | 0.750 | 0.552 | 0.767 | 0.503 |
| vector (e5 alone) | 0.633 | 0.448 | 0.633 | 0.401 |

Paired difference at `current`'s own budget (k = the length of `current`'s list per query), 95% bootstrap interval:

| arm vs current | Δ recall %p | Δ nDCG %p |
|---|---|---|
| keyword | −8.3 (−18.3..0.0) | −11.6 (−21.7..−3.6) |
| vector | −23.3 (−43.3..0.0) | −21.9 (−39.9..−4.3) |

**Reading.** The production pipeline ranks evidence higher than either lane alone (the nDCG intervals exclude 0). On recall the intervals reach 0, so 30 questions cannot show that it finds more. The grep baseline was not run on this shared corpus; it is defined per question.

**Limits.** 30 questions; intervals are wide. English only.

## 3. Golden replay fixture

**Data.** `benchmarks/replay/golden-memory-usefulness-v1.json` (sha256 `b67722c79bbb…`): 19 hand-written memories in Korean and English, 10 queries with expected memories and 8 no-match traps (stale, cross-project, topic-shift) where the right answer is to return nothing.

```bash
npm run eval:retrieval-replay
npx tsx benchmarks/public/grep-baseline.ts --fixture benchmarks/replay/golden-memory-usefulness-v1.json
npm run --silent eval:rank-fusion -- --fixture benchmarks/replay/golden-memory-usefulness-v1.json \
  --model-cache /tmp/cml-models --reranker none --format json > /tmp/golden-lanes.json
```

Replay retriever (stand-in lanes, as in set 1) and grep, k = 5:

| run | recall@5 | nDCG@5 | hit@5 | MRR | no-match traps passed | forbidden memories returned |
|---|---:|---:|---:|---:|---:|---:|
| CML replay | 0.70 | 0.821 | 1.0 | 1.0 | 8 of 8 | 0 |
| grep baseline | 0.70 | 0.653 | 0.8 | 0.725 | 1 of 8 | 7 |

Production lanes, k = 10:

| arm | recall@10 | nDCG@10 | hit@10 | MRR |
|---|---:|---:|---:|---:|
| current (production) | 0.60 | 0.785 | 1.0 | 1.0 |
| keyword (FTS5 alone) | 0.70 | 0.646 | 0.8 | 0.75 |
| vector (e5 alone) | 0.95 | 0.814 | 1.0 | 0.913 |

**Reading.** Grep finds as many expected memories but ranks them lower and answers 7 of 8 traps with something. In the production lanes, the e5 lane alone reaches more of the expected memories at k = 10 than `current`, because `current` stops early: after its filters and score cliff, its candidate list has a median of 2 memories per query here. At `current`'s own budget, `keyword` is lower by 20.0 %p recall (−35.0..−5.0) and `vector` by 5.0 %p (−20.0..+10.0).

**Limits.** 10 scored queries. The fixture was written by the maintainers for this project's use cases, so it checks behavior, not general retrieval quality.

## 4. Lesson recall

**Data.** The two committed test-split fixtures in `benchmarks/lesson-recall/` (registered in `splits.json`, read only with `--final-report`): `release-v1-independent.json` (sha256 `78e9218f…`) and `release-v2-independent.json` (sha256 `c9cf7cea…`). Each has 20 curated lessons and 100 prompts: 60 that should recall a lesson (20 of them by identifier) and 40 that should recall none.

**What runs.** `lexical` is the production lesson ranking (`rankCuratedLessons`). `hybrid` adds the e5 semantic rescue behind `CLAUDE_MEMORY_LESSON_HYBRID_EXPERIMENT=true`, which is **off by default**; its gate was frozen on the dev split.

```bash
mkdir -p .cache/lesson-hybrid-e5
npx tsx scripts/evaluate-lesson-hybrid.ts benchmarks/lesson-recall/calibration-v1.json .cache/lesson-hybrid-e5 --download-model
npx tsx scripts/evaluate-lesson-hybrid-heldout.ts benchmarks/lesson-recall/release-v1-independent.json /tmp/lesson-v1.json --final-report
npx tsx scripts/evaluate-lesson-hybrid-heldout.ts benchmarks/lesson-recall/release-v2-independent.json /tmp/lesson-v2.json --final-report
```

The second and third commands exit 1 when the hybrid gate fails, which it does.

| fixture | ranking | recall@3 | precision@3 | false injection on negatives | identifier retention | p95 latency |
|---|---|---:|---:|---:|---:|---:|
| release-v1 | lexical (default) | 0.217 | 0.722 | 0.00 | 0.00 | 1–2 ms |
| release-v1 | hybrid (opt-in) | 0.500 | 0.698 | 0.20 | 0.55 | 13–55 ms |
| release-v2 | lexical (default) | 0.833 | 0.962 | 0.00 | 1.00 | 1–2 ms |
| release-v2 | hybrid (opt-in) | 0.983 | 0.908 | 0.10 | 1.00 | 16–19 ms |

**Reading.** The hybrid ranking recalls more but injects a lesson into 10–20% of prompts that should get none, so it fails its own release gate (false injection ≤ 0.05) on both sets, and on release-v1 it also misses the recall, precision and identifier thresholds. That is why it stays opt-in. On release-v1 the default lexical ranking finds a relevant lesson for only 22% of prompts. Latency ranges span the two runs on a machine that was also running other jobs.

**Limits.** 60 positive prompts per set. The lessons are written software-development scenarios and the prompts are Korean and English paraphrases plus identifier queries, not prompts from real sessions.

## 5. Hook replay fixture

`npm run eval:hook-replay` replays the 8 synthetic hook traces in `benchmarks/replay/hook-grounding-fixture-v1.json` (no real session content) through the `UserPromptSubmit` selection code with the semantic lane off. The current selection injects 6 memories on 6 of the 8 turns and reproduces the recorded selection on 3 of 8 turns (37.5%). 5 of the 6 injected memories overlap the later answer above the 0.3 threshold. Eight turns are a fidelity check of the replay machinery, not a measurement of hook quality, and the overlap score is biased toward whatever was injected at the time (the report explains why).

**Cost.** The replay counts injected memories, not tokens. **Tokens injected per turn: not measured**; measuring them needs the replay to render the hook's context text, which it does not do today.

## What these numbers do not say

- **Not QA accuracy.** Retrieving an evidence session is not answering the question. The official LongMemEval QA score needs a reader model and LongMemEval's LLM judge; it has not been run. See `benchmarks/longmemeval/README.md` for that path.
- **Not token savings, not cost.** No run here measures tokens.
- **Not the semantic lane on LongMemEval_S at full size.** Set 1 uses stand-in lexical lanes; the e5 lane ran only on the 30-question subset of set 2.
- **Not real usage.** Results on the maintainers' own stores (session qrels, hook replay on store copies) are in `benchmarks/rank-fusion/README.md`; they need private data, cannot be reproduced and are reference only.
- **Not a comparison with other memory systems.** Their published numbers use other datasets, metrics (QA accuracy, LLM judges) and settings.
- **Not significance where none is given.** Only the production-lane deltas (sets 2 and 3) and the hook overlap carry bootstrap intervals.

## Relation to earlier reports

`benchmarks/longmemeval/README.md` reports LongMemEval_S runs from 2026-06-13. On this commit the session and turn rows reproduce exactly, while the tuned hybrid row is higher than reported there (recall_any@10 0.881 vs 0.8745, nDCG@10 0.749 vs 0.7340), so the hybrid path changed between the two commits. The numbers on this page are the current ones.

## Corrections

When a number on this page turns out to be wrong, it is fixed in place and recorded here with the date, the old and new value, and the cause.

| date | section | was | now | cause |
|---|---|---|---|---|
| — | — | — | — | none so far |
