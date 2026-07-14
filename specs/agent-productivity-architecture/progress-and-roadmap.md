# Agent Productivity Architecture — Progress & Roadmap

> **As of**: 2026-07-14 KST
>
> **Target repository**: `claude-memory-layer`
>
> **Primary spec**: [`spec.md`](./spec.md) v1.0.1
>
> **Current released version**: `claude-memory-layer@1.0.55`
>
> **Purpose**: 지금까지 실제로 완료·검증·배포된 범위와 앞으로의 실행 순서를 한 문서에서 추적한다.

---

## 1. Executive Summary

Agent Productivity Architecture의 **Phase 0 baseline/guardrail과 Project Health Report MVP는 구현·merge·npm 배포까지 완료**됐다.

현재 확보된 기반은 다음과 같다.

- 재현 가능한 retrieval baseline과 deterministic LongMemEval mini smoke
- public-output privacy scanner와 npm release privacy gate
- aggregate-only Project Health Report core/CLI/API MVP
- invalid profile/mode 및 missing project storage에 대한 fail-closed/read-only 동작
- npm release 자동화, tarball 검사, fresh-install smoke
- Node 18/20/22 CI 통과

다만 전체 목표인 “에이전트가 더 적은 토큰으로 프로젝트 전체 맥락을 이해하고, 여러 에이전트와 팀이 안전하게 공유”하는 제품 루프는 아직 초기 단계다.

가장 중요한 다음 순서는 다음과 같다.

1. **측정 완성**: 실제 injection token과 exploration cost를 계측한다.
2. **Health Report 확장**: frontier, memory quality, import freshness, Brief readiness를 같은 schema에 추가한다.
3. **Project Brief MVP**: raw event 대신 ≤1,500-token distilled context를 만든다.
4. **Observe/preview injection**: 자동 주입 전에 profile/scope/confidence/privacy gate를 검증한다.
5. **Multi-agent freshness**: Codex/Hermes watcher와 bootstrap을 구현한다.
6. **Dashboard → Team sharing** 순서로 확장한다.

`plan.md`의 옛 Phase 0은 token accounting으로 시작하지만, 최신 `spec.md §7`은 Phase 0을 baseline/guardrail로 정의한다. 이 문서에서는 **최신 `spec.md`의 phase 번호를 기준**으로 하며, token accounting은 아직 남아 있는 **FR-D1 P0 후속 작업**으로 분류한다.

---

## 2. Completed Work

### 2.1 Architecture review and plan hardening

완료한 내용:

- Agent Productivity Architecture를 4개 Pillar로 정리했다.
  - Pillar A: Budgeted Context
  - Pillar B: One Memory, N Agents
  - Pillar C: Team Sharing
  - Pillar D: Measurement
- “기능 먼저”가 아니라 **baseline과 safety gate 먼저**라는 sequencing rule을 추가했다.
- 자동 주입을 `observe → preview → enforce`로 단계적으로 승격하도록 정했다.
- 팀 공유 단위를 raw transcript/event가 아닌 **Shareable Memory Bundle**로 제한했다.
- Dashboard를 business logic 계층이 아닌 **CLI/API output의 thin visualization**으로 제한했다.
- privacy/path/credential leak zero 기준과 fail-closed 원칙을 global acceptance criteria에 포함했다.

주요 문서:

- [`spec.md`](./spec.md)
- [`plan.md`](./plan.md)
- [`context.md`](./context.md)
- [`project-health-report-schema.md`](./project-health-report-schema.md)

### 2.2 Phase 0 baseline and deterministic evaluation gates

완료한 내용:

- 현재 main의 retrieval/usefulness 기준선을 [`phase-0-baseline.md`](./phase-0-baseline.md)에 고정했다.
- Golden replay에서 다음 회귀 유형을 다룬다.
  - generic continuation
  - Korean short follow-up
  - decision recall
  - no-match/topic shift
  - cross-project contamination
  - stale/superseded continuation
  - compaction handoff noise
- LongMemEval retrieval smoke가 외부 dataset 없이 fresh clone에서도 실행되도록 mini fixture를 추가했다.
- full public dataset은 저장소에 커밋하지 않고 explicit input으로만 평가하도록 유지했다.

관련 파일:

- `benchmarks/longmemeval/fixtures/retrieval-smoke-mini.json`
- `benchmarks/longmemeval/README.md`
- `tests/apps/longmemeval-retrieval-smoke-cli.test.ts`

현재 고정된 주요 baseline:

| Metric | Baseline |
|---|---:|
| Golden replay failed queries | 0 |
| Golden replay forbidden hits | 0 |
| Golden replay no-match accuracy | 1.0 |
| Golden replay query yield | 1.0 |
| LongMemEval explicit-input Recall_any@10 | 0.8809 |
| LongMemEval explicit-input nDCG@10 | 0.749 |
| LongMemEval explicit-input MRR | 0.771 |
| Public-output privacy findings | 0 |

### 2.3 Public-output privacy gate

완료한 내용:

- 공개 Markdown/API/dashboard/export 산출물을 검사하는 공통 scanner를 구현했다.
- local absolute path, credential-looking value 등 금지 class를 발견하면 fail-closed한다.
- 실패 시 원문 값을 출력하지 않고 class/count만 노출하도록 했다.
- npm script와 release script에 scanner를 연결했다.

관련 파일:

- `src/core/privacy/public-output-scanner.ts`
- `src/core/privacy/index.ts`
- `scripts/scan-public-output-privacy.ts`
- `tests/apps/public-output-privacy-scan-cli.test.ts`

검증 명령:

```bash
npm run check:public-output-privacy -- --json
```

### 2.4 Project Health Report Phase 0 MVP

완료한 내용:

- 공통 report builder를 구현했다.
- CLI와 read-only API가 동일한 aggregate contract를 사용한다.
- 다음 정보를 안전한 JSON으로 제공한다.
  - project/profile/mode
  - storage event/vector aggregate
  - embedding/vector outbox aggregate
  - project scope/outbox/memory-density risk gates
  - safe next best action
- raw prompt/query/memory body/local path/transcript path/credential value를 포함하지 않는다.
- unsupported profile/mode는 storage 초기화 전에 validation error를 반환한다.
- project storage가 없으면 service/DB를 생성하지 않고 zero aggregate report를 반환한다.
- Phase 0에서는 JSON만 지원하고 human renderer는 schema 안정화 이후로 미뤘다.

관련 파일:

- `src/core/productivity-health-report.ts`
- `src/apps/cli/index.ts`
- `src/apps/server/api/health.ts`
- `tests/apps/productivity-health-cli.test.ts`
- `tests/apps/productivity-health-api.test.ts`

사용 예:

```bash
claude-memory-layer health --productivity --json --project .
```

### 2.5 Release safety automation

완료한 내용:

- patch/minor/major/exact-version release script를 추가했다.
- release 전에 다음 gate를 실행한다.
  - clean tracked worktree
  - npm identity
  - self-dependency 방지
  - version immutability
  - production dependency audit
  - typecheck/lint/test/build
  - `npm pack --dry-run` suspicious file 검사
  - credential-shaped diff scan
  - public-output privacy scan
  - exact tarball fresh-install smoke
- publish 후 registry verification, fresh install, tag/push를 수행하도록 했다.

관련 파일:

- `scripts/release-npm.sh`
- `tests/apps/release-npm-script.test.ts`
- `package.json`

### 2.6 Merge and release

완료된 외부 결과:

- PR: [#32 — Agent productivity Phase 0 health gates](https://github.com/buzzni/claude-memory-layer/pull/32)
- Merge commit: `60c4578fb36c8771486944806640dfefff127e44`
- Release commit: `5de3cdfa98fab065a14e7059f47fff2bdad26269`
- Git tag: `v1.0.55`
- npm: `claude-memory-layer@1.0.55`
- Release CI: [GitHub Actions run 28930713883](https://github.com/buzzni/claude-memory-layer/actions/runs/28930713883)

Release validation:

- Typecheck: PASS
- Lint: PASS with 41 pre-existing warnings, 0 errors
- Vitest: **154 files / 888 tests PASS**
- Build: PASS
- Architecture import boundaries: PASS
- Production audit: 0 vulnerabilities
- Packed tarball smoke: PASS
- Registry fresh-install smoke: PASS
- CLI version from fresh install: `1.0.55`
- Node 18/20/22 CI: PASS

---

## 3. Current Status Matrix

Status legend:

- **Done**: 구현, 테스트, merge/release까지 완료
- **Partial**: 일부 contract/MVP 또는 기존 기반만 존재
- **Not started**: 본 spec 기준 구현이 아직 시작되지 않음

### 3.1 Functional requirement status

| Requirement | Status | Current evidence / gap |
|---|---|---|
| FR-A1 Project Brief distillation | Not started | schema/repository/distiller/worker trigger 필요 |
| FR-A2 SessionStart Brief injection | Not started | Brief 존재 시 교체 + fallback 필요 |
| FR-A3 High-confidence turn injection | Not started | score-cliff, strict min score, citation, 800-token budget 필요 |
| FR-A4 Read-path lightweight | Partial | dashboard/stats lightweight 회귀 테스트는 있으나 전체 keyword/hook 경로 audit 필요 |
| FR-A5 Project Health Report | Partial | Phase 0 aggregate CLI/API MVP Done; Phase 2 target fields 미구현 |
| FR-A6 Injection safety modes | Not started | observe/preview/enforce telemetry와 gate 필요 |
| FR-B1 Codex/Hermes incremental watcher | Not started | manual/bounded refresh는 있으나 opt-in watcher 없음 |
| FR-B2 Bootstrap generator | Not started | repo의 AGENTS.md pattern은 있으나 generator 없음 |
| FR-B3 MCP core profile | Not started | core/full tool exposure policy 필요 |
| FR-B4 Agent Context Profile | Not started | profile schema와 exclusion tests 필요 |
| FR-C1 Privacy/private-tags minimum slice | Partial | public-output scanner는 Done; private-tag export/sync enforcement 미구현 |
| FR-C1a Shareable Memory Bundle governance | Not started | manifest/audit/dry-run/revocation 필요 |
| FR-C2 Git curated export/import | Not started | repo-target curated export/import 필요 |
| FR-C3 Team hub mode | Not started | actor/privacy/project identity-aware sync 필요 |
| FR-D0 Reproducible baseline | Done | baseline report, replay, LongMemEval mini smoke, privacy gate |
| FR-D1 Token/exploration accounting | Not started | injection metrics와 first-edit exploration cost 필요 |
| FR-D2 A/B replay | Not started | injection on/off + anonymized real sessions 필요 |
| FR-D3 KPI thresholds | Not started | productivity KPI config/matrix/dashboard wiring 필요 |

### 3.2 Spec phase status

| Latest spec phase | Status | Notes |
|---|---|---|
| Phase 0 — Baseline & Guardrails | **Done** | baseline, deterministic smoke, privacy gate, health MVP |
| Phase 1 — SourceAdapter + ProjectBrief MVP | Not started | 다음 핵심 product phase |
| Phase 2 — Frontier / Actions / Lessons Product Loop | **Partial** | operations 기반은 존재; health MVP만 이번에 완료 |
| Phase 3 — Profile-aware Context Injection | Not started | enforce 기본화 금지 |
| Phase 4 — Dashboard v2 | Not started | health target contract 안정화 이후 진행 |
| Phase 5 — Team Sharing | Not started | curated bundle/private-tags 선행 필수 |

---

## 4. Current Operational Observations

### 4.1 Health report is actionable but local outbox needs maintenance

2026-07-14 local project smoke에서 Health Report는 다음을 반환했다.

- status: `needs-attention`
- project scope gate: pass
- memory density gate: pass
- outbox health gate: warn
- pending/processing rows: 0
- failed rows are quarantined rather than retryable
- suggested action: recovery dry-run 후 pending embedding 처리

이 상태는 `v1.0.55` publish 실패가 아니라 **현재 로컬 memory store의 운영 상태**다. 데이터 변형 전에 반드시 dry-run aggregate report로 원인을 분류해야 한다.

권장 확인:

```bash
claude-memory-layer process --dry-run-recovery
```

원칙:

- raw memory content를 보고서에 출력하지 않는다.
- quarantine 원인을 category/count로 먼저 분류한다.
- 자동 repair/apply는 dry-run 검토 전 실행하지 않는다.

### 4.2 npm registry propagation race discovered

`1.0.55` publish 자체는 성공했지만, publish 직후 첫 `npm view <exact-version>`가 registry 전파 지연으로 일시적 404를 반환해 release script가 중단됐다.

이후 확인 결과:

- npm `latest`: `1.0.55`
- exact version: 존재
- fresh install: PASS
- release commit/tag push: 완료

따라서 다음 release 전에 verification 단계에 bounded retry/backoff를 추가해야 한다. **publish 성공 신호 뒤 exact-version 조회가 잠시 실패했다고 같은 버전을 다시 publish하면 안 된다.**

### 4.3 Dependabot alert hygiene

GitHub에는 `vitest < 3.2.6`에 대한 critical dev-scope alert가 open 상태로 남아 있다. 현재 실제 manifest/lock/local install은 모두 `vitest 4.1.8`이므로 vulnerable range 밖이다.

후속 조치:

1. GitHub dependency graph가 최신 lockfile을 반영했는지 확인한다.
2. alert가 stale이면 근거를 남겨 dismiss/refresh한다.
3. `npm audit --omit=dev`와 fresh-install audit 0 vulnerabilities 결과를 runtime safety 근거로 유지한다.

---

## 5. Recommended Execution Roadmap

아래 순서는 최신 `spec.md`의 phase dependency를 유지하면서, 측정 누락과 이번 release 운영 이슈를 먼저 제거하도록 재정렬한 실행 순서다.

## Wave 0 — Operational hardening and measurement completion (P0)

### PR 0A — Make npm release verification propagation-safe

**Goal**: successful publish 후 일시적인 registry 404 때문에 release가 불완전하게 끝나지 않게 한다.

**Files**:

- Modify: `scripts/release-npm.sh`
- Modify: `tests/apps/release-npm-script.test.ts`

**Acceptance criteria**:

- exact-version verification에 bounded retry/backoff가 있다.
- publish 성공 이후 verification timeout 시 “중복 publish 금지” remediation을 출력한다.
- retry는 무한 대기하지 않는다.
- verification 성공 후 fresh-install/tag/push가 기존대로 진행된다.
- `bash -n scripts/release-npm.sh`와 focused tests가 통과한다.

### PR 0B — Add FR-D1 injection/exploration accounting

**Goal**: Project Brief와 injection을 만들기 전에 실제 생산성 delta를 측정할 수 있게 한다.

**Planned files**:

- Modify: `src/adapters/claude/hooks/session-start.ts`
- Modify: `src/adapters/claude/hooks/user-prompt-submit.ts`
- Modify: `src/adapters/claude/hooks/post-tool-use.ts`
- Modify or extract repository from: `src/core/sqlite-event-store.ts`
- Modify: `src/apps/cli/index.ts`
- Add focused tests under `tests/adapters/` and `tests/apps/`

**Metrics**:

- SessionStart injected token estimate
- UserPromptSubmit injected token estimate
- injected memory count
- first Edit/Write 전 Read/Grep/Glob count
- hook latency delta

**Acceptance criteria**:

- excluded tool observations are not persisted as raw content merely for accounting.
- metric writes do not block hook critical path.
- `stats --productivity` exposes aggregate-only values.
- no raw prompt/query/path is emitted.
- baseline report can record before/after delta.

### PR 0C — Extend Project Health Report toward target contract

**Goal**: Dashboard 구현 전에 CLI/API contract를 product-ready 수준으로 만든다.

**Additive target fields**:

- current frontier/action/checkpoint counts
- replay gate summary
- retrieval trace quality buckets
- Project Brief readiness
- import freshness by source
- redaction summary and safe evidence refs
- suggested maintenance list

**Files**:

- Modify: `src/core/productivity-health-report.ts`
- Modify: `src/apps/cli/index.ts`
- Modify: `src/apps/server/api/health.ts`
- Modify: `tests/apps/productivity-health-cli.test.ts`
- Modify: `tests/apps/productivity-health-api.test.ts`
- Update: `project-health-report-schema.md`

**Acceptance criteria**:

- Phase 0 fields remain backward-compatible.
- missing/legacy tables return safe `unknown` or zero state instead of failing.
- report p95 target is ≤3s on a typical project DB.
- all output remains aggregate-only and privacy scan passes.

## Wave 1 — Project Brief MVP (Spec Phase 1, P0 product milestone)

### PR 1A — Project Brief storage and repository

**Goal**: one canonical derived Brief per project, versioned and source-ref backed.

**Planned files**:

- Add repository/schema module under `src/core/`
- Add migration through the existing SQLite migration path
- Add unit/migration/legacy-schema tests

**Acceptance criteria**:

- SQLite remains canonical.
- Brief contains only derived L1+ data and safe source refs.
- Brief can be read without embedder/model initialization.
- legacy project DBs migrate safely.

### PR 1B — Rule-based Brief distiller and budget enforcement

**Sections**:

- architecture overview
- active decisions
- action frontier
- top lessons

**Acceptance criteria**:

- total estimated size ≤1,500 tokens.
- low-value/old entries are evicted deterministically.
- completed/cancelled stale actions are excluded.
- raw transcript/tool output/local path is excluded.
- output is reproducible without an external LLM API.

### PR 1C — Context-pack integration and replay fixture

**Acceptance criteria**:

- `mem-context-pack` includes the Brief while preserving source refs.
- active frontier/checkpoint wins over stale session summaries.
- same repo’s Claude/Codex/Hermes imports converge into one Brief.
- at least one “Brief-only answerable” deterministic fixture exists.
- generic continuation/no-match/cross-project gates remain green.

## Wave 2 — Frontier product loop and safe injection (Spec Phases 2–3)

### PR 2A — Harden action/frontier/lesson lifecycle

- completed/cancelled actions never resurface as next work
- blocked action and resumable checkpoint remain distinct
- lesson promotion emits skill/runbook candidates with bounded evidence
- health report uses these aggregates as the single source of truth

### PR 2B — Agent Context Profile schema

Profiles:

- `coder`
- `reviewer`
- `pm`
- `support`
- `researcher`
- `team`

Each profile defines:

- allowed/excluded memory types
- token budget
- freshness window
- privacy budget
- injection mode

### PR 2C — Observe and preview modes

**Sequence**:

1. Observe: record privacy-safe candidate telemetry without injection.
2. Preview: show bounded summary + source refs.
3. Enforce: remain opt-in until replay and safety criteria pass.

**Acceptance criteria**:

- ambiguous scope/confidence/privacy/freshness fails closed.
- reviewer/team/pm exclusion fixtures pass.
- total budget: Brief ≤1,500 tokens, turn injection ≤800 tokens.
- hook p95 does not regress.

## Wave 3 — One Memory, N Agents (P1)

### PR 3A — Codex/Hermes incremental watcher

- opt-in watcher only
- inactive/closed sessions only
- read-only source access
- idempotent incremental import
- target cross-agent freshness ≤5 minutes

### PR 3B — Bootstrap generator

```bash
claude-memory-layer bootstrap --repo <repo>
```

- idempotently updates marked AGENTS.md/CLAUDE.md blocks
- documents Claude Code/Codex/Hermes setup
- does not overwrite unrelated instructions

### PR 3C — MCP core/full profiles

- core default: context-pack, search, source-ref, project-timeline, frontier, lesson-list
- full profile: complete operations/tool surface
- tool exposure contract tests

## Wave 4 — Dashboard v2 thin visualization (P1)

Dashboard work begins only after Health Report target fields and observe/preview contracts stabilize.

Scope:

- Project Health cards
- safe retrieval trace explorer
- frontier board
- action/lesson review queue

Acceptance criteria:

- UI consumes read-only service/API outputs only.
- no memory selection/ranking logic is duplicated in UI.
- `/api/health`, stats routes, health report API, browser render, console smoke all pass.
- raw prompt/query/path/credential/private perspective never appears.

## Wave 5 — Curated team sharing (P1/P2)

### PR 5A — Private-tags minimum slice and bundle governance

- explicit private-tag classification
- export/sync enforcement
- credential detection always blocks
- dry-run manifest, redaction summary, audit record
- no raw event/transcript/tool observation bundle

### PR 5B — Git curated export/import

```bash
claude-memory-layer export --repo <repo>
claude-memory-layer import --from-repo <repo>
```

- exports Brief/active decisions/lessons/public runbooks only
- human-reviewable git diff
- never auto-commits
- idempotent import
- zero-install consumers can read committed Markdown

### PR 5C — Team hub mode

- actor identity preserved
- normalized repo identity instead of local path identity
- private-tags/redaction on pull and push
- background non-blocking sync
- onboarding rehearsal ≤10 minutes

## Wave 6 — A/B evaluation and rollout (P2)

- injection on/off replay mode
- at least 20 anonymized real-session scenarios
- exploration call reduction measurement
- injection waste rate measurement
- preference-category LongMemEval improvement
- pilot on one team repository for two weeks
- publish KPI delta report before making enforce mode a default candidate

Target KPI:

| KPI | Target |
|---|---:|
| Session injection budget | ≤2,300 tokens |
| Exploration calls | ≥40% reduction |
| Useful recall rate | ≥0.45 |
| Injection waste rate | ≤30% |
| Cross-agent freshness | ≤5 minutes |
| Forbidden/cross-project hits | 0 |
| Stale completed-action resurfacing | 0 |
| Privacy/path leak | 0 |
| Health report p95 | ≤3s |

---

## 6. Next Three Concrete Actions

실행 우선순위는 다음 세 개로 고정한다.

1. **Release retry hardening**
   - 이번 `1.0.55`에서 실제 발견한 propagation race를 회귀 테스트로 고정한다.
2. **FR-D1 measurement**
   - token/exploration baseline 없이는 이후 Brief/injection의 생산성 향상을 증명할 수 없다.
3. **Health Report target expansion**
   - Dashboard나 team sharing보다 먼저 core/CLI/API contract를 완성한다.

그 다음 Project Brief MVP로 이동한다.

---

## 7. Definition of Done for Every Future PR

모든 후속 PR은 다음을 만족해야 한다.

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

- TDD: failing test → minimal implementation → focused green → full green
- no new lint errors; warning count를 늘리지 않는다.
- context-producing output은 safe source ref를 보존한다.
- local path/transcript path/raw prompt/raw query/credential value를 출력하지 않는다.
- ambiguous project/privacy/confidence state는 fail-closed한다.
- migration/repair/export는 dry-run aggregate report를 먼저 제공한다.
- Dashboard는 core/service/API output만 렌더링한다.
- team sharing은 curated bundle만 허용한다.
- merge 전 독립 blocker review와 credential-value scan을 수행한다.
- release 시 exact-version immutability, tarball inspection, registry fresh-install smoke를 수행한다.

---

## 8. Document Maintenance Rules

- 이 문서는 작업 merge/release 후 갱신한다.
- 완료 판정은 계획이 아니라 **코드 + 테스트 + merge/release 증거**를 기준으로 한다.
- Phase/status 정의는 최신 [`spec.md`](./spec.md)를 우선한다.
- 상세 구현 계약은 [`project-health-report-schema.md`](./project-health-report-schema.md)를 따른다.
- 기준선 변경은 [`phase-0-baseline.md`](./phase-0-baseline.md)에 before/after delta로 기록한다.
- `plan.md`의 phase 번호가 최신 spec과 다르면 신규 구현자는 이 문서와 `spec.md §7`을 우선한다.
