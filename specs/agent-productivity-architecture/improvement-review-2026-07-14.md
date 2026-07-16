# Improvement Review: Field Findings 대응 계획 적정성 분석 (2026-07-14)

> **분석 대상**: [`plan.md`](./plan.md), [`spec.md`](./spec.md), [`progress-and-roadmap.md`](./progress-and-roadmap.md), [`phase-0-baseline.md`](./phase-0-baseline.md), [`project-health-report-schema.md`](./project-health-report-schema.md)
> **검증 기준**: [`field-findings-recsys-justin-2026-07-14.md`](./field-findings-recsys-justin-2026-07-14.md)의 실사용 문제들을 계획이 실제로 해결하는가 + 전체 아키텍처의 실효용 가치 관점 공백
> **이 문서의 산출물**: 신규 태스크 APA-21/APA-22, 기존 태스크 보강(APA-03/19), spec FR-A7/FR-D4 — 반영 내역은 §5

---

## 1. 결론 요약

**커버리지 판정: field findings의 실행 항목 6개(§7.1~7.6) 중 5개는 Wave 0~1 계획이 직접적이고 정확하게 대응한다.** 특히 APA-17(파이프라인 진단을 버전/실행모델로 분리), APA-18(proxy 지표 강등 + 직접 계측), APA-19(read-only alias 우선)는 field 데이터의 해석까지 올바르게 반영한 설계다.

그러나 **"실제 효용 가치를 높인다"는 관점에서 구조적 공백 3개**가 확인됐다:

| ID | 공백 | 심각도 | 근거 |
|----|------|--------|------|
| G1 | **명시적 curation 캡처 표면이 제품에 없다** | 높음 | Finding D에서 실사용 중 유일하게 검증된 recall 성공 경로는 "수동 증류물"인데, 코드 확인 결과 CML에는 사용자/에이전트가 증류물을 명시 저장할 CLI/MCP 표면이 전무하다 (§3) |
| G2 | **사용자 가시 피드백 루프 부재** | 중간 | field §7.6이 계획에 부분 반영에 그침. 주입은 사용자에게 보이지 않고, 1.0.41이 14개 버전 방치된 것도 알려줄 메커니즘이 없다 |
| G3 | **time-to-value 공백** | 중간 | Wave 0 전체(APA-16~20)가 진단/측정이라, 사용자가 체감할 개선(노이즈 감소·가치 저장)까지 수 주의 공백이 생긴다 |

G1이 가장 크다. 현재 계획은 "자동 graduation 파이프라인 소생 → L1+ 생성 → Brief 증류"라는 단일 경로에 베팅하고 있는데, field 데이터는 이 파이프라인이 한 번도 돈 적이 없음을 보여줬고, 반면 검증된 가치(benimaru 사례)는 자동 파이프라인 없이 명시적 증류만으로 만들어졌다. **명시적 curation은 파이프라인 소생과 병행 가능한 최단 가치 경로이자, Brief의 `no_derived_sources` blocker를 해소하는 두 번째 정식 재료 공급원이다.**

## 2. 커버리지 매핑 (field findings → 계획)

| Field 항목 | 대응 계획 | 판정 |
|-----------|----------|------|
| §7.1 [P0] 파이프라인 사망 원인 판별 | APA-17 (무변경 진단 → canary → 구조 수정), APA-20 (health 노출) | ✅ 충실. 버전/실행모델 분리 진단, 사용자 전역 설치 비변경 원칙까지 반영 |
| §7.2 [P0] Finding A 표 → APA-03 baseline | APA-16 (baseline 승격 + fixture), phase-0-baseline.md §field baseline 반영 완료, APA-03 승격 gate가 상대치(−30%p)로 정의됨 | ✅ 충실. score 포화 원인 분석(임계값이 아닌 산식)도 APA-03 1단계에 포함 |
| §7.3 [P1] Injection observability gap | APA-18 (source refs/digest/bounded preview, direct label audit), proxy 강등 원칙(plan §2, context 결정 8) | ✅ 충실 |
| §7.4 [P1] 로컬 projectKey 파편화 | APA-19 (canonical identity, read-only alias 우선, fail-closed) | ✅ 방향 정확. 단 **ephemeral worktree의 쓰기 경로**가 미해결 (G4, §4.3) |
| §7.5 [P2] Dashboard 실사용 부재 | plan §1-4 (CLI/API 1차 운영면), Wave 6 (dashboard는 thin visualization) | ✅ 충실 |
| §7.6 [P2] 사용자 인식 개선 | APA-18의 `stats --productivity` aggregate 노출만 | ⚠️ **부분 커버**. "주입 발생의 가시 신호", "버전 방치 알림" 등 능동적 피드백이 없음 (G2, §4.2) |

## 3. 코드 확인 사실 (이번 분석에서 검증)

계획 문서의 가정을 코드로 검증한 결과 (worktree `noble-koala`, v1.0.55 기준):

1. **수동 curation 표면 없음**: `src/apps/cli/index.ts`(2,722줄)에 `lesson add`/`remember`류 커맨드 없음. `src/extensions/mcp/tools.ts`의 27개 도구 중 lesson 관련은 `mem-lesson-list`(읽기 전용)뿐, 저장 도구 없음.
2. **내부 메커니즘은 이미 존재**: `LessonService.promoteCandidate()`(`src/core/operations/lesson-service.ts:178-194`) → `LessonRepository.upsert()`(`src/core/operations/lesson-repository.ts:115-181`) → `memory_lessons` 쓰기 경로가 구현돼 있으나 외부 노출이 없다. → **APA-21의 구현 비용이 낮다는 근거.**
3. **`status`에 version skew 감지 없음**: `src/apps/cli/index.ts:773-815`의 `status`는 hook 등록/plugin 파일/dashboard 가동만 확인. installed vs hook 버전 비교 없음. → APA-17/20의 계획이 실제 공백을 메우는 것 맞음. 단 "사용자가 status를 실행해야만 보인다"는 한계는 남는다 (G2).
4. **주입 마커는 컨텍스트 전용**: `user-prompt-submit.ts:84`의 `💡 **Related memories found:**` 헤더는 모델 컨텍스트에만 들어가고 사용자 UI에는 보이지 않는다. → field §7.6 "사용자는 저장만 하는 것으로 인식"의 직접 원인.

## 4. 개선 제안

### 4.1 [G1→APA-21] Explicit curation capture — 최단 가치 경로 (P0 병행)

**문제**: Finding D의 자연 실험 결과 "적은 수의 증류된 규칙 > 많은 raw 조각"이 이 spec의 핵심 베팅인데, 정작 CML에서 증류물을 만드는 유일한 경로(자동 graduation)는 실사용에서 0건 가동이고, 검증된 성공 사례(benimaru)는 CML 밖(Claude Code 내장 curated memory)에서 만들어졌다. 사용자가 "이건 기억해"라고 해도 CML에 넣을 방법이 없다.

**제안**: 자동 파이프라인과 독립적인 명시 저장 표면을 추가한다.

- CLI: `claude-memory-layer lesson add` (기존 `LessonService`/`LessonRepository` 재사용 — 신규 스키마 불필요)
- MCP: `mem-lesson-save` — 에이전트가 세션 중 검증된 교훈/결정을 저장 (core profile 포함 검토)
- 저장물은 `curated` source class로 태깅되어 **APA-05 Brief의 승인된 재료**가 된다 → `no_derived_sources` blocker를 파이프라인 소생 없이도 해소하는 정식 경로 (L0 raw fallback보다 품질·안전성 우위)
- FR-C1과 동일한 secret/credential 패턴 차단을 저장 시점에 적용

**기대 효과**: (a) 파이프라인 수리 완료 전에 사용자 체감 가치 발생, (b) Brief 재료의 이중화(자동 graduation + 명시 curation), (c) benimaru형 "생성→recall→행동 변화" 사이클을 CML 안에서 재현·측정 가능.

### 4.2 [G2→APA-22] 사용자 가시 피드백 + version skew 능동 알림 (P1)

**문제**: 주입이 보이지 않아 사용자는 "CML은 저장만 한다"고 인식했고(신뢰 문제), 설치본이 14개 버전 뒤처져도 아무 신호가 없었다(운영 문제). APA-20은 health report에 skew를 넣지만, dashboard도 안 켜는 사용자가 health를 정기 실행할 것으로 기대할 수 없다.

**제안**:

- `stats` 기본 출력에 "최근 7일: 주입 N회 / 토큰 M / abstention율" 1블록 노출
- 사용자가 어떤 CLI 커맨드든 실행할 때, version skew가 임계(예: 5개 minor 이상 또는 90일 이상) 초과면 1줄 upgrade 안내 표시 — bounded frequency(주 1회), opt-out 가능, **자동 업데이트는 하지 않음**
- hook critical path에서는 아무것도 하지 않는다 (latency 원칙 유지)

### 4.3 [G4→APA-19 보강] Ephemeral worktree의 쓰기 경로

read-only alias는 **읽기**만 통합한다. `.aplus/worktrees/*` 같은 에이전트 임시 worktree에서 생성된 메모리는 worktree 스토어에 쓰였다가 worktree 삭제와 함께 고아가 된다 (field §2.2에서 이미 3개 고아 후보 확인). 멀티에이전트 시나리오(Pillar B)에서 에이전트 작업 기억이 본 프로젝트로 수렴하지 못하는 구조적 손실. → APA-19 apply 단계 설계에 "canonical identity가 unambiguous한 worktree의 신규 쓰기를 canonical store로 라우팅하는 옵션"과 "고아 store 카운트의 health 노출"을 포함한다.

### 4.4 [G3/G5→APA-03 보강] 좁은 범위의 조기 노이즈 가드 (선택)

full calibration(observe 비교 → replay → preview)을 기다리는 동안에도, **이미 결정적 증거가 있는 최악 케이스**(메타 질문에 5건 주입 + confidence=high)는 좁은 abstention guard로 조기 완화할 수 있다. 기존 golden replay의 no-match accuracy 1.0 gate와 meta/topic-shift fixture로 회귀 검증이 가능하므로, guard 한정으로 observe 1주 → preview 승격을 APA-03 본체와 분리해 진행하는 옵션을 열어둔다. observe→preview→enforce 원칙은 유지하되 승격 단위를 정책 전체가 아니라 guard 단위로 쪼개는 것.

### 4.5 [G6] Wave 4 진입 게이트 — 수요 증거

field 조사 머신에서 Codex/Hermes 사용 흔적은 확인되지 않았다. Wave 4(One Memory, N Agents)는 P1을 유지하되, 착수 전 "대상 환경에서 최근 30일 내 Codex/Hermes 세션 존재"를 진입 게이트로 추가해 과투자를 방지한다. (worktree 간 Claude Code 멀티에이전트 수렴은 APA-19가 먼저 해결한다.)

### 4.6 [G8] Value-story 지표

기존 KPI는 전부 기계적 지표(토큰/호출 수/waste)다. Finding D가 보여준 진짜 가치 증명은 **"생성→recall→행동 변화" 사이클의 추적 가능성**이다. curated artifact(APA-21 저장물)에 대해 recall 횟수와 direct label을 연결한 "curated memory 활용률"을 KPI에 추가한다. 목표치는 임의 설정하지 않고 APA-21 출시 후 baseline을 먼저 측정해 정한다.

## 5. 문서 반영 내역

| 문서 | 변경 |
|------|------|
| `spec.md` | FR-A7(explicit curation capture), FR-D4(user-visible feedback & skew surfacing) 추가, KPI 표에 curated 활용률 행 추가 |
| `plan.md` | §1 판단에 6번째 항목, Wave 0에 APA-21/APA-22 추가, APA-19에 worktree write-routing 항목, APA-03에 조기 guard 옵션, Wave 4 진입 게이트, KPI 표 갱신, PR 순서에 반영 |
| `context.md` | 설계 결정 13(명시적 curation은 자동 증류의 대체가 아닌 병행 1급 경로), 14(피드백 없는 제품은 신뢰를 잃는다) 추가 |
| `progress-and-roadmap.md` | status matrix에 FR-A7/FR-D4 행, next actions 갱신 |
| `phase-0-baseline.md` | 변경 없음 (field baseline은 이미 반영됨; curation e2e fixture는 APA-21 완료 조건으로 관리) |

## 6. 이번에 채택하지 않은 대안 (기록)

- **endless mode 기본 활성화**: APA-17이 latency/자원 측정 전 기본화를 금지한 기존 판단 유지. 진단이 먼저다.
- **helpfulness 산식 즉시 교체**: 직접 계측(APA-18) 없이 산식만 바꾸면 또 다른 proxy를 만든다. 기존 계획 순서가 옳다.
- **worktree store 자동 병합**: fail-safe 원칙(자동 병합/삭제 금지)과 충돌. alias + 신규 쓰기 라우팅으로 한정.
- **주입 시 사용자 UI 실시간 표시**: Claude Code hook 출력 구조상 사용자 UI 제어 불가. stats/status 경유 노출(APA-22)로 대체.
