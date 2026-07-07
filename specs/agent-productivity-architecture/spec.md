# Spec: Agent Productivity Architecture (Token-Efficient Shared Context)

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-07-07
> **Target repo**: `claude-memory-layer`
> **Related specs**: `progressive-disclosure`, `memory-utilization-improvements`, `thin-core-refactor`, `honcho-inspired-peer-context-memory`, `private-tags`, `selective-tool-observation`, `endless-mode`, `citations-system`
> **Related docs**: `docs/HERMES_CML_HEADROOM_OPERATING_MODEL.md`, `docs/architecture/memory-layer-manifest.md`, `docs/TARGET_ARCHITECTURE_AND_FOLDER_STRUCTURE.md`, `docs/MEMORY_USEFULNESS_AUDIT.md`, `docs/ARCHITECTURE_COMPARISON_AND_RECOMMENDATIONS.md`

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
| **Turn Injection Budget** | UserPromptSubmit에서 주입되는 retrieved memory의 상한. high-confidence(score-cliff 통과)만, citation 포함 | ≤ 800 tokens/turn |
| **Pull-based Detail** | 주입은 요약+citation까지만. 상세는 에이전트가 `mem-source-ref`/`expand`로 필요 시 직접 pull (progressive disclosure Layer 2/3) | 에이전트 재량 |
| **Curated Export** | privacy-filter + human review(PR)를 거쳐 repo에 커밋되는 markdown 메모리 (`memory/` 디렉토리). CML 미설치 팀원도 소비 가능 | 파일 기준 관리 |
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

**FR-A2. SessionStart 주입 교체**
- SessionStart hook은 "최근 이벤트 3건" 대신 Project Brief를 주입해야 한다(MUST). Brief 부재 시(신규 프로젝트) 기존 동작으로 fallback.

**FR-A3. High-confidence-only turn injection**
- UserPromptSubmit 주입은 CLI search보다 엄격한 기준을 적용해야 한다(MUST): score-cliff cutoff(인접 결과 간 점수 급락 지점에서 절단) + 절대 min-score 상향.
- 주입 형식은 `요약 + [mem:id] citation`으로 통일하고, turn당 총 주입량 ≤800 tokens를 강제한다.
- 상세 내용이 필요하면 에이전트가 `mem-source-ref`/`mem-details`로 pull하도록 주입 텍스트에 1줄 안내를 포함한다.

**FR-A4. Read-path 경량화**
- `stats`, keyword-only search 등 읽기 경로에서 embedder/model 초기화를 제거해야 한다(MUST). (`MEMORY_USEFULNESS_AUDIT` next-step 승계)

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

### Pillar C — Team Sharing (2-tier)

**FR-C1. Privacy gate (선행 조건)**
- 모든 export/sync 경로는 privacy filter + private-tags 검사를 통과한 항목만 내보내야 한다(MUST). `private-tags` spec의 최소 슬라이스(태그 지정 + export 차단)를 본 spec Phase 4에서 구현한다.
- secret/credential 패턴 detected 항목은 태그와 무관하게 항상 차단.

**FR-C2. Tier 1 — Git-committed curated memory**
- `claude-memory-layer export --repo <path>`는 Project Brief + 활성 결정 + lessons를 대상 repo의 `memory/` 아래 사람이 읽을 수 있는 markdown으로 내보내야 한다(MUST). (MarkdownMirror의 repo-target 버전; 현재 mirror는 storage dir 전용)
- Export는 항상 명시적 실행 + git diff로 리뷰 가능해야 하며(PR 게이트), 자동 커밋하지 않는다.
- 역방향: `claude-memory-layer import --from-repo`는 repo에 커밋된 curated memory를 로컬 CML 스토어에 반영한다. CML 미설치 팀원의 에이전트도 markdown을 직접 읽어 혜택을 받는다(zero-install 소비).

**FR-C3. Tier 2 — Team hub sync**
- 기존 mongo-sync를 team mode로 확장해야 한다(SHOULD): actor identity(honcho actor 모델 재사용)를 이벤트에 유지, pull 시 private-tags/redaction 적용, 프로젝트 키 충돌 방지(정규화된 repo identity — 예: git remote URL 기반 projectKey 옵션).
- `claude-memory-layer team join <uri>` 한 줄로 온보딩: 설정 저장 + 초기 pull + watch 등록.
- 세션 시작 시 background non-blocking pull로 팀 이벤트를 반영한다(hook latency에 영향 금지).

### Pillar D — Measurement

**FR-D1. Token accounting**
- CML은 세션별로 다음을 기록해야 한다(MUST): 주입 토큰 수(SessionStart/UserPromptSubmit 각각), retrieval 채택률(기존 retrieval_traces 확장), 첫 Edit/Write 이전 Read/Grep/Glob 호출 수(exploration cost).
- 결과는 dashboard KPI 카드와 `stats --productivity`로 노출한다.

**FR-D2. A/B 검증**
- replay-evaluator를 확장해 "CML 주입 on/off" 비교 fixture를 지원해야 한다(SHOULD). 최소 20개 실세션 기반 시나리오로 exploration cost 절감률을 산출한다.

**FR-D3. KPI thresholds 확장**
- `config/kpi-thresholds.json`에 본 spec의 KPI(§5)를 추가하고 dashboard에서 통과/미달을 표시한다.

## 5. Success Criteria (KPI)

| KPI | 목표 | 측정 방법 |
|-----|------|----------|
| 세션당 주입 토큰 | ≤ 2,300 (Brief 1,500 + turn 800) | FR-D1 token accounting |
| Exploration cost 절감 | Read/Grep/Glob 호출 40%↓ (CML off 대비) | FR-D2 A/B replay |
| Useful recall rate | ≥ 0.45 (기존 threshold 유지) | retrieval_traces + helpfulness |
| 주입 노이즈 | 주입 memory 중 미사용 비율 ≤ 30% | retrieval trace 채택 추적 |
| Cross-agent 신선도 | Codex/Hermes 세션 종료 → 조회 가능 ≤ 5분 | watcher 로그 |
| 팀 온보딩 | 신규 머신에서 `team join` + `import --from-repo` 후 10분 내 Project Brief 사용 가능 | 온보딩 리허설 |
| Hook latency | UserPromptSubmit p95 ≤ 기존 대비 +0ms (백그라운드화) | hook telemetry |

## 6. Non-Goals

- **실시간 multi-agent broker/mesh**: 에이전트 간 실시간 메시징은 하지 않는다(`ARCHITECTURE_COMPARISON` 경고). 공유는 비동기(이벤트 복제 + 증류물 배포)로만.
- **canonical store 교체/추가**: SQLite가 유일한 canonical(manifest 원칙). Mongo/git export는 replica/projection이다.
- **LLM 기반 증류의 외부 API 의존 기본화**: Brief 증류는 rule-based + 기존 요약 파이프라인 우선. LLM 증류는 opt-in extension.
- **전체 코드 그래프 인덱싱**: 코드 이해는 에이전트 본연의 도구에 맡기고, CML은 "대화/결정/작업 기억"에 집중한다.
- **테이블 rename / 스키마 대개편**: 기존 ~40 테이블 위에 추가만 한다.

## 7. Rollout (팀/회사 확산 시나리오)

1. **개인**: `npm i -g claude-memory-layer && claude-memory-layer install` (현행과 동일) → Pillar A/B 혜택 즉시.
2. **팀 (zero-install 소비)**: 리드가 `export --repo`로 curated memory를 PR → 팀원은 repo만 pull해도 에이전트가 `memory/*.md`를 읽음.
3. **팀 (full)**: 사내 MongoDB 1개 준비 → 각자 `claude-memory-layer team join <uri>` → 이벤트 자동 공유.
4. **회사**: bootstrap 생성기가 만든 AGENTS.md 스니펫을 사내 repo 템플릿에 포함 → 모든 신규 프로젝트가 기본으로 memory-aware.
