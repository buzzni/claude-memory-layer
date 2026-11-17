# Benchmarks

Retrieval numbers for claude-memory-layer that anyone can rerun, with the command, the data, the baseline and the limits of each. Rules for this page:

- Only numbers from runs listed here. What was not run says **not measured**.
- Every result sits next to a baseline. Where the baseline wins, the table says so.
- No side-by-side table with other memory projects: their datasets, metrics and settings differ.
- These are **retrieval** metrics. They are not question-answering accuracy and not token savings.

## What is the production path and what is not

**CML** on this page means the production retrieval path only: the production retriever, called with the semantic daemon's options, over a SQLite FTS5 keyword lane and a `Xenova/multilingual-e5-small` vector lane, with its fusion, filters and score cliff (`current` in the tables). The `UserPromptSubmit` hook adds its own selection on top of such lanes; set 5 runs that code. The **replay surrogate** is the same retrieval orchestrator over in-memory stand-in lanes, token overlap and a 64-dimension hashed bag of words, with no FTS5 and no embedder; `eval:retrieval-replay` and the LongMemEval runner use it, and its rows are always labelled as such. Lesson and hook rows run the production lesson ranking and the production `UserPromptSubmit` selection code.

## Summary

Measured 2026-11-17 on `4e6b479`. Details, commands and limits are in the sections below.

| set | data | what is scored | result | baseline | who wins |
|---|---|---|---|---|---|
| [1. LongMemEval_S, production path vs grep](#1-longmemeval_s-production-path-vs-grep) | public download; first 30 questions, one shared corpus of 15,150 turns | evidence turns in the top 10 (recall@10 / nDCG@10) | CML 0.800 / 0.647 | grep 0.583 / 0.404; FTS5 alone 0.750 / 0.552 | **CML**; at its budget grep is −31.7 %p recall (−48.3..−16.7) and −28.1 %p nDCG (−41.2..−15.9) |
| [2. LongMemEval_S, replay surrogate vs grep](#2-longmemeval_s-replay-surrogate-vs-grep) | public download; 470 questions, each in its own ~48-session haystack | evidence sessions in the top 10 (recall_any@10 / nDCG@10) | replay surrogate 0.755 / 0.556; with opt-in hybrid flags 0.881 / 0.749 | grep 0.962 / 0.816 | **grep**; this is not the production path |
| [3. Golden replay fixture](#3-golden-replay-fixture) | committed; 10 queries + 8 no-match traps, 19 memories | recall@10 / nDCG@10; traps passed | CML 0.60 / 0.785; replay surrogate passes 8 of 8 traps | grep 0.75 / 0.679, passes 1 of 8 traps | CML on nDCG at its own budget; grep reaches more at k = 10 |
| [4. Lesson recall](#4-lesson-recall) | committed; 2 × 100 prompts | recall@3 / false injection on negatives | CML lesson ranking (default): release-v1 0.217 / 0, release-v2 0.833 / 0 | no simpler baseline run | the opt-in hybrid recalls more but fails its own gate on both sets |
| [5. Hook replay fixture](#5-hook-replay-fixture) | committed; 8 synthetic turns | memories injected per turn | 6 memories on 6 of 8 turns | — | fidelity check, too small to rank |

Comparisons "at the budget" use, per query, k = the length of the list `current` returned; the 95% bootstrap intervals in sets 1 and 3 are computed that way, not at a fixed k.

**The production path and grep are compared under the same conditions only in set 1 (30 questions) and set 3 (10 queries).** On the full 470 LongMemEval_S questions grep was compared with the replay surrogate; the production path at that size is **not measured** (embedding 22,419 sessions or 231,606 turns was out of scope for this run).

Not measured either: QA accuracy on LongMemEval, tokens injected by the hooks, any result on a real user store (see [What these numbers do not say](#what-these-numbers-do-not-say)).

## Reproduce

```bash
# LongMemEval_S cleaned, pinned to a dataset revision (MIT license, ~277 MB; do not commit it).
mkdir -p /tmp/LongMemEval/data
curl -L --fail \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json \
  -o /tmp/LongMemEval/data/longmemeval_s_cleaned.json
shasum -a 256 /tmp/LongMemEval/data/longmemeval_s_cleaned.json
# d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442

# Every run on this page, 35–37 minutes on the machine below. --download-models fetches
# Xenova/multilingual-e5-small at revision 761b726 into --model-cache and .cache/lesson-hybrid-e5.
npm run --silent benchmark:public -- --out-dir /tmp/cml-bench \
  --model-cache /tmp/cml-models --download-models \
  --longmemeval /tmp/LongMemEval/data/longmemeval_s_cleaned.json
```

`benchmark:public` writes one JSON report per run and `summary.json` (commit, Node version, platform, CPU, dataset hash, model revision and hash, and the metrics this page quotes) into `--out-dir`, which must be empty. It refuses a LongMemEval file with a different hash, and a model cache whose files do not hash to the measured model. Without `--longmemeval` it runs only the committed fixtures; without `--model-cache` it skips the runs that need the embedder and lists them as `not run`. The individual commands are given per set below; use `npm run --silent` when redirecting output, or npm's banner ends up in the JSON.

The `summary.json` of both published runs is committed as [`benchmarks/public/results/2026-11-17-run1.summary.json`](../benchmarks/public/results/2026-11-17-run1.summary.json) and [`2026-11-17-run2.summary.json`](../benchmarks/public/results/2026-11-17-run2.summary.json): aggregates only, no query or memory text.

### Environment of the published run

| | |
|---|---|
| code | `4e6b479`, the branch commit that was measured: main at `1e996cd` plus this page's runner, grep baseline and the grep arm of `scripts/evaluate-rank-fusion.ts`; none of it touches `src/` |
| machine | Apple M2 Max, 12 cores, 64 GB, macOS 27.0.1 (darwin 27.0.0 arm64); other jobs ran on the machine, so times are approximate |
| Node | v22.23.1 |
| embedder | `Xenova/multilingual-e5-small` revision `761b726dd34f` (converted from `intfloat/multilingual-e5-small`, MIT), files `config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model.onnx`; artifact sha256 `a89c5cc413885d7c2af5906da0f77f30d2ce4ef4bb11751fc7e22d652373ec4d` |
| LongMemEval_S | `xiaowu0162/longmemeval-cleaned` revision `98d7416c24c7`, `longmemeval_s_cleaned.json` sha256 `d6f21ea9…3a442` |
| clock | the retriever's rerank has a recency term from the wall clock that stops changing once a memory is 60 days old; the LongMemEval memories are dated 2023 and the golden ones 2026-01-01, so the date of a run does not move those results |
| reruns | `benchmark:public` ran twice on `4e6b479`; every metric was identical in both runs and only times differed. They also equal, metric for metric, two earlier runs on `cfdbdd7` (before rebasing onto `1e996cd`, and before the grep arm, masked run and length counts existed). A still earlier exploratory run of set 1 in a separate process gave CML nDCG@10 0.648 and MRR 0.604 (0.001 higher); no other metric on this page moved |

## 1. LongMemEval_S, production path vs grep

**Data.** LongMemEval_S cleaned: 500 questions, each with a haystack of about 48 chat sessions. The 30 abstention questions are left out (`--skip-abstention`, the default), as LongMemEval's retrieval reporting does. This set takes the first 30 remaining questions at turn granularity and puts all their turns into **one shared corpus** of 15,150 turns, so every query searches every question's turns. Expected ids are the evidence turns from the dataset's labels.

**What runs.** `scripts/evaluate-rank-fusion.ts` (from the RRF evaluation in [`benchmarks/rank-fusion/README.md`](../benchmarks/rank-fusion/README.md)) stores the turns in a throwaway SQLite store and embeds them with the production embedder.

- `current` is CML: the production retriever with the semantic daemon's options.
- `keyword` is the FTS5 lane alone and `vector` the e5 lane alone, each taking its own top 30.
- `grep` is the grep-level baseline (below) over the same stored text, top 30.
- The reranker is off. Embedding the corpus takes almost all of the 28–29 minute run, which is why this set is 30 questions.

**grep baseline.** `benchmarks/public/grep-baseline.ts` scores each memory by how many distinct query terms it contains as a case-insensitive substring (terms: letter/digit runs of 2+ characters minus a short English stopword list) and keeps corpus order on ties. No index, no weighting. It does not see expected ids or answers.

```bash
npx tsx scripts/longmemeval-retrieval-smoke.ts --input /tmp/LongMemEval/data/longmemeval_s_cleaned.json \
  --granularity turn --retrieval-mode single --strategy fast --limit 30 --format json --no-per-query \
  --fixture-out /tmp/lme-turn-30.json --out /tmp/lme-turn-30-report.json
npm run --silent eval:rank-fusion -- --fixture /tmp/lme-turn-30.json --label longmemeval-s-turn-30 \
  --model-cache /tmp/cml-models --reranker none --format json > /tmp/lme-turn-30-lanes.json
```

At k = 10:

| arm | recall@10 | nDCG@10 | hit@10 | MRR |
|---|---:|---:|---:|---:|
| CML (`current`) | 0.800 | 0.647 | 0.800 | 0.603 |
| grep | 0.583 | 0.404 | 0.600 | 0.361 |
| FTS5 lane alone | 0.750 | 0.552 | 0.767 | 0.503 |
| e5 lane alone | 0.633 | 0.448 | 0.633 | 0.401 |

At `current`'s own budget, paired difference to CML with a 95% bootstrap interval:

| arm vs CML | recall | nDCG | Δ recall %p | Δ nDCG %p |
|---|---:|---:|---|---|
| grep | 0.483 | 0.365 | −31.7 (−48.3..−16.7) | −28.1 (−41.2..−15.9) |
| FTS5 lane alone | 0.717 | 0.531 | −8.3 (−18.3..0.0) | −11.6 (−21.7..−3.6) |
| e5 lane alone | 0.567 | 0.428 | −23.3 (−43.3..0.0) | −21.9 (−39.9..−4.3) |

(CML itself: recall 0.800, nDCG 0.647 at its budget.)

**Reading.** On one shared corpus the production path beats grep clearly, and both intervals exclude 0: grep puts an evidence turn in the top 10 for 18 of 30 questions, CML for 24. It also ranks evidence higher than either of its own lanes alone (nDCG intervals exclude 0); on recall those two intervals reach 0, so 30 questions cannot show that it finds more than the FTS5 lane. This is the opposite of set 2, where grep wins. The two sets differ in both the system (production path vs replay surrogate) and the corpus (shared vs per-question haystacks), so neither result alone says which of the two decides it.

**Limits.** 30 questions, English only; intervals are wide. A shared corpus of 30 questions' haystacks is still far smaller than a long-lived project store.

## 2. LongMemEval_S, replay surrogate vs grep

**What runs.** `scripts/longmemeval-retrieval-smoke.ts` converts each question's haystack into replay memories and runs the **replay surrogate** (`strategy fast`): the production orchestrator over token-overlap and hashed bag-of-words lanes, not FTS5 and not e5. Each question searches only its own haystack. All 470 non-abstention questions. The grep baseline runs on the same converted memories through the same evaluator, so every metric has the same definition.

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

k = 10. recall_any: at least one evidence item in the top 10. recall_all: every evidence item in the top 10. Fractional: share of evidence items in the top 10.

| run | memories | recall_any@10 | recall_all@10 | fractional recall@10 | nDCG@10 | MRR | wall time |
|---|---:|---:|---:|---:|---:|---:|---:|
| **grep, sessions** | 22,419 | **0.962** | **0.849** | **0.910** | **0.816** | **0.828** | 3 s |
| replay surrogate, sessions | 22,419 | 0.755 | 0.489 | 0.625 | 0.556 | 0.609 | 32–37 s |
| replay surrogate, hybrid session + turn with the opt-in flags above | 22,419 sessions, 231,606 turns | 0.881 | 0.740 | 0.816 | 0.749 | 0.771 | 5 min |
| grep, turns | 231,606 | 0.749 | 0.526 | 0.626 | 0.483 | 0.488 | 12 s |
| replay surrogate, turns | 231,606 | 0.651 | 0.383 | 0.509 | 0.452 | 0.507 | 25–28 s |

**Reading.** grep beats every replay-surrogate configuration here, including the tuned hybrid mode, on every metric at session granularity and on every metric except MRR at turn granularity. This says the surrogate's lexical lanes and filters lose evidence that plain substring matching keeps on this data; it does not say how the production path would do on all 470 questions (not measured). Each haystack is small (about 48 sessions), and evidence sessions are longer than the rest (below), which favors a score that counts matched terms. At turn granularity it is the other way round (evidence turns: median 356 characters, other turns: 498), and grep's lead there is smaller.

### Leak and length checks

The converter writes a header line `[date] session <id>` into each session, and evidence sessions have ids starting with `answer_`, so a query containing the word "answer" could match them through the header. One of the 470 questions contains `answer`, `session` or `turn` as a word; none of the 30 questions in set 1 does. To check that grep does not profit from the header, it runs again with the id masked:

```bash
npx tsx benchmarks/public/grep-baseline.ts --fixture /tmp/lme-session.fixture.json --mask-session-header > /tmp/lme-session-grep-masked.json
```

`--mask-session-header` replaces only the id after `session ` on that first line with `#` (`[date] session #`); the rest of the text is unchanged. Every grep report also carries `haystackLengths`: the median length in characters of the scored text (the converted session, header included) for memories some question expects (evidence) and for all other memories.

| grep, sessions | recall_any@10 | recall_all@10 | fractional recall@10 | nDCG@10 | MRR |
|---|---:|---:|---:|---:|---:|
| as converted | 0.962 | 0.849 | 0.910 | 0.816 | 0.828 |
| session ids masked | 0.962 | 0.849 | 0.910 | 0.816 | 0.828 |

| memories | count | median length |
|---|---:|---:|
| evidence sessions | 890 | 14,460.5 characters |
| other sessions | 21,529 | 10,357 characters |

**Limits.** English only. The hybrid row uses flags tuned on this same dataset (see `benchmarks/longmemeval/README.md`), so it is optimistic. Bootstrap intervals were not computed for this set.

## 3. Golden replay fixture

**Data.** `benchmarks/replay/golden-memory-usefulness-v1.json` (sha256 `b67722c79bbb…`): 19 hand-written memories in Korean and English, 10 queries with expected memories and 8 no-match traps (stale, cross-project, topic-shift) where the right answer is to return nothing.

```bash
npm run eval:retrieval-replay
npx tsx benchmarks/public/grep-baseline.ts --fixture benchmarks/replay/golden-memory-usefulness-v1.json
npm run --silent eval:rank-fusion -- --fixture benchmarks/replay/golden-memory-usefulness-v1.json \
  --model-cache /tmp/cml-models --reranker none --format json > /tmp/golden-lanes.json
```

Production path and baselines, k = 10:

| arm | recall@10 | nDCG@10 | hit@10 | MRR |
|---|---:|---:|---:|---:|
| CML (`current`) | 0.60 | 0.785 | 1.0 | 1.0 |
| grep | 0.75 | 0.679 | 0.8 | 0.725 |
| FTS5 lane alone | 0.70 | 0.646 | 0.8 | 0.75 |
| e5 lane alone | 0.95 | 0.814 | 1.0 | 0.913 |

At `current`'s own budget, Δ to CML with a 95% bootstrap interval: grep −15.0 %p recall (−35.0..+5.0) and −27.9 %p nDCG (−55.7..−3.6); FTS5 alone −20.0 (−35.0..−5.0) and −30.0 (−57.9..−7.9); e5 alone −5.0 (−20.0..+10.0) and −11.7 (−35.4..+9.9).

Replay surrogate and grep on the no-match traps and at k = 5 (the fixture's largest k):

| run | recall@5 | nDCG@5 | hit@5 | MRR | no-match traps passed | forbidden memories returned |
|---|---:|---:|---:|---:|---:|---:|
| replay surrogate | 0.70 | 0.821 | 1.0 | 1.0 | 8 of 8 | 0 |
| grep | 0.70 | 0.653 | 0.8 | 0.725 | 1 of 8 | 7 |

**Reading.** CML ranks the expected memories higher than grep within the few slots it fills (the nDCG interval excludes 0), but it stops early: after its filters and score cliff its candidate list has a median of 2 memories per query here, so at k = 10 grep and the e5 lane alone reach more of the expected memories. grep answers 7 of 8 traps with something. The production path returned nothing for all 8 traps, so the harness has no budget to score the other arms on them.

**Limits.** 10 scored queries. The fixture was written by the maintainers for this project's use cases, so it checks behavior, not general retrieval quality.

## 4. Lesson recall

**Data.** The two committed test-split fixtures in `benchmarks/lesson-recall/` (registered in `splits.json`, read only with `--final-report`): `release-v1-independent.json` (sha256 `78e9218f…`) and `release-v2-independent.json` (sha256 `c9cf7cea…`). Each has 20 curated lessons and 100 prompts: 60 that should recall a lesson (20 of them by identifier) and 40 that should recall none.

**What runs.** `lexical` is CML's lesson ranking as shipped (`rankCuratedLessons`). `hybrid` adds the e5 semantic rescue behind `CLAUDE_MEMORY_LESSON_HYBRID_EXPERIMENT=true`, which is **off by default**; its gate was frozen on the dev split.

```bash
npm run --silent benchmark:public -- --out-dir /tmp/cml-bench-fixtures --model-cache /tmp/cml-models --download-models
npx tsx scripts/evaluate-lesson-hybrid-heldout.ts benchmarks/lesson-recall/release-v1-independent.json /tmp/lesson-v1.json --final-report
npx tsx scripts/evaluate-lesson-hybrid-heldout.ts benchmarks/lesson-recall/release-v2-independent.json /tmp/lesson-v2.json --final-report
```

The first command fills and checks `.cache/lesson-hybrid-e5`, which the lesson evaluation reads (it also runs the committed-fixture sets). The other two exit 1 when the hybrid gate fails, which it does.

| fixture | ranking | recall@3 | precision@3 | false injection on negatives | identifier retention | p95 latency |
|---|---|---:|---:|---:|---:|---:|
| release-v1 | CML lexical (default) | 0.217 | 0.722 | 0.00 | 0.00 | 1 ms |
| release-v1 | hybrid (opt-in) | 0.500 | 0.698 | 0.20 | 0.55 | 12–23 ms |
| release-v2 | CML lexical (default) | 0.833 | 0.962 | 0.00 | 1.00 | 1–3 ms |
| release-v2 | hybrid (opt-in) | 0.983 | 0.908 | 0.10 | 1.00 | 8–13 ms |

**Reading.** The hybrid ranking recalls more but injects a lesson into 10–20% of prompts that should get none, so it fails its own release gate (false injection ≤ 0.05) on both sets, and on release-v1 it also misses the recall, precision and identifier thresholds. That is why it stays opt-in. On release-v1 the default lexical ranking finds a relevant lesson for only 22% of prompts. Latency ranges span the two runs.

**Limits.** 60 positive prompts per set. The lessons are written software-development scenarios and the prompts are Korean and English paraphrases plus identifier queries, not prompts from real sessions.

## 5. Hook replay fixture

`npm run eval:hook-replay` replays the 8 synthetic hook traces in `benchmarks/replay/hook-grounding-fixture-v1.json` (no real session content) through the production `UserPromptSubmit` selection code with the semantic lane off. The selection injects 6 memories on 6 of the 8 turns and reproduces the recorded selection on 3 of 8 turns (37.5%). 5 of the 6 injected memories overlap the later answer above the 0.3 threshold. Eight turns are a fidelity check of the replay machinery, not a measurement of hook quality, and the overlap score is biased toward whatever was injected at the time (the report explains why).

**Cost.** The replay counts injected memories, not tokens. **Tokens injected per turn: not measured**; measuring them needs the replay to render the hook's context text, which it does not do today.

## What these numbers do not say

- **Not QA accuracy.** Retrieving an evidence session is not answering the question. The official LongMemEval QA score needs a reader model and LongMemEval's LLM judge; it has not been run. See `benchmarks/longmemeval/README.md` for that path.
- **Not token savings, not cost.** No run here measures tokens.
- **Not the production path on all of LongMemEval_S.** Set 2 is the replay surrogate; the production path ran only on the 30-question subset of set 1.
- **Not real usage.** Results on the maintainers' own stores (session qrels, hook replay on store copies) are in `benchmarks/rank-fusion/README.md`; they need private data, cannot be reproduced and are reference only.
- **Not a comparison with other memory systems.** Their published numbers use other datasets, metrics (QA accuracy, LLM judges) and settings.
- **Not significance where none is given.** Only the at-budget deltas of sets 1 and 3 and the hook overlap carry bootstrap intervals.

## Relation to earlier reports

`benchmarks/longmemeval/README.md` reports LongMemEval_S runs from 2026-06-13 with the replay surrogate. On this commit the session and turn rows reproduce exactly, while the tuned hybrid row is higher than reported there (recall_any@10 0.881 vs 0.8745, nDCG@10 0.749 vs 0.7340), so the hybrid path changed between the two commits ([#244](https://github.com/buzzni/claude-memory-layer/issues/244)). The numbers on this page are the current ones.

## Corrections

When a number on this page turns out to be wrong, it is fixed in place and recorded here with the date, the old and new value, and the cause.

| date | section | was | now | cause |
|---|---|---|---|---|
| — | — | — | — | none so far |
