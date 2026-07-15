# Agent Productivity Architecture — Progress & Roadmap

> **As of**: 2026-07-15 KST
> **Primary spec**: [`spec.md`](./spec.md) v1.0.2
> **Execution plan**: [`plan.md`](./plan.md)
> **Current released version**: `claude-memory-layer@1.0.57`
> **Field evidence**: [`field-findings-recsys-justin-2026-07-14.md`](./field-findings-recsys-justin-2026-07-14.md)

## 1. Executive Summary

Phase 0의 deterministic baseline, public-output privacy gate, Project Health Report MVP, release safety automation은 merge/release까지 완료됐다. 그러나 2026-07-14 실사용 조사는 synthetic gate가 잡지 못한 네 가지 product blocker를 확인했다.

- injection이 176 prompts 중 175개(99.4%)에서 발생했고 high confidence가 92.6%였다.
- 7개 store의 2,711 events가 모두 L0이며 graduation/consolidation run 기록이 0이었다.
- legacy helpfulness 평균 0.887은 `session_continued` 99%에 끌린 proxy ceiling이라 품질 gate로 부적합하다.
- 같은 repo가 root/worktree/subdirectory에 따라 4개 store로 파편화됐다.

따라서 다음 milestone은 Project Brief 구현 자체가 아니라 **field readiness**다.

1. field baseline/fixture 고정
2. worker liveness와 version skew 진단
3. direct injection/exploration accounting
4. canonical repo identity read-only alias
5. shadow injection calibration
6. healthy derived source가 확인된 뒤 Project Brief

Dashboard는 CLI/API pilot 뒤의 보조 surface로 유지한다.

## 2. Completed and Released

### 2.1 Phase 0 baseline and deterministic gates

- `phase-0-baseline.md`에 golden replay와 LongMemEval retrieval baseline 고정
- fresh clone에서 실행 가능한 committed LongMemEval mini fixture
- continuation, Korean short follow-up, decision recall, no-match, cross-project, stale/superseded, compaction handoff fixture
- golden replay failed queries 0, forbidden hits 0, no-match accuracy 1.0, query yield 1.0
- explicit-input LongMemEval: Recall_any@10 0.8809, nDCG@10 0.749, MRR 0.771

관련 파일:

- `benchmarks/longmemeval/fixtures/retrieval-smoke-mini.json`
- `benchmarks/replay/golden-memory-usefulness-v1.json`
- `tests/apps/longmemeval-retrieval-smoke-cli.test.ts`

### 2.2 Public-output privacy gate

- local absolute path, transcript/session path, credential-looking value 등 forbidden class 중앙 scanner
- 원문을 echo하지 않는 fail-closed report
- npm/release gate 연결

관련 파일:

- `src/core/privacy/public-output-scanner.ts`
- `scripts/scan-public-output-privacy.ts`
- `tests/apps/public-output-privacy-scan-cli.test.ts`

검증:

```bash
npm run check:public-output-privacy -- --json
```

### 2.3 Project Health Report Phase 0 MVP

- aggregate-only 공통 report builder
- CLI JSON과 read-only API의 동일 contract
- project/profile/mode validation, storage/outbox aggregate, 초기 risk gates, safe next action
- invalid input은 storage 초기화 전에 차단
- missing project storage는 DB를 만들지 않고 zero aggregate 반환

관련 파일:

- `src/core/productivity-health-report.ts`
- `src/apps/cli/index.ts`
- `src/apps/server/api/health.ts`
- `tests/apps/productivity-health-cli.test.ts`
- `tests/apps/productivity-health-api.test.ts`

### 2.4 Release safety automation and v1.0.55

- clean tree, npm identity, self-dependency, immutable version, audit, verify/build, pack inspection, credential/privacy scan, fresh-install smoke
- PR #32 merge 및 `claude-memory-layer@1.0.55` publish
- Node 18/20/22 CI 통과, 154 files / 888 tests PASS, production audit 0 vulnerabilities

Evidence:

- merge commit `60c4578fb36c8771486944806640dfefff127e44`
- release commit `5de3cdfa98fab065a14e7059f47fff2bdad26269`
- tag `v1.0.55`

### 2.5 Field retrieval hardening and v1.0.57

- automatic graduation, strict no-match/score-cliff, canonical repo identity, hook output safety, graduation liveness/health 진단을 구현
- 실제 project memory에서 privacy-safe 200-case hard fixture를 동결하고 positive recall/top-1과 counterfactual/unrelated no-match를 반복 평가
- 최종 frozen gate: overall 99.5%, positive hit 99.33%, positive top-1 98%, no-match 100%, unexpected injection/error 0
- 159 test files / 938 tests와 typecheck, lint, architecture, golden replay, privacy, build gate 통과
- `claude-memory-layer@1.0.57` npm publish, registry integrity 조회와 clean temp install 검증 완료

## 3. Current Status Matrix

상태는 코드 + 테스트 + merge/release 증거를 기준으로 한다.

| Requirement | Status | Current evidence / blocker |
|---|---|---|
| FR-A1 Project Brief | Blocked | L1+ 0, worker run 0; APA-17 readiness 선행 |
| FR-A2 SessionStart Brief | Not started | Brief/pipeline readiness 및 observe/preview gate 선행 |
| FR-A3 strict turn injection | Not started | field baseline 99.4%; shadow calibration 필요 |
| FR-A4 lightweight read path | Partial | 일부 regression test 존재; field telemetry/alias path audit 필요 |
| FR-A5 Health Report | Partial | aggregate storage/outbox + graduation liveness/source-readiness gate 구현; version skew·identity alias·direct-evidence fields 후속 |
| FR-A6 injection modes | Not started | observe/preview/enforce contract와 field fixture 필요 |
| FR-A7 explicit curation capture | Done | `lesson add --apply`와 `mem-lesson-save` 구현; `curated` source class, governance audit, secret fail-closed, context-pack recall test 고정 |
| FR-B1 incremental watcher | Not started | canonical identity 선행 |
| FR-B2 bootstrap generator | Not started | repo pattern만 존재 |
| FR-B3 MCP core profile | Not started | core/full exposure tests 필요 |
| FR-B4 Agent Context Profile | Not started | profile/exclusion fixture 필요 |
| FR-B5 canonical repo identity | Partial | root/subdirectory/worktree 공통 Git identity 및 read-only `project identity scan` 구현; alias registry/apply write routing은 미구현 |
| FR-C1 privacy/private-tags | Partial | public-output scanner done; private-tag enforcement 미구현 |
| FR-C1a bundle governance | Not started | manifest/audit/dry-run/revocation 필요 |
| FR-C2 git curated export/import | Not started | Brief 및 privacy governance 선행 |
| FR-C3 team hub | Not started | canonical identity/private tags 선행 |
| FR-D0 deterministic baseline | Done | report/replay/LongMemEval/privacy gate released |
| FR-D1 direct accounting | Not started | legacy helpfulness는 proxy ceiling |
| FR-D2 A/B replay | Not started | ≥20 anonymized real-session scenarios 필요 |
| FR-D3 KPI thresholds | Not started | direct evidence로 useful recall 재정의 필요 |
| FR-D4 user feedback / skew surfacing | Not started | 신규 (2026-07-14 improvement review); `status`에 version skew 감지 없음 확인 |
| APA-17 pipeline liveness | Partial | `process`와 hook-only semantic daemon의 bounded graduation, liveness telemetry, eval isolation, access-priority candidate를 구현·실데이터 검증했다. consolidation/version-skew 진단 후속 |
| APA-19 repo identity alias | Partial | credential-free Git common-dir identity와 read-only dry-run scan 구현; store alias registry/apply는 후속 |

## 4. Operational Observations

### 4.1 Field environment is version-skewed

조사 머신의 global hooks는 `1.0.41`, 현재 release는 `1.0.55`다. 이는 중요한 변수지만 원인 자체는 아니다.

- 사용자 global install을 계획 실행 중 자동 변경하지 않는다.
- temp store/fixture에서 version comparison을 먼저 수행한다.
- 승인된 canary에서만 upgrade 후 1주 delta를 측정한다.
- current에서도 run 0이면 hook-only worker lifecycle 문제로 분류한다.

### 4.2 Derivation pipeline has no run evidence

Field snapshot의 `build_runs=0`은 실패 횟수 0이 아니라 시도 기록 0이다. Health Report가 이를 healthy/empty로 표현하면 안 된다.

필요 상태:

- `never_run`
- `not_eligible`
- `success`
- `failed` + safe error category

Brief readiness는 최근 run 결과와 derived source 존재를 함께 요구한다.

### 4.3 Injection and helpfulness are not trustworthy enough for enforce

현재 high bucket은 변별력이 없고 legacy helpfulness는 re-asked 73%와 동시에 높은 점수를 낸다.

- score threshold만 올리지 않고 score distribution/feature saturation을 분석한다.
- old/new policy를 observe에서 동시에 평가한다.
- direct human labels와 no-match/meta fixture를 promotion gate로 사용한다.

### 4.4 Repo identity is a local prerequisite

worktree/subdirectory 분절은 team sync 이전부터 Claude/Codex/Hermes와 multi-agent worktree에 영향을 준다.

- read-only alias와 scan/dry-run을 먼저 구현한다.
- unrelated/nested repo collision은 fail-closed한다.
- physical DB merge/delete는 자동 수행하지 않는다.

### 4.5 Dashboard adoption is absent

조사 시 port 37777은 실행 중이 아니었다. Health/Stats CLI/API에 worker readiness, weekly injection count, abstention, identity alias 상태를 먼저 노출한다. Dashboard는 이 계약을 렌더링하는 보조 기능이다.

### 4.6 Existing maintenance items

- local outbox에는 quarantined failed rows가 있어 변경 전 `process --dry-run-recovery`가 필요하다.
- npm publish 직후 exact-version 404가 발생할 수 있어 release verification에 bounded retry/backoff가 필요하다. publish 성공 뒤 같은 버전을 다시 publish하면 안 된다.
- GitHub의 old Vitest alert는 current manifest/lock의 4.1.8과 불일치할 수 있어 dependency graph refresh/dismiss evidence가 필요하다.

이 항목은 중요하지만 field product blockers의 선행 순서를 바꾸지 않는다.

## 5. Updated Execution Roadmap

상세 task/acceptance criteria는 [`plan.md`](./plan.md)를 따른다.

| Wave | Priority | Outcome | Exit gate |
|---|---|---|---|
| 0 | P0 | field blocker와 측정 가능성 해결 | explicit worker result, auditable traces, canonical identity dry-run, field-aware health |
| 1 | P0 | strict injection shadow calibration | field rate ≥30%p reduction 또는 direct-label justification; meta/no-match ≤5% |
| 2 | P0 | healthy derived knowledge + Project Brief | source-ready, ≤1,500 tokens, leak/stale action 0 |
| 3 | P1 | frontier lifecycle + role profiles | terminal action resurfacing 0, profile exclusions green |
| 4 | P1 | One Memory, N Agents | canonical identity convergence, freshness ≤5분 |
| 5 | P1/P2 | curated team sharing | raw export 0, privacy/collision gates green, onboarding ≤10분 |
| 6 | P2 | CLI-first pilot, optional dashboard, A/B rollout | ≥20 scenarios, exploration ≥40%↓, waste ≤30%, harmful 0 |

### Wave 0 PR order

1. **PR 0 — Field baseline/fixture**
   - `phase-0-baseline.md` field snapshot
   - privacy-safe injection shadow fixture contract
2. **PR 1 — Pipeline liveness + field Health Report**
   - installed/hook version skew
   - daemon/worker last attempt/result
   - L0/L1+ counts and Brief blockers
3. **PR 2 — Direct injection/exploration accounting**
   - source refs, score/cutoff, policy version, digest, token/latency
   - direct-label audit flow
4. **PR 3 — Canonical repo identity scan/aliases**
   - worktree/subdirectory convergence
   - dry-run/collision/rollback contract
5. **PR 4 — Strict injection observe policy**
   - score calibration, score-cliff, abstention, 800-token limit
6. **PR 5 — Pipeline repair then Brief MVP**
   - PR 1 diagnosis에 따른 worker execution repair
   - readiness gate 통과 후 Brief storage/distiller/context-pack

병행 독립 PR: **explicit curation capture (APA-21/FR-A7)** — 기존 `LessonService` 재사용으로 저비용이며, 파이프라인 수리 전에 사용자 체감 가치를 만드는 가장 빠른 경로다. **user feedback & version-skew notice (APA-22/FR-D4)**, release retry hardening도 병행 가능하다. 상세 근거는 [`improvement-review-2026-07-14.md`](./improvement-review-2026-07-14.md).

## 6. Next Three Concrete Actions

1. **Pipeline liveness diagnostic contract**
   - current fixture에서 `never_run/not_eligible/success/failed`가 구분되는 테스트와 Health fields를 먼저 정의한다.
2. **FR-D1 trace schema and field fixture**
   - public/private visibility, retention, direct-label contract를 정하고 176-trace snapshot을 raw prompt 없이 fixture화한다.
3. **Canonical repo identity ADR/dry-run contract**
   - git common dir/remote/path fallback 우선순위, collision, legacy alias, rollback을 테스트로 고정한다.

병행: **APA-21 explicit curation capture**는 위 세 작업과 의존성이 없으므로 별도 소형 PR로 즉시 착수 가능하다.

Project Brief 구현은 위 세 작업 중 liveness/readiness가 green이 된 다음 시작한다. Brief source readiness는 healthy L1+ 또는 curated source(APA-21) 중 하나로 충족된다.

### 2026-07-14 APA-23 evidence-to-answer dogfood

- Claude hook delivery contract를 `hookSpecificOutput.additionalContext`로 수정했다.
- eval mode가 prompt/access/feedback/trace와 semantic-daemon internal trace를 쓰지 않도록 했다.
- evidence utility, prompt-only abstention, episode expansion, identifier anchor, query-aware excerpt, tool-intent gate를 추가했다.
- recsys_justin 5-case gate 5/5, 확대 23-case TP=12/FN=0/FP=0/TN=11, p50 123.1ms/p95 371.8ms.
- selection/replay gate는 green이지만 post-tuning provider answer run이 빈 stdout으로 끝나 actual-answer A/B gate는 아직 open이다. enforce default로 승격하지 않는다.

### 2026-07-14 APA-17 hook-only automatic graduation canary

- semantic daemon은 embedding-only 상태를 유지하면서 reusable one-shot graduation을 수행한다. Hook은 access evidence 저장 뒤 schedule ack만 받고 pass는 background에서 실행된다.
- project별 기본 5분 cooldown, in-flight dedupe, eval/환경변수 disable, shutdown drain을 추가했다.
- `recsys_justin` 기준 graduation attempt 0→3, L1+ 9→159. 6개 동시 retrieval은 203.6ms wall time에 pass 1회만 실행됐다.
- 최종 분포는 L0=1,866/L1=126/L2=33이며 전체 920 tests와 architecture/replay/privacy/build gate가 통과했다.

### 2026-07-14 APA-23 graduated evidence canary

- 기존 retrieval은 `memory_levels`를 읽지 않아 승격 후에도 recall이 바뀌지 않았다. 단순 level boost는 promoted prompt/긴 운영 가이드가 정확한 답변을 밀어내는 회귀를 만들었다.
- answer-capable L1+ FTS lane, promoted prompt episode bridge, entity/identifier proximity, diagnostic outcome gate, calibrated score merge와 strict graduated cliff를 추가했다.
- `recsys_justin` 8-case before/after에서 정확한 promoted top evidence가 3/6→6/6으로 개선됐고 prompt-only/no-match 2/2 abstain을 유지했다.
- 정밀 positive 12 + prompt-only/unrelated 8 확대 gate는 20/20(p50 141.6ms, p95 425.1ms)이었다. eval mode 전후 events=2,025, traces=251, L0/L1/L2=1,866/126/33으로 불변이었다.
- 실제 Claude Code는 S3 PutObject L1 citation을 받아 5GB limit·8.3GB artifact·multipart 해결을 정확히 답했다. 동시에 짧은 화성 대기 질문에 CI runner가 주입되는 false positive를 발견해 question-boilerplate gate로 차단했다.
- graduated level prior의 중복 적용을 제거해 넓은 L2 문서보다 exact L1 incident가 우선하도록 교정했다.
- 최종 회귀는 158 files/926 tests, typecheck, lint 0 errors, architecture, replay, privacy, build 모두 green이었다.

### 2026-07-14 APA-23 100-case field benchmark

- local-only 100-case set(positive 80/counterfactual 10/unrelated 10, L1/L2 positive 28, 42 sessions)과 eval-mode real hook runner를 추가했다.
- baseline은 overall 32%/positive hit 22.5%/top-1 10%/no-match 70%였다.
- episode seed 분리, exact turn expansion, counterfactual/identifier gate, keyword candidate merge를 추가했고 BM25 rank 정규화 방향 버그를 수정했다.
- 최종은 overall 100%, positive hit 100%, top-1 98.75%, no-match 100%, false injection 0, store immutable이다. concurrency=1 p50/p95는 148.1/439.5ms였다.
- 재사용 workflow를 `~/.codex/skills/evaluate-memory-retrieval`에 Skill로 설치했다.
- live corpus 증가로 기준선이 변하지 않도록 dataset과 events.sqlite를 checksum manifest가 있는 ignored `.local` fixture로 함께 동결했다. replay는 매번 disposable HOME/DB copy와 keyword mode를 사용하며 concurrency=1/4에서 동일 품질 gate를 통과했다.

### 2026-07-15 APA-23 200-case hard field benchmark

- 기본 field set을 positive 150/counterfactual 25/unrelated 25로 확대하고 easy 30/standard 40/hard 130, 7개 query style breakdown을 추가했다.
- exact 원문 의존도를 낮추기 위해 compressed multi-clue, synonym paraphrase, bounded typo/noise를 positive에 각 30건 포함했다. negative identifier도 plausible unknown 값으로 바꿨다.
- baseline positive hit 97.33%에서 episode 전용 후보·seed budget·full-anchor scoring을 개선해 99.33%로 올렸고, top-1 98%/no-match 100%/hard hit 99.23%를 달성했다.
- 200-case dataset과 events.sqlite는 별도 ignored frozen fixture로 유지하며 live project memory 증가와 semantic daemon 상태에 영향을 받지 않는다.

## 7. Definition of Done

```bash
npm run typecheck
npm run lint
npm run test:run
npm run build
npm run check:architecture
npm run eval:retrieval-replay
npm run check:public-output-privacy -- --json
```

추가 기준:

- no new lint errors; warning count를 늘리지 않는다.
- output은 safe source refs를 보존하고 raw prompt/query/path/credential을 포함하지 않는다.
- ambiguous project/privacy/confidence state는 fail-closed한다.
- migration/repair/identity routing은 dry-run aggregate report를 먼저 제공한다.
- hook critical path latency를 회귀시키지 않는다.
- legacy helpfulness 단독으로 enforce/release를 승인하지 않는다.
- Dashboard는 core/service/API output만 렌더링한다.
- team sharing은 curated bundle만 허용한다.

## 8. Document Maintenance

- capability requirement는 `spec.md`, 실행 순서는 `plan.md`, 현재 상태는 이 문서를 우선한다.
- baseline 변경은 `phase-0-baseline.md`에 before/after로 기록한다.
- Health 계약은 `project-health-report-schema.md`에 additive field로 반영한다.
- field snapshot 원문은 수정하지 않고 후속 측정을 새 문서 또는 before/after section으로 추가한다.
- 완료 판정은 계획이 아니라 코드 + 테스트 + merge/release 증거를 기준으로 한다.
