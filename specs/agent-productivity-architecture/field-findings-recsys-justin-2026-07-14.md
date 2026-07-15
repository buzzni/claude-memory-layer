# Field Findings: recsys_justin 실사용 환경 조사 (2026-07-14)

> **조사 일시**: 2026-07-14 KST
> **조사 환경**: local desktop (사용자 실사용 머신)
> **조사 대상 프로젝트**: local project (project_hash `76f983b1`) 외 6개
> **설치 버전**: 전역 설치 `claude-memory-layer@1.0.41` ← **최신 릴리스 1.0.55 대비 14개 버전 뒤처짐 (핵심 변수)**
> **조사 방법**: 실제 SQLite DB(`~/.claude-code/memory/projects/*/events.sqlite`) 직접 쿼리 + `~/.claude/settings.json` hook 설정 + `dist/` 소스 검사 + repo 내 MarkdownMirror 산출물 검토
> **목적**: 이 spec(Pillar A~D)의 문제 정의를 **실사용 데이터로 검증**한 결과를 기록. 다음 에이전트가 여기서 이어서 작업할 수 있게 함.

---

## 1. Executive Summary

사용자("최근 답변에서 메모리가 유용하게 쓰인 경우를 찾아달라")의 질문에서 출발해 실사용 머신의 CML 상태를 전수 조사했다. 결론:

1. **저장·주입 레이어는 살아있으나 무차별적이다** — 176개 프롬프트 중 175개(99%)에 메모리가 주입됨. "주입은 CLI search보다 엄격해야 한다"(context.md §3)는 방향이 실측으로 재확인됨. → **FR-A3 / APA-03 시급성 입증**
2. **증류·지식화 레이어는 완전히 죽어 있다** — 7개 프로젝트 전체에서 graduation(L0→L1+) 0건, consolidation 0건, entities/edges/lessons/insights 전부 0. 총 2,711 events가 **100% L0 raw 상태**. → **Project Brief(APA-05)가 만들어질 재료(L1+)가 아예 없음**
3. **helpfulness 지표는 낙관 편향** — 평균 0.887이지만 프록시(session_continued) 기반이라 신뢰 낮음. → **FR-D1 token accounting/실측 필요성 입증**
4. **dashboard는 존재하나 미사용** — 포트 37777 미가동. 사용자는 dashboard가 있는 것은 알지만 켜지 않음.
5. **정작 실제로 "유용한 recall"을 해낸 것은 CML이 아니라 Claude Code 내장 curated 메모리였다** — 증류된 소량의 규칙(운영 규칙 1건)이 raw 대화 3.6건 평균 주입보다 명확히 유용했음. → **"raw 주입 < curated 증류물 주입" 가설의 실사용 근거. Pillar A(Brief) 방향성 강력 지지**

가장 큰 미해결 질문: **§4의 파이프라인 사망이 (a) 구버전(1.0.41) 때문인지, (b) worker가 hook-only 환경에서 아예 스케줄되지 않는 구조 문제인지** 판별해야 한다 (→ §7 Next Actions #1).

---

## 2. 조사 환경 상세

### 2.1 Hook 등록 상태 (`~/.claude/settings.json`)

5개 hook 모두 정상 등록됨. 전역 설치 경로 사용:

```
node ~/.nvm/versions/node/v22.20.0/lib/node_modules/claude-memory-layer/dist/hooks/{session-start,user-prompt-submit,post-tool-use,stop,session-end}.js
```

- `claude-memory-layer install` 방식 정상 작동 확인.
- 단, **버전이 1.0.41에 고정**되어 있음. `npm install -g claude-memory-layer@latest` 미실행 상태. hook 경로가 전역 설치 dist를 가리키므로 업그레이드 전까지 최근 14개 릴리스의 수정사항(utilization spec 7/7 수정 포함 여부 확인 필요)이 **실사용에 반영되지 않고 있음**.

### 2.2 프로젝트별 데이터 현황 (`~/.claude-code/memory/projects/`)

| hash | 프로젝트 | events | sessions | retrieval_traces | memory_helpfulness |
|------|----------|-------:|---------:|-----------------:|-------------------:|
| `76f983b1` | recsys_justin (메인) | 1,992 | 62 | 176 | 424 |
| `2f0b3fb1` | recsys .aplus worktree (lucky-hawk) | 279 | 1 | 28 | 64 |
| `8e563be5` | recsys .aplus worktree (quiet-whale) | 155 | 2 | 14 | 29 |
| `5a647fa3` | recsys_justin/recommender (하위경로 별도 등록) | 116 | 2 | 18 | 41 |
| `ed67f391` | ~/.happy | 105 | 1 | 14 | 26 |
| `cdcfff28` | recsys .aplus worktree (brave-lynx) | 36 | 1 | 6 | 8 |
| `b22369c5` | k8s-manifests | 20 | 5 | 12 | 18 |
| **합계** | | **2,711** | **74** | **268** | **610** |

관찰:
- **worktree/하위디렉토리가 별개 프로젝트로 분리됨** (`.aplus/worktrees/*`, `recommender/`). 같은 저장소의 맥락이 4개 스토어로 파편화 → cross-project isolation이 여기서는 오히려 해가 됨. plan.md Task 4.3의 "projectKey 정규화(git remote URL 기반)"가 팀 공유 전에 **로컬에서도** 필요하다는 실증.

---

## 3. Finding A: 주입이 사실상 무차별 (Pillar A / FR-A3 근거)

`76f983b1` (recsys_justin, 2026-06-24 ~ 2026-07-14, 176 traces) 실측:

| 지표 | 값 |
|------|----|
| 주입 발생 (selected_count > 0) | **175 / 176 (99.4%)** |
| 주입 0건 | 1건뿐 |
| 평균 주입 개수 | 3.62개 (최대 5 = MAX_MEMORIES 상한) |
| confidence 분포 | high 163 / suggested 11 / medium 1 / none 1 |
| strategy 분포 | auto 88 / hybrid 88 |
| candidate 대비 selected | 대부분 candidate 전원 통과 (예: 5/5) |

해석:
- confidence gate가 **163/176을 high로 판정** → 현 임계값(minConfidence 0.5/0.7/0.85/0.92 tier)이 실사용 분포에서 변별력이 없음.
- 메타 질문("dashboard 잘 쓰이고 있어?")에도 5건 주입 + confidence=high. 명백한 노이즈 주입 사례.
- score-cliff cutoff(APA-03)와 주입 전용 min-score 분리가 **바로 이 데이터로 정당화됨**. baseline 숫자로 이 표를 그대로 쓸 수 있음.

**재현 쿼리** (다음 에이전트용):

```python
import sqlite3, os
db = os.path.expanduser("~/.claude-code/memory/projects/76f983b1/events.sqlite")
cur = sqlite3.connect(db).cursor()
cur.execute("""SELECT confidence, count(*), avg(selected_count)
               FROM retrieval_traces GROUP BY confidence""").fetchall()
```

---

## 4. Finding B: 증류·지식화 파이프라인 전면 미가동 (Pillar A 후반부 / APA-05 blocker)

**7개 프로젝트 전체 합계 — 상위 레이어 테이블이 전부 0:**

| 테이블 | 합계 | 의미 |
|--------|-----:|------|
| `memory_levels` (L0 초과) | **0** — 2,711건 전부 `L0` | graduation worker가 한 번도 승격 안 함 |
| `consolidated_memories` | 0 | consolidation 미실행 |
| `consolidated_rules` | 0 | 규칙 추출 없음 |
| `insights` | 0 | |
| `entities` / `edges` | 0 / 0 | 지식 그래프 빈 상태 |
| `memory_lessons` | 0 | |
| `working_set` / `memory_facets` | 0 / 0 | operations layer 미가동 |
| `build_runs` / `pipeline_metrics` | 0 / 0 | **파이프라인이 실행 기록조차 없음** |
| `endless_config` | 0 rows | endless mode 미설정 |
| `embedding_outbox` 잔여 | 1~2건씩 | outbox는 거의 소화됨 (벡터화 자체는 돌았음) |

해석:
- Retrieval이 hybrid(FTS+vector)로 작동하는 것으로 보아 **embedding/저장 경로는 정상**. 죽은 것은 그 위의 **graduation → consolidation → operations** 전체.
- `build_runs=0`은 "실패"가 아니라 **한 번도 시도되지 않음**을 뜻함. 가설 후보:
  1. **구버전(1.0.41)**: graduation/consolidation 트리거가 이후 버전에서 추가/수정됐을 가능성. `specs/memory-utilization-improvements/`의 "trace/graduation/helpfulness cascade failure 수정 완료"가 어느 버전에 배포됐는지 확인 필요.
  2. **hook-only 실행 모델**: plan.md는 "brief 증류는 full-mode에서만, hook은 읽기 전용"이라 명시. 이 머신은 hook + (아마도 미가동) daemon 조합이라 **worker가 돌 기회 자체가 없었을** 가능성. semantic daemon 프로세스 생존 여부 미확인 (조사 당시 dashboard 포트만 확인).
  3. endless mode opt-in인데 사용자가 모름 → `endless_config` 0.
- **Pillar A의 Project Brief(APA-05)는 graduated memory(L1+)를 재료로 삼는데, 실사용 머신에 L1+가 0건**이다. Brief 작업 착수 전에 graduation 파이프라인 소생(또는 L0에서 직접 증류하는 fallback 설계)이 선행돼야 함.

---

## 5. Finding C: helpfulness 지표의 낙관 편향 (Pillar D / FR-D1 근거)

`76f983b1` 424건 실측:

| 지표 | 값 |
|------|----|
| helpfulness_score | min 0.50 / **avg 0.887** / max 1.00 |
| 분포 | 0.8~1.0 구간에 372/424 (88%) 집중 |
| session_continued=1 | **419 / 424 (99%)** |
| was_reasked=1 | 309 / 424 (73%) — 그런데도 고득점 다수 |
| measured_at 채워짐 | 419 / 424 |

해석:
- 점수 산식이 행동 프록시(session_continued, was_reasked, tool_success) 조합인데, **세션이 이어지기만 하면 점수가 붙는 구조**라 분포가 천장에 붙음. `was_reasked=1`(재질문 발생 = 나쁜 신호)이 73%인데 평균이 0.887인 것은 지표가 변별하지 못한다는 뜻.
- 기존 KPI `usefulRecallRateMin 0.45`는 이 지표 기준으로는 **항상 통과**할 것 → gate로서 무의미해질 위험.
- FR-D1(token accounting, injection waste rate)과 replay A/B(APA-14)가 이 프록시를 대체해야 하는 이유의 실증.
- 부수 관찰: 최저점(0.50) 5건은 전부 "CML 자체에 대한 메타 질문" 세션이었음 — 과거 recsys 대화가 메타 질문에 도움이 안 되는 건 당연하므로, 이 케이스는 오히려 지표가 (우연히) 맞게 동작한 사례.

---

## 6. Finding D: 실제 "유용한 recall"의 승자는 curated 메모리였다 (Pillar A 방향성 근거)

같은 머신에서 CML과 **Claude Code 내장 curated 메모리**(`~/.claude/projects/<proj>/memory/`, 파일 2개, MEMORY.md 인덱스)가 병존한다. 사용자의 원 질문("메모리가 유용하게 쓰인 사례")에 대한 답은:

- **CML(raw 3.6건/turn 주입)**: 주입은 됐으나 "이 주입 덕에 답이 좋아졌다"고 특정할 수 있는 사례를 로그에서 찾기 어려움 (주입 내용이 transcript에 안 남아 검증 자체가 어려운 것도 문제 — observability gap).
- **curated 메모리(2건뿐)**: `benimaru-runtime-split-deploy.md` 1건이 명확한 성공 사례. 2026-07-10 prod 장애(api/gpu 모델 timestamp 가드 CrashLoop) 진단 → 운영 규칙으로 증류 저장 → 이후 세션들에 자동 주입 → 후속 배포에서 "gpu 먼저 rollout" 순서로 재발 방지. **생성→recall→행동 변화**의 전체 사이클이 추적됨.

시사점:
- **적은 수의 증류된 규칙 > 많은 raw 대화 조각**이라는 이 spec의 핵심 베팅(Project Brief, 요약+citation 주입)이 실사용에서 자연 실험으로 검증된 셈.
- 또한 recsys repo에는 MarkdownMirror 산출물(`memory/user_prompt/...` 일자별 raw)이 git에 커밋돼 있는데, 조사 과정에서 이 raw 미러는 "감사 로그"로만 기능했고 재사용 가치가 낮았음 — context.md §4.6("Tier 1 export는 curated만")의 추가 실증.

---

## 7. Next Actions (다음 에이전트가 이어서 할 일)

우선순위순. 기존 plan.md 태스크 ID에 매핑.

### 7.1 [P0] 파이프라인 사망 원인 판별 — 신규 (APA-05의 선행 blocker)

- [ ] 이 머신에서 `claude-memory-layer status` / semantic daemon 프로세스 생존 확인
- [ ] 1.0.41 → 1.0.55 사이 changelog에서 graduation/consolidation 트리거 변경 여부 확인 (`specs/memory-utilization-improvements/` 배포 버전 대조)
- [ ] **업그레이드 실험**: `npm install -g claude-memory-layer@latest` 후 1주 사용, `memory_levels` L1+ / `build_runs`가 0에서 움직이는지 재측정 (§4 표 재현 쿼리 사용)
- [ ] 여전히 0이면: worker 실행 모델 자체의 문제 → "hook-only 설치에서 graduation이 언제 도나"를 코드로 규명하고, 필요 시 **L0 직접 증류 fallback**을 APA-05 설계에 추가
- [ ] `endless_config` 0 rows — endless mode가 opt-in임을 사용자가 모름. 설치 시 안내 또는 기본값 재검토

### 7.2 [P0] Finding A 표를 APA-03의 baseline으로 채택

- [ ] `주입률 99.4% / 평균 3.62건 / high 92%`를 injection noise baseline으로 `phase-0-baseline.md`에 추가 (실사용 데이터라 golden replay보다 강한 근거)
- [ ] APA-03 완료 판정 기준을 "주입률 < X%, high 판정 < Y%"처럼 이 baseline 대비 상대치로 정의
- [ ] confidence tier가 왜 163/176을 high로 판정했는지 — scoring 함수의 실분포 점검 (임계값이 아니라 점수 산식 자체가 포화됐을 가능성)

### 7.3 [P1] Injection observability gap 해소 — FR-D1에 추가 제안

- [ ] 주입된 내용이 어디에도(transcript, mirror) 안 남아 사후 검증 불가였음. `retrieval_traces`에 주입 텍스트 preview 저장 or injection_metrics(APA-01)에 포함 — "주입이 유용했는지"를 나중에 사람이 판정할 수 있는 최소 기록
- [ ] helpfulness 프록시 지표(§5)의 천장 문제를 KPI 문서에 명시하고, `usefulRecallRateMin` gate의 산식 교체 계획 수립

### 7.4 [P1] 로컬 projectKey 파편화 (Task 4.3 앞당김 검토)

- [ ] 같은 repo가 worktree/하위경로로 4개 스토어에 파편화(§2.2). git remote/toplevel 기반 정규화를 팀 공유(Phase 4) 전에 로컬 기본 동작으로 앞당길지 결정
- [ ] 특히 `.aplus/worktrees/*`(에이전트 임시 worktree)의 메모리가 본 프로젝트와 단절되는 것은 멀티에이전트 시나리오(Pillar B)에서 치명적

### 7.5 [P2] Dashboard 실사용 부재 (APA-15 참고)

- [ ] 존재하지만 안 켜져 있음(37777 미가동). "따로 띄우는 대시보드"는 실사용 안 된다는 신호 — Productivity KPI 카드(Task 5.2) 설계 시 CLI-first(`stats --productivity`) 우선, dashboard는 보조라는 기존 결정 재확인

### 7.6 [P2] 사용자 인식 개선

- [ ] 사용자는 "CML이 저장만 하는 것"으로 인식하고 있었음 (주입이 보이지 않으므로). 주입 발생 시 최소한의 가시 신호(1줄 헤더 등) 또는 `stats` 요약에 "이번 주 주입 N회" 노출 검토 — 제품 신뢰의 문제

---

## 8. 원데이터 위치 및 재현 방법

- SQLite: `~/.claude-code/memory/projects/{76f983b1,2f0b3fb1,5a647fa3,8e563be5,b22369c5,cdcfff28,ed67f391}/events.sqlite`
- Hook 설정: `~/.claude/settings.json`
- 설치본: `~/.nvm/versions/node/v22.20.0/lib/node_modules/claude-memory-layer/` (v1.0.41)
- curated 메모리 성공 사례: `~/.claude/projects/-home-buzzni-projects-recsys-justin/memory/benimaru-runtime-split-deploy.md`
- raw 미러 (git 커밋됨): local project의 `memory/{user_prompt,agent_response,session_summary,tool_observation}/`
- 집계 스크립트: 이 문서 §3의 python 스니펫 패턴으로 모든 표 재현 가능 (sqlite3 CLI는 이 머신에 없음 — python3 stdlib 사용)

주의: 위 수치는 2026-07-14 09:44 KST 시점 스냅샷. 이 조사 자체가 새 events/traces를 만들었으므로 재측정 시 소폭 증가해 있을 것.
