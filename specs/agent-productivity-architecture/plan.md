# Plan: Agent Productivity Architecture

## 전체 목표

spec.md의 4 Pillars(Budgeted Context / One Memory N Agents / Team Sharing / Measurement)를
"측정 → 주입 품질 → 증류 → 멀티에이전트 → 팀 공유 → 검증/롤아웃" 순서로 구현한다.

원칙:

- **Measure first**: 개선 전에 baseline을 계측한다 (Phase 0이 모든 Phase의 전제).
- **thin-core boundary 준수**: core는 adapters/apps를 import하지 않는다. 신규 기능은 가능한 한 `src/extensions/` 또는 `src/adapters/`에 배치. `npm run check:architecture` green 유지.
- **manifest 원칙 준수**: SQLite가 canonical. Brief/git export/mongo는 전부 derived/replica.
- **hook latency 불변**: 어떤 Phase도 UserPromptSubmit/SessionStart의 p95 latency를 늘리지 않는다 (무거운 작업은 daemon/worker로).

---

## Phase 0: Baseline Measurement (1주차) — P0

### Task 0.1 — Token accounting 계측 (APA-01)

**목표**: 개선 효과를 증명할 수 있는 baseline 확보

**작업 단계**:

1. `src/adapters/claude/hooks/session-start.ts`, `user-prompt-submit.ts`에 주입 텍스트의 추정 토큰 수 기록 추가
   - 신규 테이블 `injection_metrics(session_id, hook, injected_tokens, memory_count, created_at)` — `sqlite-event-store.ts`에 추가
2. `post-tool-use.ts` 경유 데이터로 exploration cost 산출: 세션 내 첫 Write/Edit 이전의 Read/Grep/Glob 호출 수
   - 저장은 하지 않는 excluded tool도 **카운트만** 증분 (경량 카운터, `injection_metrics` 또는 세션 메타에 기록)
3. `stats --productivity` CLI 출력 추가 (`src/apps/cli/`)

**완료 조건**: 1주일 실사용 후 `stats --productivity`에서 세션당 주입 토큰/탐색 콜 수 baseline 리포트 확인

### Task 0.2 — KPI thresholds 확장 (APA-02)

- [ ] `config/kpi-thresholds.json`에 `injectedTokensPerSessionMax`, `explorationCallReductionMin`, `injectionWasteRateMax`, `crossAgentFreshnessMinutesMax` 추가
- [ ] `src/core/product-validation-matrix.ts` 및 dashboard stats API에 신규 KPI 반영

---

## Phase 1: Injection Quality & Budget (1~2주차) — P0 (Pillar A 전반부)

### Task 1.1 — High-confidence-only 주입 + score-cliff (APA-03)

**목표**: 주입 노이즈 제거 — 주입 기준을 CLI search보다 엄격하게 (FR-A3)

1. `src/core/engine/retrieval-orchestrator.ts`에 score-cliff cutoff 유틸 추가 (인접 결과 점수 급락 지점 절단; `retrieval-quality.ts`의 기존 필터와 합성)
2. `user-prompt-submit.ts` 주입 경로에만 `CLAUDE_MEMORY_INJECT_MIN_SCORE`(기본값 CLI min-score보다 높게) 적용
3. 주입 포맷을 `요약 1줄 + [mem:id]` citation으로 통일, "상세는 mem-source-ref로 조회" 안내 1줄 포함
4. turn당 총 주입 예산 800 tokens 강제 (초과 시 하위 score부터 제외)

- [ ] score-cliff 유틸 + 단위 테스트
- [ ] 주입 전용 min-score 분리
- [ ] citation 포맷 + 예산 강제
- [ ] retrieval_traces에 "주입되었으나 미채택" 추적 필드 확인/보강

### Task 1.2 — Read-path 경량화 (APA-04)

- [ ] `stats`, keyword/fast search 경로에서 embedder 초기화 지연(lazy) 확인 및 제거 (MEMORY_USEFULNESS_AUDIT next-step)
- [ ] hook 경로가 lightweight service만 사용함을 회귀 테스트로 고정

---

## Phase 2: Project Brief 증류 (2~4주차) — P0 (Pillar A 후반부)

### Task 2.1 — Brief 데이터 모델 + 증류기 (APA-05)

**목표**: 프로젝트당 1개, ≤1,500 tokens의 지속 갱신 Brief (FR-A1)

1. `project_briefs(project_hash, section, content, source_refs, tokens, updated_at)` 테이블 추가
2. `src/core/derive/brief-distiller.ts` 신규: graduated memory(L1+) + operations layer(actions/frontier/lessons) + session summaries에서 섹션별 증류
   - 섹션: 아키텍처 개요 / 활성 결정(+citation) / Action Frontier / Lessons
   - rule-based 우선 (기존 summary-deriver 패턴 재사용), LLM 증류는 extension으로 분리
3. consolidation-worker에 staleness 트리거 연결 (유의미 이벤트 N건 누적 시 재증류)
4. 토큰 예산 강제: 섹션별 상한 + 전체 1,500 초과 시 저가치 항목 축출

- [ ] 테이블 + repository
- [ ] brief-distiller + 단위 테스트 (예산 강제 포함)
- [ ] worker 연결 (full-mode에서만; hook은 읽기 전용)

### Task 2.2 — SessionStart 주입 교체 (APA-06)

- [ ] `session-start.ts`: Brief 존재 시 Brief 주입, 부재 시 기존 "최근 이벤트 3건" fallback (FR-A2)
- [ ] `mem-context-pack` 응답 상단에 Brief 포함 (Codex/Hermes도 동일 혜택)
- [ ] injection_metrics로 Brief 주입 토큰 기록

### Task 2.3 — Brief 품질 검증 (APA-07)

- [ ] 실프로젝트 2개(예: claude-memory-layer 자신, k8s-manifests)에서 Brief 생성 후 수동 품질 점검
- [ ] replay fixture에 "Brief만으로 답할 수 있는 질문" 시나리오 추가

---

## Phase 3: One Memory, N Agents (4~6주차) — P1 (Pillar B)

### Task 3.1 — Codex/Hermes watcher ingest (APA-08)

**목표**: 수동 import → 자동 증분 (FR-B1, 신선도 ≤5분)

1. `src/extensions/watch/` 신규: `~/.codex/sessions/` 파일 감지 + `~/.hermes/state.db` 주기 스캔 (모두 read-only, 비활성 세션만)
2. 기존 importer(`codex-session-history-importer.ts`, `hermes-session-history-importer.ts`)를 증분 모드로 호출 (idempotent — 기존 dedup 재사용)
3. `claude-memory-layer watch enable|disable|status` CLI; 데몬은 semantic daemon 프로세스 모델 재사용
4. source adapter contract 준수 확인 (conformance suite 통과)

- [ ] watch extension + CLI
- [ ] codex 증분 경로 + 테스트
- [ ] hermes 증분 경로 + 테스트
- [ ] 신선도 로그/metric

### Task 3.2 — Bootstrap 생성기 (APA-09)

- [ ] `claude-memory-layer bootstrap [--repo <path>]`: AGENTS.md/CLAUDE.md에 "작업 시작 시 mem-context-pack 우선 호출" 스니펫 생성/갱신 (idempotent, 마커 주석으로 구획) (FR-B2)
- [ ] Claude Code/Codex/Hermes 3종 설정 통합 가이드 문서 생성

### Task 3.3 — MCP core profile (APA-10)

- [ ] MCP 서버에 `--profile core|full` 추가 (core 기본: context-pack, search, source-ref, project-timeline, frontier, lesson-list) (FR-B3)
- [ ] 프로파일별 도구 노출 테스트

---

## Phase 4: Team Sharing (6~8주차) — P1 (Pillar C)

### Task 4.1 — Private-tags 최소 슬라이스 (APA-11) ← 선행 조건

- [ ] `private-tags` spec에서 최소 범위 구현: 태그 지정 CLI/MCP + export/sync 경로 차단 (FR-C1)
- [ ] secret/credential 패턴은 태그 무관 항상 차단 (기존 privacy filter와 합성)

### Task 4.2 — Git export/import (Tier 1) (APA-12)

- [ ] `export --repo <path>`: Brief + 활성 결정 + lessons → `<repo>/memory/*.md` (privacy gate 통과분만, 자동 커밋 없음) (FR-C2)
- [ ] `import --from-repo`: 커밋된 curated memory를 로컬 스토어로 반영 (idempotent)
- [ ] MarkdownMirror repo-target 모드 (현재 storage-dir 전용 → 대상 디렉토리 옵션화)
- [ ] export 산출물 포맷 문서화 (CML 미설치 에이전트도 읽기 좋은 구조)

### Task 4.3 — Team hub sync (Tier 2) (APA-13)

- [ ] mongo-sync team mode: actor identity 유지 + pull 시 private-tags/redaction 적용 (FR-C3)
- [ ] projectKey 정규화 옵션 (git remote URL 기반) — 머신 간 경로 차이 해결
- [ ] `team join <uri>`: 설정 저장 + 초기 pull + watch 등록 원커맨드
- [ ] 세션 시작 background non-blocking pull (hook latency 영향 0 검증)

---

## Phase 5: Verification & Rollout (8~9주차) — P1 (Pillar D 완성)

### Task 5.1 — A/B replay 검증 (APA-14)

- [ ] replay-evaluator에 injection on/off 비교 모드 추가 (FR-D2)
- [ ] 실세션 20개 이상 anonymized fixture로 exploration cost 절감률 산출
- [ ] KPI 표(§5) 전 항목 측정 리포트 생성

### Task 5.2 — Dashboard + 문서 + 사내 롤아웃 (APA-15)

- [ ] dashboard에 Productivity KPI 카드 (주입 토큰/탐색 절감/노이즈율/신선도)
- [ ] README에 팀 온보딩 절차(§7 Rollout) 반영
- [ ] 사내 파일럿: 1개 팀 repo에 bootstrap + export 적용 → 2주 후 KPI 리뷰

---

## 검증 계획

| 단계 | 검증 |
|------|------|
| 매 Phase | `npm run verify` (typecheck + lint + test) + `npm run check:architecture` green |
| Phase 0 종료 | baseline 리포트 존재 (주입 토큰, 탐색 콜 수) |
| Phase 1 종료 | 주입 노이즈율(미채택 비율) baseline 대비 감소 확인, hook p95 latency 회귀 없음 |
| Phase 2 종료 | Brief ≤1,500 tokens 강제 테스트, 실프로젝트 2개 품질 점검 통과 |
| Phase 3 종료 | Codex/Hermes 신선도 ≤5분 실측, conformance suite 통과 |
| Phase 4 종료 | privacy gate 우회 불가 테스트 (private-tag/secret 포함 항목 export 차단), 팀 온보딩 리허설 ≤10분 |
| Phase 5 종료 | KPI 표 전 항목 목표 달성 여부 리포트, `eval:retrieval-replay` gate green |

## 담당 파일 목록

| 영역 | 파일 |
|------|------|
| Hooks | `src/adapters/claude/hooks/session-start.ts`, `user-prompt-submit.ts`, `post-tool-use.ts` |
| Retrieval | `src/core/engine/retrieval-orchestrator.ts`, `src/core/retrieval-quality.ts`, `src/core/retriever.ts` |
| 증류 | `src/core/derive/brief-distiller.ts`(신규), `src/core/consolidation-worker.ts`, `src/core/sqlite-event-store.ts`(테이블 추가) |
| Watch | `src/extensions/watch/`(신규), `src/services/codex-session-history-importer.ts`, `hermes-session-history-importer.ts` |
| Export/Sync | `src/core/markdown-mirror.ts`, `src/core/mongo-sync-worker.ts`, `src/apps/cli/mongo-sync-command.ts` |
| Privacy | `src/core/privacy/` (private-tags 최소 슬라이스) |
| CLI/MCP | `src/apps/cli/index.ts`(bootstrap/watch/team/export), `src/extensions/mcp/`(core profile) |
| 계측 | `config/kpi-thresholds.json`, `src/core/product-validation-matrix.ts`, `src/apps/server/api/stats.ts`, dashboard assets |
| 평가 | `src/core/replay-evaluator.ts`, `benchmarks/replay/` |
