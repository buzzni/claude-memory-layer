# Spec: Agent Productivity Architecture (Token-Efficient Shared Context)

> **Version**: 1.0.2
> **Status**: Draft
> **Created**: 2026-07-07
> **Target repo**: `claude-memory-layer`
> **Related specs**: `progressive-disclosure`, `memory-utilization-improvements`, `agentmemory-inspired-memory-operations`, `honcho-inspired-peer-context-memory`, `vector-outbox-v2`, `thin-core-refactor`, `private-tags`, `selective-tool-observation`, `endless-mode`, `citations-system`
> **Related docs**: `docs/HERMES_CML_HEADROOM_OPERATING_MODEL.md`, `docs/architecture/memory-layer-manifest.md`, `docs/TARGET_ARCHITECTURE_AND_FOLDER_STRUCTURE.md`, `docs/MEMORY_USEFULNESS_AUDIT.md`, `docs/ARCHITECTURE_COMPARISON_AND_RECOMMENDATIONS.md`
> **Field validation**: [`field-findings-recsys-justin-2026-07-14.md`](./field-findings-recsys-justin-2026-07-14.md)

## 1. Goal

CML(Claude Memory Layer)을 사용하는 code agent(Claude Code, Codex, Hermes)가 **단독 사용 대비**:

1. **토큰을 훨씬 적게 쓰고** — 세션마다 반복되는 코드베이스 재탐색(수만 토큰)을 사전 증류된 컨텍스트(수천 토큰)로 대체
2. **전체 맥락을 훨씬 잘 파악하며** — 아키텍처/결정/진행 중 작업/교훈을 세션 시작 시점에 이미 알고 시작
3. **팀/회사 단위로 손쉽게 공유되는** — 개인 머신에 갇힌 메모리를 git + 중앙 허브 2계층으로 배포

상태를 만드는 것이 이 spec의 목표다. 한 문장으로: **"에이전트의 탐색 비용을 캐시하고, 그 캐시를 팀 전체가 공유한다."**

### 1.1 문제 정의

현재 CML은 저장(capture)과 검색(retrieval)의 기반은 갖췄지만, "생산성 극대화" 관점에서 4가지 구조적 한계가 있다.

| # | 문제 | 현재 상태 | 결과 |
|---|------|----------|------|
| P1 | **주입 컨텍스트가 원본 이벤트 조각** | SessionStart는 최근 이벤트 3건, UserPromptSubmit은 개별 memory 최대 5건(300자 preview) 주입 | 에이전트가 "프로젝트 전체 그림"을 못 받음 → 매 세션 Read/Grep/Glob으로 재탐색 (세션당 수만 토큰 낭비) |
| P2 | **주입 정밀도 부족** | CLI search와 동일한 기준으로 주입; low-confidence memory도 섞임 | 노이즈 주입 → 토큰 낭비 + hallucination 위험 (`MEMORY_USEFULNESS_AUDIT` next-step 미해결) |
| P3 | **Codex/Hermes는 수동 import 전용** | 명시적 `codex import` / `hermes import` 실행 시에만 반영 | 에이전트 간 메모리 신선도 격차 → "하나의 메모리"가 아님 |
| P4 | **팀 공유 부재** | mongo-sync는 opt-in L0 복제(머신 단위), shared-store는 같은 머신 내 cross-project 전용 | 팀원 A의 결정/교훈이 팀원 B의 에이전트에 도달할 경로 없음; 신규 입사자는 zero context에서 시작 |
| P5 | **증류 파이프라인 생존성 불명** | 실사용 7개 store에서 2,711 events가 모두 L0이고 `build_runs=0` | Brief/lessons/frontier의 재료가 생성되지 않아 상위 제품 기능이 빈 상태가 됨 |
| P6 | **repo identity 파편화** | root/worktree/subdirectory가 path hash별 별도 store | 동일 repo의 agent 맥락과 생산성 지표가 분절되고 cross-agent 수렴 실패 |

#### 1.1.1 리뷰 반영 — 실행상 가장 큰 위험

이 spec은 방향성은 유지하되, 구현 순서에서 다음 위험을 먼저 제거해야 한다.

1. **측정 baseline 없이 기능이 늘어나는 위험**: Project Brief, profile injection, team sharing을 만들기 전에 현재 retrieval/usefulness/exploration-cost 기준선을 고정해야 한다.
2. **자동 주입이 stale/low-confidence memory로 답변을 오염시키는 위험**: 모든 자동 주입은 `observe → preview → enforce` 단계로 승격해야 하며, ambiguous scope/confidence/privacy에서는 fail-closed 해야 한다.
3. **팀 공유가 raw transcript/privacy leak로 이어지는 위험**: 팀 공유는 raw event export가 아니라 curated artifact bundle만 허용해야 하며, redaction/export governance가 선행되어야 한다.
4. **Dashboard가 core logic을 복제하는 위험**: Dashboard v2는 검증된 CLI/API/service output을 보여주는 thin visualization이어야 하며, memory business logic은 core/service layer에만 둔다.
5. **빈 derived layer 위에 Brief를 만드는 위험**: pipeline run/eligibility가 관측되고 L1+ 또는 승인된 safe fallback source가 있을 때만 Brief-ready로 본다.
6. **낙관 편향 proxy를 품질 gate로 쓰는 위험**: legacy helpfulness는 보조 지표로만 사용하고 direct label/shadow replay/생산성 delta로 자동 주입을 승격한다.

### 1.2 해결 방향 — 4 Pillars

```
        ┌─────────────────────────────────────────────────────┐
        │  Pillar D: Measurement (토큰/생산성 계측 — 모든 것의 전제) │
        └─────────────────────────────────────────────────────┘
Pillar A              Pillar B                Pillar C
Budgeted Context      One Memory, N Agents    Team Sharing (2-tier)
──────────────        ────────────────        ────────────────
Project Brief 증류    Codex/Hermes            Tier1: git-committed
(≤1.5K tokens)        watcher ingest          curated memory (PR 리뷰)
high-confidence만     표준 bootstrap          Tier2: central hub
주입 (≤0.8K/turn)     (mem-context-pack)      (mongo team mode)
progressive pull      MCP core profile        privacy gate 필수
```

**Sequencing rule:** Pillar D는 마지막 측정 기능이 아니라 **모든 Phase의 선행 게이트**다. Phase 0에서 baseline과 safety gates가 생성되기 전에는 Project Brief 자동 주입, dashboard v2, team sharing을 구현하지 않는다.

## 2. Why a new spec?

기존 specs에 부분 요소는 있지만, "토큰 효율 + 전체 맥락 + 팀 공유"를 **에이전트 생산성이라는 단일 목표**로 묶는 spec은 없다.

- `progressive-disclosure`: Layer 1/2/3 검색 UX로 토큰을 아끼는 **검색 메커니즘**이지만, 세션 시작 시 무엇을 주입할지(Project Brief), 팀 공유는 다루지 않는다. 본 spec의 Pillar A가 이 spec을 기본 경로로 승격시킨다.
- `memory-utilization-improvements`: trace/graduation/helpfulness의 **버그성 cascade failure 수정**(전술)이며 완료됨. 본 spec은 그 위에서의 아키텍처 개선(전략)이다.
- `thin-core-refactor`: core/adapters/extensions/apps **구조 리팩토링**이며, 생산성·토큰·공유를 목표로 하지 않는다. 본 spec의 모든 신규 코드는 이 spec의 boundary rule을 준수한다.
- `honcho-inspired-peer-context-memory`: actor/perspective 모델(구현 완료)은 팀 공유 시 "누구의 기억인가"의 **기반**이지만, 조직 단위 배포 인프라는 없다. Pillar C가 이 actor 모델을 재사용한다.
- `private-tags`: 팀 공유의 **선행 조건**(privacy gate)이지만 Draft 상태. Pillar C Phase에서 최소 슬라이스를 먼저 구현한다.
- `endless-mode` / `citations-system` / `selective-tool-observation`: 각각 세션 연속성 / 출처 표기 / 저장 노이즈 감소의 개별 메커니즘. 본 spec은 이들을 목표(KPI) 아래 배치하고 필요한 최소 슬라이스만 채택한다.

따라서 `specs/agent-productivity-architecture/`를 신규 생성하고, 기존 specs와의 연결점을 명시한다.

## 3. Core Concepts

| 개념 | 정의 | 토큰 예산 |
|------|------|----------|
| **Project Brief** | 프로젝트당 1개, 지속 증류되는 L2/L3 아티팩트. 아키텍처 요약 + 활성 결정(ADR) + action frontier + top lessons. SessionStart 주입의 새 기본값 | ≤ 1,500 tokens |
| **Project Health Report** | CLI/API-first 진단 리포트. frontier, memory quality, stale risk, outbox/import health, next actions를 aggregate/safe 형태로 보여준다. Dashboard는 이를 시각화만 한다 | 리포트 기준 |
| **Agent Context Profile** | coder/reviewer/pm/support/researcher 등 역할별 context policy. 허용 memory type, freshness window, privacy budget, injection mode를 가진다 | profile별 |
| **Turn Injection Budget** | UserPromptSubmit에서 주입되는 retrieved memory의 상한. high-confidence(score-cliff 통과)만, citation 포함 | ≤ 800 tokens/turn |
| **Injection Mode** | 자동 주입 승격 단계. `observe`(기록만), `preview`(주입 후보 표시), `enforce`(gate 통과 시 자동 주입). 기본값은 observe/preview에서 시작 | mode별 |
| **Pull-based Detail** | 주입은 요약+citation까지만. 상세는 에이전트가 `mem-source-ref`/`expand`로 필요 시 직접 pull (progressive disclosure Layer 2/3) | 에이전트 재량 |
| **Curated Export** | privacy-filter + human review(PR)를 거쳐 repo에 커밋되는 markdown 메모리 (`memory/` 디렉토리). CML 미설치 팀원도 소비 가능 | 파일 기준 관리 |
| **Shareable Memory Bundle** | 팀 공유의 최소 단위. Project Brief, decisions, lessons, runbooks 등 curated artifact만 포함하며 raw event/raw tool output/local path/private perspective는 기본 제외 | export 기준 |
| **Team Hub** | 회사/팀당 1개 MongoDB(또는 호환 스토어). L0 event 복제 + actor identity + private-tags 필터 적용 | N/A |
| **Exploration Cost** | 세션 시작 ~ 첫 Edit/Write까지의 Read/Grep/Glob 호출 수와 그 토큰. CML의 절감 대상이자 핵심 KPI | 측정 대상 |

## 4. Functional Requirements

### Pillar A — Budgeted Context (토큰 절감 + 맥락 품질)

**FR-A1. Project Brief 증류 파이프라인**
- CML은 기존 graduation/consolidation worker를 확장해 프로젝트당 1개의 Project Brief를 유지해야 한다(MUST).
- 구성 섹션: `아키텍처 개요`, `활성 결정(최근 결정 + 근거 citation)`, `Action Frontier(진행 중/차단된 작업)`, `Lessons(반복 실수 방지)`.
- 각 섹션은 L0 이벤트가 아닌 graduated(L1+) memory와 operations layer(actions/frontier/lessons — 기구현)에서 생성한다.
- Brief는 SQLite에 derived artifact로 저장하고(manifest 원칙: SQLite canonical), 전체 크기 ≤1,500 tokens를 강제한다. 초과 시 오래된/저가치 항목부터 축출.
- Staleness 규칙: 마지막 consolidation 이후 유의미 이벤트 N건 초과 시 재증류.
- Readiness 규칙: 최근 graduation/consolidation attempt와 결과가 관측 가능해야 한다. `pipeline_never_run`, `no_derived_sources`, `project_identity_ambiguous` 상태에서는 빈 Brief를 성공으로 저장하거나 enforce 주입하지 않는다.
- L0 직접 fallback은 redaction, 최소 evidence, safe source refs, deterministic budget, raw-content exclusion을 만족하는 별도 safe derivation contract를 통과한 경우에만 허용한다.

**FR-A2. SessionStart 주입 교체**
- SessionStart hook은 "최근 이벤트 3건" 대신 Project Brief를 주입해야 한다(MUST). Brief 부재 시(신규 프로젝트) 기존 동작으로 fallback.
- fallback도 FR-A6 mode/scope/privacy/token gate를 통과해야 하며, `pipeline_never_run`을 정상 신규 프로젝트와 구분해 safe diagnostic을 남긴다.

**FR-A3. High-confidence-only turn injection**
- UserPromptSubmit 주입은 CLI search보다 엄격한 기준을 적용해야 한다(MUST): score-cliff cutoff(인접 결과 간 점수 급락 지점에서 절단) + 절대 min-score 상향.
- 주입 형식은 `요약 + [mem:id] citation`으로 통일하고, turn당 총 주입량 ≤800 tokens를 강제한다.
- 상세 내용이 필요하면 에이전트가 `mem-source-ref`/`mem-details`로 pull하도록 주입 텍스트에 1줄 안내를 포함한다.

**FR-A3b. Answerable evidence injection**

- adapter delivery는 대상 agent의 실제 context contract를 통과해야 하며, direct function stdout test만으로 완료 처리하지 않는다(MUST).
- 검색 단위는 raw event에서 session/turn episode evidence로 확장할 수 있어야 한다. request, tool attempt, observed result, final response를 구분한다.
- answer-seeking query에 `user_prompt`만 존재하면 abstain하고, linked response/summary가 있을 때 이를 우선한다(MUST).
- score-cliff는 relevance guard이며 answerability를 대체하지 않는다. evidence type utility와 source refs를 보존한다.
- field evaluation은 corpus를 변경하지 않는 eval mode를 사용하고 small gate 통과 후 확대한다.

**FR-A4. Read-path 경량화**
- `stats`, keyword-only search 등 읽기 경로에서 embedder/model 초기화를 제거해야 한다(MUST). (`MEMORY_USEFULNESS_AUDIT` next-step 승계)

**FR-A5. Project Health Report (CLI/API-first)**
- CML은 `claude-memory-layer health --productivity`와 read-only API로 Project Health Report를 생성해야 한다(MUST).
- Phase 0 MVP는 aggregate storage/outbox signals, project/profile/mode validation, initial risk gates, safe next action을 JSON으로 제공한다.
- Target report 구성: `Current Frontier`, `Memory Quality`, `Agent Readiness`, `Risk`, `Suggested Maintenance`.
- Report는 installed/hook version skew, graduation/consolidation worker last attempt/success/error category, L0/L1+ counts, canonical repo identity/alias count를 aggregate로 진단해야 한다.
- Report는 aggregate/safe metadata만 포함해야 하며 raw prompt, raw query, local path, transcript path, credential-looking value를 포함하지 않는다(MUST).
- Dashboard v2는 이 report/API를 그대로 렌더링하는 thin visualization이어야 하며, 별도 memory selection/business logic을 구현하지 않는다(MUST).

**FR-A6. Injection safety modes**
- Project Brief와 turn memory의 자동 주입은 `observe → preview → enforce` 승격 모델을 따라야 한다(MUST).
- `observe`: 실제 주입 없이 “주입했을 후보”를 privacy-safe trace에 기록한다.
- `preview`: agent/user가 확인 가능한 후보 summary + source ref를 제공하되 raw detail은 progressive pull로 유지한다.
- `enforce`: project scope, confidence, freshness, privacy class, token budget gate가 모두 통과할 때만 자동 주입한다.
- gate 중 하나라도 ambiguous면 주입하지 않고 safe diagnostic을 반환한다(fail-closed).

**FR-A7. Explicit curation capture (명시적 증류물 저장)**
- 사용자와 에이전트는 자동 graduation/consolidation과 독립적으로 증류물(lesson/decision/rule)을 명시적으로 저장할 수 있어야 한다(MUST): CLI `lesson add`류 커맨드와 MCP `mem-lesson-save` 도구.
- 구현은 기존 `LessonService.promoteCandidate`/`LessonRepository.upsert` 경로를 재사용하며 신규 canonical 스키마를 추가하지 않는다.
- 저장물은 `curated` source class로 기록되어 Project Brief(FR-A1)의 승인된 재료가 된다. `no_derived_sources` readiness blocker는 healthy L1+ **또는** curated source 존재로 해소할 수 있다 (L0 raw fallback보다 우선).
- 저장 시점에 FR-C1과 동일한 secret/credential 패턴 차단을 적용하고 safe source ref를 보존한다.
- 근거: field Finding D — 실사용에서 유일하게 검증된 recall 성공 사례(생성→recall→행동 변화 사이클)는 수동 증류물이었으나, 현재 CML에는 이 경로를 담을 표면이 없다.

### Pillar B — One Memory, N Agents

**FR-B1. Codex/Hermes 증분 자동 ingest**
- CML은 `~/.codex/sessions/`(파일 추가 감지)와 `~/.hermes/state.db`(read-only 증분 스캔)를 주기적으로 tail하는 watcher를 제공해야 한다(MUST).
- source adapter contract(`docs/architecture/source-adapter-contract.md`) 준수: read-only, idempotent, redacted source refs. 세션 파일이 닫힌(비활성) 후에만 import.
- 활성화는 opt-in(`claude-memory-layer watch enable`)으로 하되, 데몬은 기존 semantic daemon 프로세스 모델을 재사용한다.
- 목표 신선도: 에이전트 세션 종료 → 다른 에이전트에서 조회 가능까지 ≤5분.

**FR-B2. 표준 bootstrap 생성기**
- `claude-memory-layer bootstrap [--repo <path>]`는 대상 repo의 AGENTS.md/CLAUDE.md에 삽입할 "작업 시작 시 `mem-context-pack` 우선 호출" 스니펫(현재 이 repo AGENTS.md의 Project Memory Bootstrap 절과 동일 패턴)을 생성/갱신해야 한다(MUST).
- Claude Code(플러그인 hook), Codex(AGENTS.md), Hermes(read-only provider) 3종 모두를 커버하는 통합 문서를 함께 생성한다.

**FR-B3. MCP core profile**
- 27개 MCP 도구를 전부 노출하는 대신, 에이전트 생산성에 필수인 core profile(기본값)을 정의해야 한다(SHOULD): `mem-context-pack`, `mem-search`, `mem-source-ref`, `mem-project-timeline`, `mem-frontier`, `mem-lesson-list`. 나머지는 `--profile full`에서만 노출. (anti-bloat: `ARCHITECTURE_COMPARISON` 권고)

**FR-B4. Agent Context Profile**
- CML은 역할별 context profile을 정의해야 한다(SHOULD): `coder`, `reviewer`, `pm`, `support`, `researcher`.
- 각 profile은 `allowed_memory_types`, `max_tokens`, `freshness_window`, `privacy_budget`, `injection_mode`를 가진다.
- 기본 profile은 `observe` 또는 `preview`로 시작하며, replay/safety gate 통과 전까지 `enforce`를 기본값으로 두지 않는다.
- 예: reviewer profile은 diff/decision/runbook/frontier를 우선하고 raw implementation transcript는 기본 제외; team profile은 personal actor perspective를 기본 제외.

**FR-B5. Canonical repository identity**
- CML은 repo root, git worktree, 같은 repo의 하위 경로, Claude/Codex/Hermes source를 하나의 canonical repo identity로 해석해야 한다(MUST).
- 기존 path-hash store는 먼저 read-only alias로 통합 조회하며, migration/write-routing 변경은 dry-run과 명시적 apply를 제공해야 한다.
- credential이 포함된 remote URL은 identity 생성 전에 제거하고, nested independent repo/collision/ambiguous scope는 fail-closed한다.
- legacy hash와 source ref는 migration 후에도 해석 가능해야 하며 store를 자동 삭제하거나 무검토 병합하지 않는다.

### Pillar C — Team Sharing (2-tier)

**FR-C1. Privacy gate (선행 조건)**
- 모든 export/sync 경로는 privacy filter + private-tags 검사를 통과한 항목만 내보내야 한다(MUST). `private-tags` spec의 최소 슬라이스(태그 지정 + export 차단)는 Phase 5 team sharing 시작 전에 선행 구현한다.
- secret/credential 패턴 detected 항목은 태그와 무관하게 항상 차단.
- 팀 공유는 raw event/raw transcript/raw tool output을 직접 배포하지 않는다(MUST). 공유 단위는 Shareable Memory Bundle이어야 한다.
- private actor perspective, local filesystem path, transcript DB path, raw prompt/query는 기본 제외한다(MUST).

**FR-C1a. Shareable Memory Bundle governance**
- Bundle은 `project_id/team_id`, artifact manifest, redaction summary, source-ref summary, export audit record를 포함해야 한다(MUST).
- 포함 가능 artifact: Project Brief, active decisions, lessons, public runbooks, architecture notes.
- 기본 제외 artifact: raw events, raw tool observations, raw local paths, credentials, private actor perspective, unresolved personal notes.
- Export는 dry-run/diff/review 가능한 형태여야 하며, redaction 실패 시 bundle 생성이 실패해야 한다(fail-closed).

**FR-C2. Tier 1 — Git-committed curated memory**
- `claude-memory-layer export --repo <path>`는 Project Brief + 활성 결정 + lessons를 대상 repo의 `memory/` 아래 사람이 읽을 수 있는 markdown으로 내보내야 한다(MUST). (MarkdownMirror의 repo-target 버전; 현재 mirror는 storage dir 전용)
- Export는 항상 명시적 실행 + git diff로 리뷰 가능해야 하며(PR 게이트), 자동 커밋하지 않는다.
- 역방향: `claude-memory-layer import --from-repo`는 repo에 커밋된 curated memory를 로컬 CML 스토어에 반영한다. CML 미설치 팀원의 에이전트도 markdown을 직접 읽어 혜택을 받는다(zero-install 소비).

**FR-C3. Tier 2 — Team hub sync**
- 기존 mongo-sync를 team mode로 확장해야 한다(SHOULD): actor identity(honcho actor 모델 재사용)를 이벤트에 유지, pull 시 private-tags/redaction 적용, 프로젝트 키 충돌 방지(정규화된 repo identity — 예: git remote URL 기반 projectKey 옵션).
- `claude-memory-layer team join <uri>` 한 줄로 온보딩: 설정 저장 + 초기 pull + watch 등록.
- 세션 시작 시 background non-blocking pull로 팀 이벤트를 반영한다(hook latency에 영향 금지).

### Pillar D — Measurement

**FR-D0. Baseline report (선행 조건)**
- Phase 1 기능 구현 전, 현재 main 기준의 reproducible baseline report를 생성해야 한다(MUST).
- Report는 최소한 다음을 포함한다: replay retrieval metrics, generic continuation quality, no-match accuracy, forbidden/cross-project hit count, context-pack token/char budget, stale completed-action resurfacing count, privacy/path leak scan, import/outbox health.
- 이후 모든 Phase는 baseline 대비 before/after delta를 기록해야 한다.

**FR-D1. Token accounting**
- CML은 세션별로 다음을 기록해야 한다(MUST): 주입 토큰 수(SessionStart/UserPromptSubmit 각각), retrieval 채택률(기존 retrieval_traces 확장), 첫 Edit/Write 이전 Read/Grep/Glob 호출 수(exploration cost).
- 각 injection decision은 policy version, candidate/selected safe refs, score bucket, cutoff/abstention reason, rendered digest, hook latency를 남겨 사후 재구성 가능해야 한다. redacted text preview는 local/private 및 bounded retention일 때만 허용한다.
- legacy `memory_helpfulness`는 proxy로 표시하고 direct `useful|neutral|harmful|unknown` 표본 판정과 분리해야 한다. `session_continued`만으로 enforce/release gate를 통과시키지 않는다.
- 결과는 dashboard KPI 카드와 `stats --productivity`로 노출한다.

**FR-D2. A/B 검증**
- replay-evaluator를 확장해 "CML 주입 on/off" 비교 fixture를 지원해야 한다(SHOULD). 최소 20개 실세션 기반 시나리오로 exploration cost 절감률을 산출한다.

**FR-D3. KPI thresholds 확장**
- `config/kpi-thresholds.json`에 본 spec의 KPI(§5)를 추가하고 dashboard에서 통과/미달을 표시한다.

**FR-D4. User-visible value feedback & version skew surfacing**
- CML은 주입/절감 활동을 사용자가 능동 조회 없이도 인지할 수 있게 요약 노출해야 한다(SHOULD): `stats` 기본 출력에 최근 7일 주입 횟수/토큰/abstention율 1블록.
- installed vs hook target/latest release version skew를 감지하고, 임계 초과 시 CLI 커맨드 실행 시점에 1줄 upgrade 안내를 표시해야 한다(SHOULD). 자동 업데이트는 하지 않는다(MUST NOT).
- 알림은 bounded frequency(예: 주 1회)이고 opt-out 가능해야 하며, hook critical path에서는 어떤 사용자 알림도 수행하지 않는다(MUST).
- 근거: field 조사에서 설치본이 14개 버전 방치됐고, 사용자는 주입 발생 자체를 인지하지 못해 "CML은 저장만 한다"고 인식했다 (제품 신뢰 문제).

## 5. Success Criteria (KPI)

| KPI | 목표 | 측정 방법 |
|-----|------|----------|
| 세션당 주입 토큰 | ≤ 2,300 (Brief 1,500 + turn 800) | FR-D1 token accounting |
| Exploration cost 절감 | Read/Grep/Glob 호출 40%↓ (CML off 대비) | FR-D2 A/B replay |
| Useful recall rate | ≥ 0.45 (threshold 유지, 산식 교체) | direct labels 또는 검증된 A/B outcome; legacy helpfulness는 참고만 |
| 주입 노이즈 | 주입 memory 중 미사용 비율 ≤ 30% | retrieval trace 채택 추적 |
| Meta/no-match 주입 | ≤ 5% | field-derived shadow replay + direct labels |
| Harmful recall | direct-label 표본 0건 | privacy-safe trace audit |
| Pipeline liveness | eligible input에 run result 100%; 무기록 0 | worker attempt/success/not-eligible telemetry |
| Cross-agent 신선도 | Codex/Hermes 세션 종료 → 조회 가능 ≤ 5분 | watcher 로그 |
| 팀 온보딩 | 신규 머신에서 `team join` + `import --from-repo` 후 10분 내 Project Brief 사용 가능 | 온보딩 리허설 |
| Hook latency | UserPromptSubmit p95 ≤ 기존 대비 +0ms (백그라운드화) | hook telemetry |
| No-match accuracy | ≥ 1.0 for trap/no-match replay cases | `eval:retrieval-replay` threshold |
| Forbidden/cross-project hits | 0 | replay + source-scope fixtures |
| Stale completed-action resurfacing | 0 for generic continuation prompts | frontier/context-pack fixtures |
| Privacy/path leak | 0 raw local paths, transcript DB paths, credential-looking values in public/API/dashboard/export output | sanitizer tests + `git diff`/Markdown scan |
| Health report freshness | `health --productivity` p95 ≤ 3s on typical project DB | CLI/API smoke |
| Curated memory 활용률 | 목표치는 FR-A7 출시 후 field baseline 측정으로 설정 (임의 목표 금지) | curated artifact별 recall trace + direct label 연결 (생성→recall→행동 변화 사이클 추적) |

## 6. Non-Goals

- **실시간 multi-agent broker/mesh**: 에이전트 간 실시간 메시징은 하지 않는다(`ARCHITECTURE_COMPARISON` 경고). 공유는 비동기(이벤트 복제 + 증류물 배포)로만.
- **canonical store 교체/추가**: SQLite가 유일한 canonical(manifest 원칙). Mongo/git export는 replica/projection이다.
- **LLM 기반 증류의 외부 API 의존 기본화**: Brief 증류는 rule-based + 기존 요약 파이프라인 우선. LLM 증류는 opt-in extension.
- **전체 코드 그래프 인덱싱**: 코드 이해는 에이전트 본연의 도구에 맡기고, CML은 "대화/결정/작업 기억"에 집중한다.
- **테이블 rename / 스키마 대개편**: 기존 ~40 테이블 위에 추가만 한다.
- **Dashboard-first 구현**: UI를 먼저 만들고 나중에 core/service/API를 맞추지 않는다. Dashboard는 검증된 read-only service output의 소비자다.
- **Raw team memory lake**: 팀 공유는 raw transcript/event lake가 아니다. 공유는 curated/export-reviewed artifact 중심으로만 시작한다.

## 7. Implementation Phases

### Phase 0 — Baseline & Guardrails (필수 선행)

**Goal:** 기능 개발 전에 현재 상태를 재현 가능한 수치와 safety gate로 고정한다.

**Scope:**
- `npm run verify`
- `npm run eval:retrieval-replay`
- `npm run eval:longmemeval:retrieval-smoke` 또는 현재 가능한 retrieval smoke
- context-pack / mem-frontier / retrieval trace의 aggregate report
- public Markdown/API/dashboard/export output privacy scan

**Exit criteria:**
- baseline markdown report가 생성된다.
- generic continuation, decision recall, no-match, cross-project trap, stale/superseded trap fixture가 최소 1개씩 있다.
- forbidden hit/cross-project leak/privacy leak 기준이 명시된다.
- 이후 Phase가 이 baseline 대비 delta를 기록할 수 있다.

### Phase 1 — SourceAdapter + ProjectBrief MVP

**Goal:** Claude/Codex/Hermes source를 표준 contract로 정렬하고, raw event 대신 Project Brief를 만드는 최소 경로를 구현한다.

**Scope:**
- existing `source-adapter` contract test 확장
- Claude/Codex/Hermes currentness strategy 문서화
- canonical repo identity resolver + legacy store alias dry-run
- graduation/consolidation liveness와 Brief readiness gate
- Project Brief derived artifact 저장/조회
- `mem-context-pack`에서 Brief를 source-ref 보존 형태로 포함

**Exit criteria:**
- 같은 repo에서 Claude/Codex/Hermes import 후 하나의 Project Brief로 수렴한다.
- eligible derived input은 worker result를 남기며 `pipeline_never_run`은 Brief-ready로 오판되지 않는다.
- Brief에 raw transcript/local path/token이 노출되지 않는다.
- stale session보다 active frontier/checkpoint가 우선된다.

### Phase 2 — Frontier / Actions / Lessons Product Loop

**Goal:** 새 agent가 프로젝트를 열었을 때 바로 “무엇을 이어서 해야 하는지” 알 수 있게 한다.

**Scope:**
- `mem-frontier` 품질 강화
- `memory_actions` lifecycle hardening (`pending → in_progress → blocked/done/cancelled`)
- lesson promotion workflow (`memory_lesson → skill/runbook candidate`)
- `health --productivity` Project Health Report MVP

**Exit criteria:**
- completed/cancelled action이 generic continuation next action으로 재등장하지 않는다.
- blocked work와 resume checkpoint가 안전하게 구분된다.
- Project Health Report가 CLI/API로 먼저 동작하고, raw content 없이 actionable next steps를 제공한다.

### Phase 3 — Profile-aware Context Injection

**Goal:** 역할별 agent context를 제공하되 자동 주입은 단계적으로 안전하게 승격한다.

**Scope:**
- Agent Context Profile schema
- observe mode telemetry
- preview mode output
- enforce mode gates(confidence/scope/freshness/privacy/token)

**Exit criteria:**
- replay/safety gate 전까지 enforce mode는 기본값이 아니다.
- ambiguous project scope 또는 low confidence에서는 주입하지 않는다.
- profile별 exclusion rule이 테스트된다(reviewer/team/pm 등).

### Phase 4 — Dashboard v2 as Thin Visualization

**Goal:** Dashboard를 core logic 복제 없이 health/frontier/trace/review queue의 가시화 계층으로 만든다.

**Scope:**
- Project Health Report rendering
- retrieval trace explorer(aggregate/safe fields only)
- frontier board
- lesson/action review queue

**Exit criteria:**
- Dashboard endpoint와 UI는 read-only service/API 결과만 소비한다.
- root render뿐 아니라 `/api/health`, stats subroutes, health report API, browser console smoke가 통과한다.
- raw query/raw prompt/local path/secret이 dashboard payload에 노출되지 않는다.

### Phase 5 — Team Sharing / Collective Intelligence

**Goal:** 팀/회사 단위 공유는 curated artifact governance 이후에만 활성화한다.

**Scope:**
- Shareable Memory Bundle
- export dry-run/diff/review
- `export --repo` / `import --from-repo`
- team hub sync private-tags/redaction/actor boundary

**Exit criteria:**
- raw event export 없이 팀 onboarding pack을 만들 수 있다.
- secret/path/private-perspective leak test가 0이다.
- export audit/retention/revocation path가 존재한다.
- team/project boundary fixture가 통과한다.

## 8. Global Acceptance Criteria

- 모든 Phase는 `npm run verify`를 통과해야 한다.
- retrieval/context 관련 Phase는 `npm run eval:retrieval-replay` 또는 해당 Phase의 thresholded replay gate를 통과해야 한다.
- 자동 주입 경로는 observe-only mode를 지원해야 하며, enforce mode는 gate 통과 후에만 기본값 후보가 된다.
- 모든 context-producing feature는 source ref를 보존하되 raw local path/transcript path/credential-looking value를 노출하지 않는다.
- cross-project leakage fixture의 forbidden hit count는 0이어야 한다.
- generic continuation query는 stale completed session보다 active frontier/checkpoint를 우선해야 한다.
- Team/export 기능은 raw event가 아니라 curated artifact bundle만 공유해야 한다.
- Dashboard는 검증된 core/service/API output을 렌더링하며 독자적인 memory selection logic을 갖지 않는다.
- Migration/backfill은 dry-run과 aggregate report를 먼저 제공해야 하며, legacy row repair/quarantine은 raw content를 기본 출력하지 않는다.
- 성능 예산: `mem-frontier` p95 ≤ 1s, 일반 `mem-context-pack` p95 ≤ 2s, refresh 포함 generic continuation p95 ≤ 5s, health report p95 ≤ 3s를 목표로 한다.

## 9. Rollout (팀/회사 확산 시나리오)

1. **개인**: `npm i -g claude-memory-layer && claude-memory-layer install` (현행과 동일) → Pillar A/B 혜택 즉시.
2. **팀 (zero-install 소비)**: 리드가 `export --repo`로 curated memory를 PR → 팀원은 repo만 pull해도 에이전트가 `memory/*.md`를 읽음.
3. **팀 (full)**: 사내 MongoDB 1개 준비 → 각자 `claude-memory-layer team join <uri>` → 이벤트 자동 공유.
4. **회사**: bootstrap 생성기가 만든 AGENTS.md 스니펫을 사내 repo 템플릿에 포함 → 모든 신규 프로젝트가 기본으로 memory-aware.
