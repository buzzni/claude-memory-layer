# Phase 0 Baseline Report — Agent Productivity Architecture

> **Generated**: 2026-07-07T12:09:58Z
> **Last revalidated**: 2026-07-07T13:52:43Z
> **Spec**: `specs/agent-productivity-architecture/spec.md` v1.0.1
> **Purpose**: 기능 구현 전 현재 main/worktree 기준의 재현 가능한 baseline과 safety guardrail을 고정한다.

## 1. Executive Summary

Phase 0의 핵심 guardrail은 현재 기준으로 대체로 준비되어 있다.

- `npm run verify`: **PASS**
- Golden retrieval replay gate: **PASS**
- LongMemEval retrieval smoke: npm script는 committed mini fixture로 **PASS**, explicit public dataset input으로 current best smoke도 **PASS**
- Public-output privacy scan gate: **PASS** (`npm run check:public-output-privacy -- --json`)
- Golden fixture coverage: continuation / Korean short follow-up / decision recall / topic-shift no-match / cross-project trap / stale trap을 이미 포함
- 주요 개선 필요: Project Brief 전용 fixture, health report API/CLI 계약, injection mode observe/preview/enforce fixture, real session A/B exploration-cost fixture

## 2. Commands Run

| Command | Result | Notes |
|---|---:|---|
| `npm run verify` | PASS | typecheck + lint + test 통과 |
| `npm run eval:retrieval-replay` | PASS | thresholded golden replay gate 통과 |
| `npm run eval:longmemeval:retrieval-smoke -- --format json --top-k 2` | PASS | committed mini fixture 기반 fresh-clone smoke 통과 |
| `npm run check:public-output-privacy -- --json` | PASS | 기본 공개 산출물 scan 대상 7개 파일, findings 0 |
| `tsx scripts/longmemeval-retrieval-smoke.ts --input <external LongMemEval_S cleaned dataset> --format markdown --no-per-query --retrieval-mode hybrid --expand-preference-queries --temporal-date-boost --hybrid-session-weight 1.75 --hybrid-turn-weight 5` | PASS | 공개 데이터셋을 임시 위치에 내려받아 실행; 원본 데이터는 repo에 저장하지 않음 |

Revalidation notes:

- `npm run verify` and the golden replay gate were re-run from the current worktree and remain green.
- The LongMemEval npm wrapper now defaults to `benchmarks/longmemeval/fixtures/retrieval-smoke-mini.json`, so a fresh clone can run the retrieval smoke without downloading the public dataset.
- The explicit-input LongMemEval run used the public cleaned dataset artifact and intentionally does not commit raw dataset/report artifacts.
- `npm run check:public-output-privacy -- --json` scans the default public-output targets and currently reports `findings: []`.

## 3. Verification Baseline

### 3.1 `npm run verify`

| Stage | Result | Details |
|---|---:|---|
| TypeScript typecheck | PASS | `tsc --noEmit` |
| ESLint | PASS with warnings | 0 errors, 41 warnings (`no-explicit-any`) |
| Vitest | PASS | 150 test files, 877 tests passed |

Interpretation:

- 현재 baseline은 green이다.
- 41 lint warnings는 Phase 0 blocker는 아니지만, `Project Health Report`에는 warning count를 별도 field로 노출하는 것이 좋다.

### 3.2 Golden Retrieval Replay Gate

Fixture: `benchmarks/replay/golden-memory-usefulness-v1.json`

| Metric | Value |
|---|---:|
| Queries | 18 |
| Memories | 19 |
| Positive queries | 10 |
| No-match queries | 8 |
| Query yield rate | 1 |
| No-match accuracy | 1 |
| Forbidden hits | 0 |
| Failed queries | 0 |
| MRR | 1 |
| Precision@1 | 1 |
| Recall@1 | 0.55 |
| nDCG@1 | 0.9429 |
| Hit@1 | 1 |
| Precision@3 | 0.4 |
| Recall@3 | 0.65 |
| nDCG@3 | 0.806 |
| Hit@3 | 1 |
| Precision@5 | 0.26 |
| Recall@5 | 0.7 |
| nDCG@5 | 0.8206 |
| Hit@5 | 1 |

Category coverage:

| Category | Queries | Current status |
|---|---:|---|
| Korean short follow-up | 2 | Covered |
| Continuation | 2 | Covered |
| Project code task | 2 | Covered |
| Debugging | 2 | Covered |
| Decision recall | 2 | Covered |
| Stale memory trap | 2 | Covered |
| Stale continuation trap | 1 | Covered |
| Topic-shift no-match | 2 | Covered |
| Cross-project contamination | 2 | Covered |
| Compaction handoff noise | 1 | Covered |

Interpretation:

- Phase 0 minimum replay gate is strong enough to block obvious regressions.
- The fixture is still synthetic and compact; Phase 5 A/B validation should add real-session anonymized exploration-cost scenarios.

### 3.3 LongMemEval Retrieval Smoke

The public npm script is now reproducible from a fresh clone because it defaults to the committed mini fixture.

Current npm-script result:

- Command: `npm run eval:longmemeval:retrieval-smoke -- --format json --top-k 2`
- Result: **PASS**
- Default fixture: `benchmarks/longmemeval/fixtures/retrieval-smoke-mini.json`
- Result summary: `queryCount=1`, `memoryCount=2`, `Recall_any@2=1`, `nDCG@2=1`, `MRR=1`

Explicit-input current-code smoke result:

| Metric | Value |
|---|---:|
| Dataset records downloaded | 500 |
| Evaluated non-abstention queries | 470 |
| Converted memories | 22,419 |
| Retrieval mode | hybrid session+turn |
| Query yield rate | 0.9383 |
| Failed queries | 56 |
| Forbidden hits | 0 |
| Precision@1 | 0.7149 |
| Recall@1 | 0.453 |
| nDCG@1 | 0.7149 |
| Hit@1 | 0.7149 |
| Precision@5 | 0.2817 |
| Recall@5 | 0.7617 |
| nDCG@5 | 0.7272 |
| Hit@5 | 0.8489 |
| Precision@10 | 0.1526 |
| Recall@10 | 0.816 |
| nDCG@10 | 0.749 |
| Hit@10 | 0.8809 |
| Recall_any@10 | 0.8809 |
| Recall_all@10 | 0.7404 |
| Fractional Recall@10 | 0.816 |
| MRR | 0.771 |

Failure breakdown:

| Failure type | Count |
|---|---:|
| hit | 348 |
| multi_evidence_partial | 66 |
| no_candidate | 24 |
| lexical_mismatch | 20 |
| answer_below_k | 7 |
| candidate_but_filtered | 5 |

Category breakdown:

| Category | Queries | Recall_any@10 | Recall_all@10 | Fractional Recall@10 | nDCG@10 | MRR |
|---|---:|---:|---:|---:|---:|---:|
| knowledge-update | 72 | 0.9861 | 0.875 | 0.9306 | 0.8903 | 0.9292 |
| multi-session | 121 | 0.9091 | 0.7025 | 0.8134 | 0.7296 | 0.7651 |
| single-session-assistant | 56 | 0.8036 | 0.8036 | 0.8036 | 0.7198 | 0.6942 |
| single-session-preference | 30 | 0.4 | 0.4 | 0.4 | 0.2844 | 0.2493 |
| single-session-user | 64 | 0.9063 | 0.9063 | 0.9063 | 0.8645 | 0.8512 |
| temporal-reasoning | 127 | 0.9291 | 0.6693 | 0.8119 | 0.752 | 0.8036 |

Interpretation:

- Current best retrieval configuration is stronger than the historical 2026-06-13 report on headline retrieval metrics.
- `single-session-preference` remains the weakest category and should be a targeted improvement area.
- Official QA remains **N/A** until reader hypotheses and a judge run are executed; these metrics are retrieval-only.
- The npm script now covers fresh-clone smoke reproducibility; full LongMemEval_S scoring still requires passing `--input <external dataset>` after `--`.

## 4. Fixture Inventory

### 4.1 Existing replay fixtures

| Fixture | Queries | Memories | raw content | Categories / notes |
|---|---:|---:|---:|---|
| `benchmarks/replay/golden-memory-usefulness-v1.json` | 18 | 19 | false | continuation, Korean short follow-up, decision recall, stale/no-match/cross-project traps |
| `benchmarks/replay/memory-operations-v1.json` | 6 | 6 | false | action/frontier, facet filter, graph path, retention quarantine, source-ref redaction |
| `benchmarks/replay/anonymized-real-sessions.json` | 4 | 7 | not declared | small anonymized real-session seed; categories are currently uncategorized |

### 4.2 Test surface inventory

| Area | Test files found | Notes |
|---|---:|---|
| Retrieval | 10 | includes retrieval quality, orchestrator, benchmark CLI, disclosure, analytics |
| LongMemEval | 8 | includes adapter, analysis, hybrid retrieval, retrieval smoke CLI, reader/judge/batch wrappers |
| Dashboard | 13 | includes read API lightweight, usefulness stats, vector health, project detail, operations, security |
| MCP | 7 | includes context, project-aware, operation, perspective, package/boundary tests |
| Source adapter | 2 | contract + Hermes source adapter |
| Privacy filter | 1 | core privacy filter |
| Prompt injection policy | 1 | Claude hook injection policy |
| Outbox/vector health | 4 | recovery, stats, vector outbox, health API recovery |

## 5. Phase 0 Coverage Assessment

| Required Phase 0 coverage | Current status | Evidence / gap |
|---|---|---|
| Generic continuation | Covered | golden fixture has continuation and Korean short follow-up |
| Decision recall | Covered | golden fixture has decision-recall category |
| No-match trap | Covered | topic-shift and compaction-handoff no-match cases |
| Cross-project trap | Covered | cross-project contamination category |
| Stale/superseded trap | Covered | stale memory + stale continuation categories |
| Forbidden hit count | Covered | replay gate enforces max forbidden hits = 0 |
| Privacy/path leak criteria | Partially covered | tests exist, but Phase 0 output scans must be standardized |
| Context-pack token/char budget | Partial | compressor/context-pack tests exist, but this Phase 0 report did not run live budget smoke |
| Stale completed-action resurfacing | Partial | synthetic stale traps exist; action/frontier state-specific fixture should be added |
| Import/outbox health | Partial | tests exist; health report schema needs aggregate buckets and next actions |
| Project Brief-only question | Missing | add fixture once Project Brief MVP exists |
| Injection observe/preview/enforce modes | Missing | add mode-specific regression fixture before enforce default |
| Agent Context Profile exclusions | Missing | add reviewer/team/pm profile exclusion fixtures |
| Shareable Memory Bundle governance | Missing | add export redaction/audit/revocation fixtures before team sharing |

## 6. Privacy / Path Leak Scan Criteria

All public or semi-public outputs introduced by this spec must pass a zero-leak scan before merge:

Targets:

- Markdown reports under `specs/`, `docs/`, and generated benchmark reports
- read-only API payloads
- dashboard JSON payloads and rendered HTML text
- export/import dry-run output
- Shareable Memory Bundle manifests

Forbidden output classes:

- raw local absolute filesystem paths
- transcript database paths or session-storage paths
- raw prompt text or raw retrieval query text in public dashboard/report surfaces
- credential-looking token values and authorization headers
- URI userinfo credentials
- raw tool observation payloads in team/export artifacts
- private actor perspective content in team/export artifacts unless explicitly approved

Recommended implementation rule:

1. Keep the scanner centralized in code, not copied into each script.
2. Public reports may mention **relative repo paths** and safe command names.
3. Public reports should reference source IDs/hashes/categories, not raw memory text.
4. If a scanner finds a match, fail closed and print only the class/count/sample label, not the matched secret/path.

## 7. Baseline Gates for Later Phases

Every later phase should update this table with before/after deltas.

| Gate | Current baseline | Required direction |
|---|---:|---|
| `npm run verify` | PASS, 150 files / 877 tests | Stay PASS |
| Lint errors | 0 | Stay 0 |
| Lint warnings | 41 | Do not increase; reduce opportunistically |
| Golden replay failed queries | 0 | Stay 0 |
| Golden replay forbidden hits | 0 | Stay 0 |
| Golden replay no-match accuracy | 1 | Stay 1 |
| Golden replay query yield | 1 | Stay 1 |
| LongMemEval explicit-input Recall_any@10 | 0.8809 | Improve or justify tradeoff |
| LongMemEval explicit-input nDCG@10 | 0.749 | Improve or justify tradeoff |
| LongMemEval explicit-input MRR | 0.771 | Improve or justify tradeoff |
| LongMemEval npm script reproducibility | PASS via checked-in mini fixture and default npm script | Stay PASS; expand fixture coverage over time |
| Public-output privacy/path leak | Automated via `check:public-output-privacy` | Stay PASS; add new public surfaces to the scan |
| Project Health Report MVP | Implemented in current slice as aggregate CLI/API JSON | Extend toward full target schema before dashboard work |

## 8. Recommended Next Work

1. Broaden the LongMemEval smoke fixture beyond the mini checked-in sample while keeping the default npm gate deterministic.
2. Add every new generated Markdown/API/dashboard/export surface to `check:public-output-privacy` as it ships.
3. Extend the current `claude-memory-layer health --productivity --json` MVP toward the full target schema in `project-health-report-schema.md` before any dashboard UI work.
4. Add Project Brief-only replay fixtures after the Brief MVP exists.
5. Add observe/preview/enforce injection mode regression fixtures before making enforce mode a default.
6. Add real-session anonymized exploration-cost A/B fixture set for Phase 5.
