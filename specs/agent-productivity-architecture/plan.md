# Plan: Agent Productivity Architecture

> **Updated**: 2026-07-14
> **Field evidence**: [`field-findings-recsys-justin-2026-07-14.md`](./field-findings-recsys-justin-2026-07-14.md)
> **Planning source of truth**: 이 문서는 `spec.md`의 capability phase를 실제 실행 순서로 풀어낸다. 상태 증거는 `progress-and-roadmap.md`, 기준선은 `phase-0-baseline.md`를 따른다.

## 1. 전체 목표와 현재 판단

목표는 code agent가 CML 없이 일할 때보다 적은 토큰으로 더 정확한 프로젝트 맥락을 얻고, 그 맥락을 여러 agent와 팀이 안전하게 공유하게 하는 것이다.

2026-07-14 실사용 조사로 기존 순서를 다음과 같이 수정한다.

1. **Project Brief보다 파이프라인 생존성 복구가 먼저다.** 7개 프로젝트의 2,711개 event가 모두 L0이고 `build_runs=0`이다. L1+만 소비하는 Brief를 먼저 만들면 빈 제품이 된다.
2. **주입 튜닝보다 직접 계측과 shadow replay가 먼저다.** 176개 prompt 중 175개에 주입됐고 high 판정은 163개였지만, 기존 helpfulness 평균 0.887은 `session_continued` 편향 때문에 품질 gate로 쓸 수 없다.
3. **repo identity 통합은 팀 공유가 아니라 로컬 P0이다.** 동일 repo가 root/worktree/subdirectory에 따라 4개 store로 갈라져 multi-agent 맥락과 측정치가 함께 파편화됐다.
4. **CLI/API가 제품의 1차 운영면이다.** 별도 실행이 필요한 dashboard는 현장에서 사용되지 않았다. Dashboard는 안정화된 report를 보여주는 보조 surface로 남긴다.
5. **구버전과 실행 모델을 분리해 진단한다.** 현장 설치본 1.0.41과 최신 1.0.55의 차이, hook-only 환경에서 worker가 시작되는지를 각각 검증하며 업그레이드만으로 원인을 단정하지 않는다.
6. **명시적 curation이 최단 가치 경로다.** 실사용에서 검증된 유일한 recall 성공 사례는 수동 증류물이었으나 CML에는 이를 저장할 표면(CLI/MCP)이 없다. 자동 파이프라인 소생과 병행해 명시 저장 경로(APA-21)를 열면, 파이프라인 수리 완료 전에 가치가 발생하고 Brief 재료도 이중화된다. ([분석](./improvement-review-2026-07-14.md))

## 2. 공통 원칙

- SQLite만 canonical이다. Brief, git export, Mongo는 derived artifact 또는 replica다.
- hook critical path에서는 검색/계측만 수행하고 graduation, consolidation, migration은 daemon/명시적 worker에서 수행한다.
- 자동 주입은 `observe → preview → enforce` 순서로 승격하며 ambiguous scope/confidence/freshness/privacy에서는 fail-closed한다.
- raw prompt, raw query, raw tool output, local/transcript path, credential-looking value를 public output이나 team artifact에 노출하지 않는다.
- storage identity 변경과 backfill은 항상 `scan/dry-run → 명시적 apply → 검증 → rollback/alias 유지` 순서다. store를 자동 병합하거나 삭제하지 않는다.
- 기존 `memory_helpfulness` 점수는 보조 신호로만 사용한다. enforce와 release gate는 직접 계측, replay, 사람 판정 표본을 사용한다.
- 모든 신규 public surface는 `check:public-output-privacy` 대상에 포함한다.

## 3. 실행 의존성

```text
현장 기준선 고정
  ├─ 파이프라인 생존성 진단/복구 ── Project Brief ── SessionStart 전환
  ├─ 직접 계측/주입 관측성 ─────── shadow replay ── preview ── enforce 후보
  └─ repo identity 통합 ────────── multi-agent ingest ── team sharing

CLI/API health 계약 ──────────────────────────────────── Dashboard(보조)
```

## 4. 실행 Waves

### Wave 0 — Field blockers & measurable baseline (P0, 즉시)

#### APA-16 — 현장 기준선 승격과 재현 fixture

**목표**: 2026-07-14 snapshot을 이후 변경의 before 값으로 고정한다.

- `phase-0-baseline.md`에 다음 field baseline을 추가한다.
  - injection: 175/176(99.4%), 평균 3.62개, high 163/176
  - knowledge pipeline: 2,711 events, L1+ 0, build/consolidation 0
  - helpfulness: 평균 0.887, `session_continued=1` 99%, `was_reasked=1` 73%
  - identity: 동일 repo 계열 store 4개로 분절
- raw prompt 없이 score bucket, candidate/selected count, prompt category만 보존한 anonymized shadow fixture를 만든다.
- 버전, 설치 mode, project identity를 모든 field report의 필수 차원으로 기록한다.

**완료 조건**:

- 동일 fixture로 old/new 정책의 injection decision을 반복 비교할 수 있다.
- snapshot 수치와 재현 쿼리가 문서화되고 privacy scan을 통과한다.

#### APA-17 — Graduation/consolidation pipeline liveness 진단과 복구

**목표**: `build_runs=0`의 원인을 구버전, worker scheduling, configuration 문제로 분리하고 L1+ 재료가 실제 생성되는 경로를 보장한다.

1. **무변경 진단**
   - CLI `status/health`에 installed version, hook target version, daemon 상태, worker enabled/running/lastAttempt/lastSuccess/lastError, L0/L1+ counts를 aggregate로 노출한다.
   - 1.0.41→1.0.55 changelog와 `memory-utilization-improvements` 배포 시점을 대조한다.
   - `src/services/memory-service.ts`, `memory-service-registry.ts`, `graduation-worker.ts`, `consolidation-worker.ts`에서 hook/CLI/daemon별 worker lifecycle을 contract test로 고정한다.
2. **통제된 canary**
   - 사용자 머신 전역 설치를 자동 변경하지 않는다. 별도 fixture/temp store에서 1.0.41과 current를 같은 입력으로 비교한다.
   - 사용자가 명시적으로 승인한 환경에서만 최신 버전 1주 canary 후 L1+, `build_runs`, `pipeline_metrics` delta를 재측정한다.
3. **구조 수정**
   - 최신 버전에서도 worker가 시작되지 않으면 daemon 또는 명시적 `process` 경로에서 bounded/idempotent graduation을 보장한다.
   - hook-only 기본 경로에서는 semantic daemon이 retrieval 응답 뒤 project별 cooldown/in-flight dedupe를 적용한 one-shot graduation을 비동기 예약한다. eval mode는 이 경로를 반드시 차단한다.
   - candidate batch는 최근 생성순만 사용하지 않고 access evidence를 우선하여 오래된 useful event가 영구적으로 밀리지 않게 한다.
   - 설치/status 출력에서 endless mode가 opt-in임과 현재 비활성 이유를 보여준다. 기본 활성화는 latency/resource 측정 전까지 하지 않는다.
   - L0 직접 Brief fallback은 마지막 수단이다. 사용할 경우 redaction, 최소 evidence 수, source refs, deterministic budget, raw-content exclusion을 갖춘 별도 safe derivation으로 제한한다.

**완료 조건**:

- fresh install과 legacy-upgrade fixture 모두에서 유의미 event 입력 후 bounded 시간 내 `lastAttempt`가 기록된다.
- hook-only fixture도 수동 `process` 없이 bounded 시간 내 `lastAttempt`가 기록된다.
- eligible fixture는 L1+ 또는 명시적 `not_eligible` 결과를 남긴다. 무기록 상태를 허용하지 않는다.
- 실패 원인과 remediation이 Health Report에 aggregate-only로 표시된다.
- Project Brief 작업의 진입 gate: L1+ 또는 승인된 safe fallback source가 존재하고 최근 pipeline run이 성공해야 한다.

#### APA-18 — FR-D1 직접 계측과 injection observability

**목표**: “주입했다”가 아니라 “무엇을 왜 주입했고 유용했는가”를 사후 판정 가능하게 한다.

- SessionStart/UserPromptSubmit별 estimated tokens, candidate/selected count, score distribution, cutoff reason, mode, latency를 기록한다.
- first Edit/Write 전 Read/Grep/Glob 호출 수를 세션 단위로 기록하되 excluded tool body는 저장하지 않는다.
- trace에는 selected source refs, 정책 버전, content digest를 필수 저장한다.
- 로컬/private 진단에 한해 redaction된 bounded preview를 짧은 retention으로 선택 저장할 수 있게 한다. public/API/dashboard 기본 payload에는 preview를 포함하지 않는다.
- 사람이 표본을 `useful | neutral | harmful | unknown`으로 판정할 수 있는 audit flow를 추가한다.
- legacy helpfulness는 `proxy`로 명시하고 직접 판정과 분리해 표시한다. `session_continued`만으로 release/enforce를 통과시키지 않는다.
- `stats --productivity`와 Health Report에서 주입 횟수, token, abstention, exploration cost, direct-label coverage를 aggregate로 노출한다.

**완료 조건**:

- 조사 당시와 같은 질문에 대해 source refs/cutoff/policy/token을 재구성할 수 있다.
- raw prompt/query/path 없이 사람이 최소 20개 trace를 판정할 수 있다.
- metric write가 hook 응답을 block하지 않으며 hook p95 회귀가 없다.

#### APA-19 — Canonical repo identity와 legacy store alias

**목표**: root/worktree/subdirectory/Codex/Hermes가 동일 repo 맥락으로 수렴하게 한다.

- `src/core/registry/`에 repo identity resolver를 둔다.
  - 우선순위: 명시적 project ID → sanitized git remote + repository root identity → git common dir/worktree mapping → path hash fallback
  - credential이 포함된 remote URL은 정규화 전에 제거한다.
- 먼저 read-only alias registry를 도입해 기존 store를 삭제·병합하지 않고 통합 조회/집계한다.
- `project identity scan --dry-run`은 candidate aliases, collision/ambiguity, event/session counts만 보여준다.
- 충돌 없는 경우에만 명시적 apply로 새 write routing을 전환한다. legacy hash와 source ref는 계속 해석 가능해야 한다.
- nested independent repo/submodule과 같은 이름의 다른 remote는 fail-closed한다.
- **ephemeral worktree 쓰기 경로**: read-only alias는 읽기만 통합하므로, `.aplus/worktrees/*` 같은 임시 worktree에서 생성된 메모리는 worktree 삭제 시 고아가 된다. apply 단계 설계에 (a) canonical identity가 unambiguous한 worktree의 신규 쓰기를 canonical store로 라우팅하는 옵션, (b) 고아 store 카운트의 Health Report 노출을 포함한다.

**완료 조건**:

- 같은 repo root, `.aplus/worktrees/*`, 일반 subdirectory가 한 canonical identity로 해석된다.
- nested independent repo와 unrelated repo는 합쳐지지 않는다.
- 기존 4개 store를 대상으로 dry-run 결과와 rollback 가능한 alias 계획이 생성된다.
- cross-project forbidden hit는 0을 유지한다.

#### APA-20 — Health Report field-readiness 확장

**목표**: 위 blocker를 dashboard 없이 CLI/API에서 바로 진단한다.

- `pipelineHealth`에 installed/hook version skew, worker state, last attempt/success/error category, L0/L1+ counts를 추가한다.
- `agentReadiness.brief.blockedBy`에 `pipeline_never_run`, `no_derived_sources`, `project_identity_ambiguous`를 표현한다.
- `memoryQuality.retrievalTraces`에 injection rate, abstention rate, score buckets, direct-label coverage, legacy-proxy ceiling 경고를 추가한다.
- project identity의 canonical ID와 alias count만 노출하고 local path는 노출하지 않는다.
- `suggestedMaintenance`는 안전한 status/dry-run 명령을 우선한다.

**완료 조건**:

- 현장 상태가 `healthy`로 오판되지 않고 정확한 blocker/next action을 반환한다.
- legacy/missing table은 `unknown`으로 안전하게 처리한다.
- CLI/API p95 ≤3s, privacy scan 0 findings를 유지한다.

#### APA-21 — Explicit curation capture (FR-A7, 최단 가치 경로)

**목표**: 자동 graduation과 독립적으로, 사용자/에이전트가 검증된 증류물을 1급 memory로 저장하는 표면을 연다. Finding D의 "생성→recall→행동 변화" 사이클을 CML 안에서 재현 가능하게 한다.

- CLI `lesson add`(가칭)와 MCP `mem-lesson-save`를 추가한다. 기존 `LessonService.promoteCandidate` → `LessonRepository.upsert` → `memory_lessons` 경로를 재사용하고 신규 canonical 스키마를 만들지 않는다.
- 저장물은 `curated` source class로 태깅한다. APA-05 Brief readiness의 `no_derived_sources`는 healthy L1+ **또는** curated source로 해소된다 (L0 raw fallback보다 우선순위 높음).
- 저장 시점에 secret/credential 패턴을 차단하고(FR-C1 규칙 재사용) safe source ref를 보존한다.
- `mem-lesson-save`의 core profile 포함 여부는 FR-B3 논의에서 결정하되, 최소한 full profile에는 즉시 노출한다.

**완료 조건**:

- curated lesson 저장→검색→주입의 e2e fixture (benimaru형 시나리오: 장애 교훈 저장 후 후속 세션에서 recall).
- curated artifact별 recall trace가 남는다 (value-story 지표의 재료, FR-D4/KPI 연동).
- secret 패턴 입력 시 저장이 fail-closed된다.
- APA-17 진행 상황과 무관하게 독립 출시 가능하다.

#### APA-22 — 사용자 가시 피드백과 version skew 능동 알림 (FR-D4, P1)

**목표**: "CML은 저장만 한다"는 인식과 14-버전 방치 문제를 제품 메커니즘으로 해결한다.

- `stats` 기본 출력에 최근 7일 주입 횟수/토큰/abstention율 1블록을 노출한다 (APA-18의 계측 데이터 재사용).
- CLI 커맨드 실행 시 version skew가 임계(예: 5 minor 이상 또는 90일 이상) 초과면 1줄 upgrade 안내를 표시한다. 주 1회 bounded, opt-out 가능, 자동 업데이트 없음.
- hook critical path에서는 어떤 알림도 수행하지 않는다.

**완료 조건**:

- 1.0.41류 방치 시나리오 fixture에서 CLI 사용 시 skew 안내가 1회 표시되고 반복 노출이 bounded된다.
- privacy scan 0 findings, hook p95 회귀 없음.

### Wave 1 — Strict injection in shadow mode (P0)

#### APA-03 — Score calibration, score-cliff, budget policy

1. 176-trace field fixture에서 score 구성요소와 p50/p90/p99, 동점/포화율, score-cliff 빈도를 분석한다.
2. CLI search와 injection policy를 분리하고 injection 전용 absolute min-score + score-cliff + prompt relevance/abstention gate를 적용한다.
3. `요약 1줄 + [mem:id]` 형식과 turn당 800-token hard limit를 적용한다.
4. 먼저 observe에서 old/new decision을 동시에 기록하고, replay 통과 후 preview로 승격한다.
5. **(선택적 조기 완화)** 결정적 증거가 이미 있는 최악 케이스(메타 질문/no-match에 대한 주입)에 한정한 좁은 abstention guard는 본체 calibration과 분리해 조기 승격할 수 있다. 기존 golden replay no-match accuracy 1.0 gate와 meta/topic-shift fixture로 검증하며, guard 자체도 observe 1주를 거친다. 승격 단위를 정책 전체가 아닌 guard 단위로 쪼개는 것이지 observe→preview→enforce 원칙의 예외가 아니다.

**승격 gate**:

- 동일 field fixture에서 injection rate를 99.4% 대비 **최소 30%p 감소**시키거나, 감소하지 못한 이유를 direct human labels로 입증한다.
- meta/topic-shift/no-match fixture의 injection rate ≤5%, no-match accuracy 1.0.
- injection waste ≤30%, harmful label 0, forbidden/cross-project hit 0.
- high bucket 비율 자체를 목표로 삼지 않는다. score 포화가 해소되고 high 판정의 precision이 직접 label 표본에서 검증돼야 한다.
- hook p95 latency 회귀 없음.

#### APA-04 — Read-path 경량화

- stats, health, keyword/fast search, hook observe path에서 embedder/model 초기화가 없음을 테스트한다.
- shadow telemetry와 identity alias 집계가 write worker를 암묵적으로 시작하지 않게 한다.

#### APA-23 — Evidence-to-answer delivery and evaluation isolation (P0)

1. Claude hook output을 official `additionalContext` envelope로 수정하고 실제 `claude -p` contract test를 둔다.
2. `CLAUDE_MEMORY_EVAL_MODE`에서 corpus/feedback/trace mutation을 막아 field benchmark self-contamination을 제거한다.
3. retrieval seed 주변 episode를 확장하고 `agent_response`/`session_summary`를 prompt/tool attempt보다 우선한다.
4. answerability gate로 prompt-only answer injection을 차단하고 source refs가 있는 evidence digest를 렌더링한다.
5. recsys_justin 5-case gate가 green일 때만 20+ case memory-off/on 평가로 확대한다.
6. L1+는 별도 graduated lane에서 사용하되 response/non-template summary만 direct answer로 인정한다. promoted prompt는 episode seed로만 쓰고, entity proximity·diagnostic intent·calibrated score-cliff로 level-based noise amplification을 막는다.

**승격 gate**:

- actual Claude delivery success 100%, unrelated/meta injection ≤5%, prompt-only answer injection 0.
- answerable relevant evidence ≥80%, forbidden/cross-project hit 0, eval corpus mutation 0.
- actual answer의 grounded fact coverage가 memory-off 대비 개선되고 unsupported claim이 증가하지 않는다.

### Wave 2 — Derived knowledge and Project Brief (P0)

#### APA-05 — Brief storage/distiller

- Project Brief는 architecture overview, active decisions, action frontier, lessons와 safe source refs로 구성한다.
- 기본 source는 healthy pipeline의 L1+와 operations artifacts다.
- `pipeline_never_run`, `no_derived_sources`, ambiguous identity에서는 빈 Brief를 성공으로 저장하지 않고 readiness blocker를 반환한다.
- 승인된 L0 fallback은 APA-17의 safe derivation contract를 통과한 경우만 허용한다.
- 전체 ≤1,500 tokens, deterministic eviction, stale terminal action 제외를 강제한다.

#### APA-06 — Context-pack와 SessionStart 통합

1. `mem-context-pack`에 Brief를 먼저 포함해 Claude/Codex/Hermes가 pull 경로에서 검증하게 한다.
2. Brief-only fixture와 실프로젝트 2개 수동 품질 검토를 통과한다.
3. SessionStart는 observe → preview에서 Brief와 기존 recent-event fallback을 비교한다.
4. enforce 승격 후에만 Brief를 기본 주입하며, readiness 실패 시 안전한 fallback/diagnostic을 사용한다.

**완료 조건**:

- 같은 canonical repo의 여러 agent source가 하나의 Brief로 수렴한다.
- Brief ≤1,500 tokens, raw content/path leak 0, stale completed action 0.
- healthy derived source가 있는 프로젝트에서 생성 성공률과 freshness가 Health Report에 보인다.

### Wave 3 — Frontier product loop and agent profiles (P1)

- action lifecycle에서 done/cancelled 재등장을 0으로 만든다.
- blocked action과 resumable checkpoint를 분리한다.
- `coder/reviewer/pm/support/researcher/team` profile별 allowed/excluded memory, budget, freshness, privacy, injection mode를 정의한다.
- reviewer/team/pm exclusion fixture와 observe/preview/enforce 회귀 fixture를 추가한다.
- enforce는 Wave 1~2의 direct-label/replay gate 통과 전까지 기본값이 아니다.

### Wave 4 — One Memory, N Agents (P1)

**진입 게이트**: 대상 환경에서 최근 30일 내 Codex/Hermes 실사용 세션 존재를 확인한 뒤 착수한다 (field 조사에서 사용 흔적 미확인 — 과투자 방지). Claude Code 멀티에이전트 worktree 수렴은 APA-19가 먼저 해결한다.

- Codex session files와 Hermes DB를 read-only/idempotent하게 증분 import한다.
- canonical repo identity를 importer와 watcher에 공통 적용한다.
- inactive/closed session만 import하고 freshness ≤5분을 계측한다.
- `bootstrap --repo`는 AGENTS.md/CLAUDE.md의 marked block만 idempotent하게 갱신한다.
- MCP는 core profile을 기본으로 하고 full profile은 opt-in한다.

### Wave 5 — Curated team sharing (P1/P2)

1. private-tags 최소 슬라이스와 secret hard block
2. Shareable Memory Bundle dry-run/manifest/redaction/audit/revocation
3. Brief/active decisions/lessons/runbooks만 대상으로 하는 git export/import
4. actor와 canonical repo identity를 보존하는 team hub sync

**완료 조건**:

- raw event/transcript/tool observation export 0.
- private/path/credential leak 0, collision/ambiguous project export fail-closed.
- 자동 commit 없음, import idempotent, onboarding ≤10분.

### Wave 6 — CLI-first pilot, optional Dashboard, A/B rollout (P2)

- `stats --productivity`와 `health --productivity --json`으로 먼저 2주 pilot을 운영한다.
- dashboard는 pilot에서 CLI/API로 반복 확인되는 지표만 thin visualization으로 제공한다. 별도 ranking/selection logic을 두지 않는다.
- 최소 20개 anonymized real-session A/B에서 exploration cost, injection waste, harmful recall, token delta를 측정한다.
- 다음 기준을 만족한 경우에만 enforce default 후보와 팀 확대를 검토한다.

| KPI | 목표 |
|---|---:|
| Session injection budget | ≤2,300 tokens |
| Exploration calls | CML off 대비 ≥40% 감소 |
| Injection waste | ≤30% |
| Meta/no-match injection | ≤5% |
| Harmful direct labels | 0 |
| Cross-agent freshness | ≤5분 |
| Forbidden/cross-project hits | 0 |
| Stale completed-action resurfacing | 0 |
| Privacy/path leak | 0 |
| Health Report p95 | ≤3s |
| Curated memory 활용률 | APA-21 출시 후 baseline 측정으로 목표 설정 |

`usefulRecallRateMin=0.45`는 legacy proxy가 아니라 direct label 또는 검증된 A/B outcome으로 재정의한 뒤 gate에 사용한다.

## 5. 다음 PR 순서

1. **PR 0 — Field baseline docs/fixtures**: APA-16, field snapshot과 sanitized replay contract 고정
2. **PR 1 — Pipeline liveness diagnostics**: APA-17/20의 status, worker lifecycle test, readiness blocker
3. **PR 2 — Direct measurement and trace auditability**: APA-18
4. **PR 3 — Canonical repo identity scan/alias**: APA-19 read-only dry-run부터
5. **PR 4 — Injection policy shadow calibration**: APA-03 observe 비교
6. **PR 5 — Pipeline repair + Brief MVP**: 진단 결과에 따라 APA-17 구조 수정 후 APA-05/06

병행 가능한 독립 소형 PR (blocker 선행 순서를 바꾸지 않음):

- **PR-P1 — Explicit curation capture**: APA-21 (기존 LessonService 재사용, 독립 출시 가능 — 가장 먼저 사용자 체감 가치를 만드는 PR)
- **PR-P2 — User feedback & skew notice**: APA-22 (APA-18 계측 데이터가 있으면 stats 블록까지, 없으면 skew 안내만 먼저)
- Release retry hardening

## 6. 모든 PR의 Definition of Done

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

- failing test → minimal implementation → focused green → full green.
- migration/repair/identity merge는 dry-run과 aggregate report를 먼저 제공한다.
- context-producing output은 safe source refs와 policy version을 보존한다.
- 신규 metric은 retention과 public/private visibility를 명시한다.
- legacy schema/missing table에서 read path가 실패하지 않는다.
- 문서의 완료 표시는 코드 + 테스트 + merge/release 증거가 있을 때만 갱신한다.

## 7. 담당 영역

| 영역 | 주요 파일 |
|---|---|
| Pipeline lifecycle | `src/services/memory-service.ts`, `src/services/memory-service-registry.ts`, `src/core/graduation-worker.ts`, `src/core/consolidation-worker.ts` |
| Repo identity | `src/core/registry/project-path.ts`, `src/core/registry/session-registry.ts`, 신규 identity/alias repository |
| Hooks/metrics | `src/adapters/claude/hooks/session-start.ts`, `user-prompt-submit.ts`, `post-tool-use.ts` |
| Retrieval/injection | `src/core/engine/retrieval-orchestrator.ts`, `src/core/retrieval-quality.ts`, hook injection policy |
| Brief/operations | 신규 brief repository/distiller, `src/core/sqlite-event-store.ts`, frontier/action/lesson services |
| Health/CLI/API | `src/core/productivity-health-report.ts`, `src/apps/cli/index.ts`, `src/apps/server/api/health.ts` |
| Evaluation | `src/core/replay-evaluator.ts`, `benchmarks/replay/`, field-derived sanitized fixtures |
| Privacy/export | `src/core/privacy/`, Markdown mirror/export/import, mongo sync |
