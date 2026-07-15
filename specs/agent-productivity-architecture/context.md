# Context: Agent Productivity Architecture

## 1. 배경 (요구사항)

2026-07-07, 프로젝트 오너 요구:

> "각 code agent(Claude Code, Codex, Hermes)를 단독으로 사용하는 것보다 이 프로젝트를 같이 썼을 때 **토큰도 훨씬 적게 사용하면서 전체 맥락도 훨씬 잘 파악하고** 개발 생산성을 비약적으로 향상시키고 싶다. 이것을 **팀/회사에도 손쉽게 공유**하게 하고 싶다."

핵심 통찰: code agent의 가장 큰 반복 비용은 **세션마다 코드베이스와 이전 결정을 재탐색하는 것**이다.
CML이 이 탐색 결과를 증류해 캐시하고(개인), 그 캐시를 배포하면(팀) 토큰 절감과 맥락 품질이 동시에 달성된다.

## 2. 현재 아키텍처 요약 (2026-07-07 기준, v1.0.54)

~53K LOC TypeScript/ESM. thin-core strangler refactor 진행 중 (`core → adapters/apps/extensions`).

### 데이터 흐름

- **Capture**: Claude Code live hooks (SessionStart/UserPromptSubmit/PostToolUse/Stop/SessionEnd, `src/adapters/claude/hooks/`). Codex/Hermes는 명시적 import 전용 (`codex import`, `hermes import`).
- **Store**: SQLite canonical (~40 tables, `sqlite-event-store.ts` 3,069 lines) + LanceDB derived vectors (Vector Outbox V2로 트랜잭션 결합). 프로젝트별 `~/.claude-code/memory/projects/<hash>/`.
- **Process**: graduation worker(L0→L4), consolidation worker(endless mode), sync worker, mongo-sync worker(opt-in), semantic daemon(embedding 모델 warm 유지, unix socket).
- **Retrieve/Inject**: (1) SessionStart — 최근 이벤트 3건 주입, (2) UserPromptSubmit — adherence gate 통과 시 hybrid retrieval 후 최대 5건(300자 preview) 주입, (3) MCP `mem-context-pack` 등 27개 도구 pull 방식.

### 이미 존재하는 토큰 효율 장치 (본 spec이 재사용/승격하는 것)

- Progressive disclosure 3-layer (`progressive-retriever.ts`, search→expand→source) — 부분 출시됨
- Context compressor (off/safe/aggressive, content-type별 전략, sourceRef 보존)
- 주입 예산: MAX_MEMORIES 5, preview 300자, adherence gate로 저가치 turn 스킵
- Operations layer (facets/actions/frontier/checkpoints/lessons) — Brief의 재료

### 이미 존재하는 공유 장치 (본 spec이 확장하는 것)

- mongo-sync: L0 event 복제 (push/pull, rowid/seq 증분, idempotent) — 머신 단위, 팀 개념 없음
- shared-store: 같은 머신 내 cross-project troubleshooting 지식 승격 — multi-user 아님
- honcho actor 모델 (구현 완료): actor/perspective — 팀 공유 시 identity 기반
- MarkdownMirror: **storage dir 전용** 미러 (repo에 쓰는 기능은 현재 없음 — FR-C2가 신규 능력)

## 3. 실측/문서 근거 (문제 정의의 증거)

| 근거 | 출처 |
|------|------|
| 메모리는 유용함 (아키텍처 제약/버그픽스/UI 결정 회수 성공, 프로젝트 격리 정상) | `docs/MEMORY_USEFULNESS_AUDIT.md` (2026-05-05) |
| 미해결 next-step: read-path embedder 초기화 제거, **주입은 CLI search보다 엄격해야 함**, 실세션 replay 20~50개 필요 | 같은 문서 |
| trace/graduation/helpfulness cascade failure는 수정 완료 (utilization spec 7/7) | `specs/memory-utilization-improvements/` |
| 플랫폼 비대화 위험 — mesh broker/거대 MCP surface/다중 canonical 지양 권고 | `docs/ARCHITECTURE_COMPARISON_AND_RECOMMENDATIONS.md` |
| SQLite canonical, L0~L5 layer map, MCP disclosure checklist | `docs/architecture/memory-layer-manifest.md` |
| 토큰 효율 방향 = provenance 보존 native compression (Headroom은 참조만) | `docs/HERMES_CML_HEADROOM_OPERATING_MODEL.md` |
| Hermes provider는 read-only pre-turn prefetch (`mem-context-pack`) | 같은 문서 |
| 기존 KPI: usefulRecallRateMin 0.45, memoryHitRateMin 0.35 등 | `config/kpi-thresholds.json` |
| recsys_justin 실사용: 주입률 99.4%, high 판정 92.6%, 2,711 events 전부 L0, 동일 repo 4-store 분절, helpfulness proxy 천장 효과 | `field-findings-recsys-justin-2026-07-14.md` |

## 4. 설계 결정 기록

1. **주입은 "증류물 + citation"으로, 상세는 pull로**: push 주입(hook)은 예산이 강제되는 요약만, 상세는 에이전트가 MCP/CLI로 pull. progressive-disclosure의 Layer 1을 주입의 표준 형식으로 승격.
2. **Project Brief는 rule-based 우선**: 외부 LLM API 의존을 기본 경로에 두지 않는다 (오프라인/비용/재현성). LLM 증류는 extension으로 분리.
3. **팀 공유는 2-tier**: (a) git-committed curated markdown — 리뷰 가능·zero-install·보안 심사 용이, (b) mongo hub — full event 공유가 필요한 팀만 opt-in. 실시간 브로커는 non-goal.
4. **privacy gate 선행**: 공유 기능은 private-tags 최소 슬라이스 + secret 패턴 차단이 구현된 후에만 출시.
5. **Measure first**: Phase 0에서 baseline 계측 없이는 어떤 개선도 "비약적 향상"을 주장할 수 없다. exploration cost(첫 Edit 이전 Read/Grep/Glob 수)를 대표 지표로 채택.
6. **k8s-manifests의 `memory/` 디렉토리 관찰**: MarkdownMirror 산출물이 이미 repo에 수동 복사되어 쓰이고 있음 → git-committed memory에 대한 실수요 확인. 단, 현재 산출물은 raw 이벤트 미러(user_prompt/tool_observation 일자별)라 노이즈가 크므로, Tier 1 export는 **curated(Brief/결정/lessons)만** 내보낸다.
7. **Pipeline liveness before Brief**: Project Brief는 L1+/operations 재료가 실제 생성되고 최근 worker run이 관측될 때만 준비 상태로 본다. `build_runs=0` 또는 L1+=0을 빈 Brief 성공으로 숨기지 않는다.
8. **Legacy helpfulness는 gate가 아님**: `session_continued` 중심 helpfulness는 천장 효과가 있어 보조 지표로만 둔다. 자동 주입 승격은 direct human labels, shadow replay, exploration/token delta를 사용한다.
9. **Repo identity는 로컬 P0**: git worktree와 하위 경로를 같은 canonical repo identity로 묶되, 먼저 read-only alias/dry-run을 제공하고 ambiguous/nested repo는 fail-closed한다.
10. **Injection observability는 privacy-bounded**: source refs, policy version, score/cutoff, digest는 보존한다. redacted preview는 local/private 및 짧은 retention에서만 허용하고 public output에는 포함하지 않는다.
11. **CLI/API first confirmed by field use**: 별도 기동 dashboard는 보조 surface다. field readiness와 next action은 `health`/`stats`에서 먼저 제공한다.
12. **Upgrade와 실행 모델을 분리 진단**: 구버전 canary와 worker lifecycle 검증을 별도 실험으로 수행한다. 사용자 전역 설치를 계획 실행 중 임의 변경하지 않는다.
13. **명시적 curation은 자동 증류의 대체가 아닌 병행 1급 경로**: 실사용에서 검증된 유일한 recall 성공 사례(Finding D)는 수동 증류물이었고, CML에는 이를 담을 표면이 없었다 (코드 확인: `lesson add`/`mem-lesson-save` 부재, `LessonService.promoteCandidate`는 내부 전용). FR-A7/APA-21로 명시 저장 경로를 열고, Brief의 `no_derived_sources`는 L1+ 또는 curated source로 해소한다. 자동 graduation 소생(APA-17)의 우선순위는 유지된다.
14. **피드백 없는 제품은 신뢰를 잃는다**: 주입이 사용자에게 보이지 않아 "저장만 하는 도구"로 인식됐고, 14-버전 skew도 무신호로 방치됐다. FR-D4/APA-22로 stats 요약 노출과 bounded version-skew 안내를 제공하되, hook critical path 알림과 자동 업데이트는 금지한다.
15. **검색 성공은 답변 성공이 아니다**: 2026-07-14 recsys field test에서 direct hook은 candidate를 반환했지만 비표준 JSON envelope 때문에 실제 Claude는 context를 받지 못했다. 또한 prompt-only/tool-only 결과는 관련성이 높아도 answerable하지 않았다. FR-A3b/APA-23은 agent delivery contract, episode expansion, evidence utility, answerability, eval isolation을 하나의 P0 gate로 묶는다.

## 5. 관련 기존 스펙

| Spec | 관계 |
|------|------|
| `specs/progressive-disclosure/` | Pillar A의 pull 경로. Layer 1 포맷을 주입 표준으로 승격 |
| `specs/memory-utilization-improvements/` | 완료된 전술적 기반. trace 인프라를 FR-D1이 확장 |
| `specs/thin-core-refactor/` | 모든 신규 코드의 배치 규칙 (core/adapters/extensions/apps + import boundary) |
| `specs/honcho-inspired-peer-context-memory/` | actor identity를 Tier 2 team sync가 재사용 |
| `specs/private-tags/` | FR-C1이 이 spec의 최소 슬라이스를 선행 구현 |
| `specs/selective-tool-observation/` | 저장 노이즈 감소 — exploration cost 카운터(Task 0.1)와 접점 |
| `specs/endless-mode/` | consolidation worker를 Brief staleness 트리거가 재사용 |
| `specs/citations-system/` | `[mem:id]` citation 포맷 — FR-A3가 최소 형태로 채택 |
| `specs/mcp-desktop-integration/` | MCP core profile(FR-B3)과 도구 노출 정책 공유 |

## 6. 참고 문서

- `docs/architecture/memory-layer-manifest.md` — source-of-truth 계약 (위반 금지)
- `docs/TARGET_ARCHITECTURE_AND_FOLDER_STRUCTURE.md` — 폴더/boundary 규칙
- `docs/architecture/source-adapter-contract.md` — watcher ingest가 준수할 계약
- `docs/HERMES_CML_HEADROOM_OPERATING_MODEL.md` — 압축/prefetch 운영 모델
- `docs/OPERATIONS.md` — sync 건강성 ops 도구 (Tier 2 운영 시 재사용)
- 저장소 루트 `AGENTS.md`의 "Project Memory Bootstrap" 절 — bootstrap 생성기(APA-09)의 원형
