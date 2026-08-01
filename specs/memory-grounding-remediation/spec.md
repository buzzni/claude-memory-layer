# Spec: Memory Grounding Remediation

> 마지막 갱신: 2026-08-01
> 상태: 초안 (미착수)
> 선행 spec: `specs/memory-utilization-improvements/` (2026-03-04) — **본 문서가 그 실패 원인을 규명하고 대체한다**

## 0. 왜 세 번째로 다시 쓰는가

같은 문제를 이미 두 번 고쳤는데 지표가 움직이지 않았다. 근본 원인은 코드가 아니라 **목표 지표 선택**이었다.

`specs/memory-utilization-improvements/spec.md`(2026-03-04)의 성공 기준:

| 선행 spec의 목표 | 성격 | 결과 |
|---|---|---|
| Retrieval trace 기록률 > 95% | 프록시 | ✅ 달성 |
| 세션 요약 생성률 > 80% | 프록시 | ✅ 달성 (518건) |
| Tool observation 저장 비율 < 30% | 프록시 | ❌ 미달 (여전히 82%) |
| 메모리 Graduation L1+ > 10% | 프록시 | ⚠️ 5.2% |

전부 **"만들어졌는가"를 재는 프록시 지표**다. "**쓸모가 있었는가**"를 재는 지표가 목표에 없었다.
그 결과 IMP-03(세션 요약)은 spec대로 정확히 구현됐지만 — spec이 정의한 템플릿
(`"[날짜] [N]턴 세션. 주요 작업: ... 사용 툴: ..."`)이 **목차이지 지식이 아니었기 때문에**,
생성률 100%를 달성하고도 실사용률은 0.9%다. **스펙을 충족하면서 동시에 무용한 결과**가 나왔다.

지금은 `memory_helpfulness.content_overlap_score`라는 **결과 지표**가 존재한다(주입된 메모리가
실제 응답에 반영됐는지 측정). 본 spec은 이 지표 하나만을 목표로 삼는다.

## 1. 현재 측정값 (aplus-dev-studio-desktop, projectHash `6ab6d837`, 2026-08-01)

주입된 메모리 중 실제로 답변에 사용된 비율 (`content_overlap_score >= 0.3`):

| 이벤트 타입 | 저장량 | 주입 평가 | 실사용 | **실사용률** |
|---|---|---|---|---|
| tool_observation | 13,609 (82%) | 452 | 1 | **0.2%** |
| session_summary | 518 | 225 | 2 | **0.9%** |
| user_prompt | 838 | 102 | 5 | 4.9% |
| agent_response | 1,581 | 1,642 | 196 | 11.9% |
| **전체** | 16,546 | 2,421 | 204 | **8.4%** |

주입 슬롯의 91.6%가 토큰만 쓰고 버려진다.

### 검증된/기각된 가설

- ✅ **tool_observation은 IMP-02 필터 적용 후에도 82%다.** Read/Grep/Glob은 이미 제외됨에도
  Bash 7,132 + Edit 5,007 = 전체 관측의 89%가 남는다. IMP-02는 "Edit/Write는 항상 저장(코드 변경 추적 필요)"으로
  설계했으나, **코드 변경은 git이 이미 추적하며 모델은 그걸 git에게 묻지 메모리에게 묻지 않는다.**
  저장 가치 모델 자체가 틀렸다.
- ✅ **fallback 누수 확인.** tool_observation을 포함한 trace 319건 중 **131건은 답변 근거가 하나도 없는
  상태에서 tool만 주입**됐다(`applyAnswerabilityGate` 최종 fallback 경로).
- ❌ **"같은 세션 메모리는 이미 컨텍스트에 있으니 중복"** — 기각. 동일 세션 9.4% vs 타 세션 7.9%로
  오히려 동일 세션이 근소 우위. 컴팩션 이후에는 컨텍스트에 없기 때문으로 추정. **이 가설 기반 최적화는 하지 않는다.**

## 2. 성공 기준 (본 spec)

측정은 전부 아래 단일 쿼리로 한다. 변경 전 baseline을 기록하고, 변경 후 동일 쿼리로 비교한다.

```sql
SELECT e.event_type, COUNT(*) evaluated,
  SUM(CASE WHEN h.content_overlap_score >= 0.3 THEN 1 ELSE 0 END) grounded,
  ROUND(100.0*SUM(CASE WHEN h.content_overlap_score >= 0.3 THEN 1 ELSE 0 END)/COUNT(*),1) pct
FROM memory_helpfulness h JOIN events e ON e.id = h.event_id
WHERE h.content_overlap_score IS NOT NULL
  AND h.created_at >= :since        -- 변경 배포 시점
GROUP BY e.event_type;
```

| 지표 | 현재 | 목표 |
|---|---|---|
| 전체 실사용률 | 8.4% | **> 25%** |
| tool_observation 주입 건수 | 452 | **< 20** |
| session_summary 실사용률 | 0.9% | **> 10%** |
| 주입당 평균 토큰 (낭비 대리지표) | — | 감소 |

**프록시 지표는 성공 기준에 넣지 않는다.** 생성률·저장률·trace 기록률은 관측만 하고 목표로 삼지 않는다.

---

## F1. tool_observation을 주입 경로에서 차단

**우선순위: P0** — 효과가 가장 크고 범위가 가장 명확하다.

### 문제

두 개의 누수 경로가 있다.

1. **랭킹 슬롯 점유**: `evidenceUtilityBonus('tool_observation') = +0.03` (prompt-injection-policy.ts:208).
   tool 관측이 상위 5슬롯을 차지한 뒤 게이트를 통과한다.
2. **게이트 최종 fallback**: `applyAnswerabilityGate` (같은 파일 196–197행) —
   답변 근거가 하나도 없으면 **질의 의도와 무관하게 tool 관측 전체를 반환**한다. 확인된 누수 131 trace.

```typescript
// 현재 (196-197행)
const toolEvidence = candidates.filter((c) => c.type === 'tool_observation');
if (toolEvidence.length > 0) return toolEvidence;   // ← 무조건 누수
```

추가로 `hasToolEvidenceIntent`(201행)의 정규식이 `command|log|명령|로그`처럼 흔한 단어를 잡아
너무 느슨하다 (tool+answer 188 trace).

### 설계

1. **`evidenceUtilityBonus`를 질의 조건부로 변경.** tool_observation에만 적용:
   질의에 tool 의도가 있으면 현행 `+0.03` 유지, 없으면 **`-0.15`**.
   ⚠️ **일괄 페널티는 안 된다** — 아래 "검토된 대안"에 산술 근거.
2. `applyAnswerabilityGate` 최종 fallback 제거. 답변 근거가 없으면
   `isContinuationQuery` 경로만 남기고 **빈 배열 반환**(= 주입 안 함). 근거 없는 주입보다 무주입이 낫다.
3. `hasToolEvidenceIntent` 강화: 흔한 단어(`command`, `log`, `명령`, `로그`) 제거하고,
   **질의의 identifier anchor가 해당 관측 내용에 실제로 등장할 때만** tool 근거를 허용.
   1번과 3번이 같은 판정을 공유하므로 헬퍼로 추출한다.

### 검토된 대안 — 기각: tool_observation 일괄 페널티

착수 전 산술 검증에서 **기존 테스트를 깨뜨리는 것이 확인됐다**
(`tests/adapters/claude-hook-prompt-injection-policy.test.ts:292`,
"kubectl 출력을 알려줘" → `[answer, tool]` 기대).

| 후보 | 현행 유효점수 | 일괄 `-0.15` 적용 시 |
|---|---|---|
| answer (0.86, +0.10) | 0.96 | 0.96 |
| tool (0.89) | 0.92 | **0.74** |
| tail (0.68) | 0.71 | 0.53 |

현행은 `0.96→0.92` 격차 0.04 < `scoreCliffGap`(0.08)이라 tool이 살아남아 게이트에서 의도 판정을 받는다.
일괄 페널티 시 격차가 0.22가 되어 **`applyScoreCliff`가 게이트 이전에 tool을 잘라낸다.**
정당한 tool 질의가 회귀한다. → 질의 조건부 방식으로 확정.

### 변경 파일

- `src/adapters/claude/hooks/prompt-injection-policy.ts` — `evidenceUtilityBonus`(질의 인자 추가),
  `rankHookCandidates`(인자 전달), `applyAnswerabilityGate`, `hasToolEvidenceIntent`
- `tests/adapters/claude-hook-prompt-injection-policy.test.ts` — fallback 제거에 대한 케이스 추가

### 리스크

- `evidenceUtilityBonus`에 query 인자를 추가하면 `rankHookCandidates`의 시그니처가 전파된다(순수 함수라 범위는 좁음).
- fallback 제거로 "근거 없음 → 무주입"이 되면 체감상 메모리가 조용해진다.
  **이는 의도된 동작**이며, §2 실사용률로 정당성을 확인한다.
- "그 명령어 뭐였지?" 류 질의 회귀 → 3번(anchor 검증)으로 방어하고 위 테스트로 고정.

### 검증

배포 후 §2 쿼리에서 `tool_observation`의 `evaluated`가 20 미만으로 떨어지는지. 동시에
`agent_response`의 `evaluated`가 늘어야 한다(슬롯이 답변 근거로 이전됐다는 증거).

---

## F2. session_summary — 목차 대신 결과를 저장

**우선순위: P1**

### 문제

요약 생성기 2개가 모두 **메타데이터 목차**를 만든다. 결과(무엇이 결정됐고 무엇이 실패했는지)가 없다.

```typescript
// src/core/derive/summary-deriver.ts (Stop hook 경로)
// → "[2026-07-28] 1턴 세션. 주요 작업: <첫 프롬프트 120자>. 사용 툴: Bash, Edit"

// src/adapters/claude/transcript/turn-reconstructor.ts (session-end 경로)
// → "Session with 13 user prompts and 29 responses. Topics discussed: - <프롬프트 100자>"
```

부수 문제: `firstPromptPreview(prompts[0])`는 **세션 첫 프롬프트**만 쓴다. 긴 세션일수록
첫 프롬프트만 남아 요약끼리 near-duplicate가 된다 (518건 중 고유 prefix 435건, 16% 중복).

이 무용한 형식을 탐지하는 `isPromptOnlySessionSummary`(prompt-injection-policy.ts:280)는 **이미 존재하며
두 형식을 모두 정확히 매칭한다.** 그런데 `scoreGraduatedEvidence` 한 곳에서만 호출되고,
semantic/keyword 레인과 `evidenceUtilityBonus(+0.12, 전 타입 중 최고)`에는 연결돼 있지 않다.

### 설계 — 2단계

**F2-a (즉시, 저위험): 차단만.**
`isPromptOnlySessionSummary`를 `rankHookCandidates`와 `evidenceUtilityBonus`에도 연결.
목차형 요약은 유틸리티 보너스 0 + 랭킹에서 제외. 기존 518건의 오염된 요약이 즉시 주입에서 빠진다.

**F2-b (근본): LLM 요약으로 생성기 교체.** — ✅ **결정됨 (2026-08-01): claude/codex CLI 호출**

요약이 담아야 할 것은 목차가 아니라 **결과**다: 무엇을 결정했는가 / 무엇이 실패했고 왜인가 /
어떤 제약이 확인됐는가. 규칙 기반으로는 "왜"를 뽑을 수 없으므로 LLM을 호출한다.

#### 🔴 최대 위험: 훅 재귀 — 실측으로 해결됨

Stop hook에서 `claude`를 그냥 spawn하면 **자식 세션이 전역 훅을 다시 실행**한다
(`~/.claude/settings.json`의 SessionStart/Stop/…). 자식의 Stop hook이 또 요약을 만들려고
`claude`를 spawn → **무한 재귀**. 기존 선례인 `src/apps/server/api/chat.ts:286`은
`env: { ...process.env }`로 전체 환경을 상속하며 **훅 차단 장치가 없다** — 그대로 복사하면 안 된다.

**실측 결과 (2026-08-01, 대조군 포함):**

| 호출 | 신규 project 저장소 | 판정 |
|---|---|---|
| `claude -p` (플래그 없음) | 67 → **68** | 훅 실행됨 |
| `claude -p --setting-sources project` | 67 → **67** | **훅 미실행** |

→ **`--setting-sources project`를 필수로 사용한다.** 메모리 훅은 user 레벨 설정에 있으므로
`user`를 로드 대상에서 빼면 실행되지 않는다.

`--bare`도 훅을 차단하지만 **채택하지 않는다**: "OAuth and keychain are never read"라
`ANTHROPIC_API_KEY`가 필요한데 현재 환경에 **미설정**이다. `--setting-sources`는 OAuth 인증이
유지됨을 실측 확인했다(exit 0, 정상 응답).

#### 설계

- **호출 형태**: `claude -p --setting-sources project --model <소형모델>`, 프롬프트는 stdin.
  실패 분류(auth/not-found/timeout)는 `chat.ts:220-236`의 `classifyProviderFailure` 패턴을 재사용.
- **입력**: 세션의 user_prompt + agent_response (tool_observation 제외 — 노이즈이고 토큰만 먹는다).
  프롬프트는 "결정/실패 원인/확인된 제약"만 뽑도록 지시하고, 없으면 빈 출력을 허용한다.
- **동기/비동기**: Stop hook을 LLM 지연으로 블로킹하면 안 된다.
  기존 `embedding_outbox` 아웃박스 패턴을 따라 **요약 작업을 큐에 넣고 백그라운드에서 처리**한다
  (요약은 다음 세션을 위한 것이므로 지연 허용).
- **폴백**: LLM 호출 실패 시 현행 규칙 기반 요약으로 되돌리지 **않는다**(그게 오염원이다).
  요약 없이 두고 재시도 큐에 남긴다.
- **codex 대안**: `codex`도 설치돼 있다. 동일 인터페이스로 교체 가능하도록 provider를 추상화하되,
  기본은 claude로 한다.

#### 미해결 (구현 시 결정)

- 모델 선택 및 세션당 비용 상한
- 아웃박스 재시도 정책 (임베딩 아웃박스 정책 재사용 여부)
- 기존 오염된 요약 518건의 소급 재생성 여부 (F2-a로 주입은 이미 차단되므로 급하지 않음)

### 변경 파일

- F2-a: `src/adapters/claude/hooks/prompt-injection-policy.ts`
- F2-b: `src/core/derive/summary-deriver.ts`, `src/adapters/claude/transcript/turn-reconstructor.ts`
  (두 생성기를 하나로 통합하는 것도 함께 검토 — 현재 이원화 자체가 결함)

### 검증

F2-a 후 `session_summary`의 `evaluated`가 급감해야 한다(= 오염된 요약이 주입에서 빠짐).
F2-b 후에는 `evaluated`가 회복하면서 `pct > 10%`.

---

## F3. 지식 추출 레인 신설

**우선순위: P2** — 가장 근본적이지만 데이터 근거가 가장 약하고 설계 자유도가 크다.

### 문제

현재 저장되는 모든 것은 **원시 전사(transcript)**다: 프롬프트, 응답, 툴 JSON, 그리고 메타데이터 요약.
"무엇이 결정됐다 / 무엇이 제약이다 / 이 접근은 실패했다"를 담는 레인이 **하나도 없다.**
`memory_lessons` 테이블이 정확히 그 용도로 존재하지만 **0건**이다.

그 결과 유일하게 작동하는 게 `agent_response`(11.9%) — **Claude가 쓴 산문을 Claude에게 되먹이는 것**이다.
주입의 66%가 여기서 나온다. 같은 문체·같은 주제라 검색 점수는 높지만 지식 추출이 아니라 메아리이고,
세대를 거치며 "요약의 요약"으로 열화된다.

> 근거의 한계를 명시한다: 이 열화가 실측된 것은 아니다. 관측된 사실은 (a) 주입의 66%가 자기 산문이고
> (b) 그마저 11.9%만 실사용된다는 것. "열화"는 메커니즘 추론이다.

### 설계 방향 (택일 아님, 조합 가능)

1. **자동 후보 탐지 → 수동 승격.** 이미 `LessonCandidateService`가 존재하고,
   금일 `mem-lesson-candidates` MCP 도구로 노출했다. 다만 현재 판정 기준이 엄격해
   이 프로젝트에서 32세션 스캔 후보 0건 — **판정 기준과 스캔 범위(기본 가장 오래된 2,000건) 재조정 필요.**
2. **Stop hook에서 결과 문장 추출.** agent_response에서 결정/원인/제약 문장만 뽑아
   별도 이벤트 타입으로 저장. 규칙 기반의 한계는 F2-b와 동일한 트레이드오프.
3. **provenance 기반 감쇠.** 주입된 메모리를 인용해 생성된 응답을 "파생"으로 표시
   (`retrieval_traces`에 이미 연결 데이터 있음). 원본이 메아리보다 상위에 오도록.

### 검증

`memory_lessons` 건수 > 0, 그리고 lesson이 주입됐을 때의 실사용률을 별도 타입으로 §2 쿼리에서 추적.

---

## 3. 실행 순서

```
F1 (P0)  ──> 측정 ──> F2-a (P1, 저위험) ──> 측정 ──> [결정] F2-b / F3
```

각 단계마다 §2 쿼리로 전후 비교. **한 번에 하나씩 배포하고 측정한다** — 동시 배포하면
어느 변경이 효과를 냈는지 귀속할 수 없고, 그게 지금까지 반복된 실패 패턴이다.

F1과 F2-a는 모두 `prompt-injection-policy.ts` 한 파일이고 순수 함수라 테스트가 쉽다. 롤백은 환경변수가
아니라 revert로 한다(현재 정책 임계값들은 env로 조정 가능하나, 보너스 상수는 하드코딩이므로).

## 4. 범위 밖

- 저장 단계에서 tool_observation을 줄이는 것(IMP-02 재시도): F1이 주입을 막으면 저장 비용은
  디스크·임베딩 문제로 축소된다. 별건으로 다룬다.
- 이미 저장된 13,609건의 소급 정리: 주입이 막히면 무해하다. retention 정책과 함께 별도 검토.
- 다른 프로젝트로의 일반화: 본 spec은 `6ab6d837` 단일 프로젝트 데이터에 근거한다.
  배포 전 최소 1개 프로젝트에서 baseline을 더 확인하는 것이 안전하다.

## 5. 결정 필요 사항

**D1. F2-b 요약 생성 방식** — ✅ **결정됨 (2026-08-01): (b) LLM 요약, claude/codex CLI 호출.**
훅 재귀 위험은 `--setting-sources project`로 차단하며 실측 검증 완료 (F2-b 참조).

**D2. F3 착수 여부** — 미결. F1+F2로 실사용률이 목표(25%)에 도달하면 F3는 불필요할 수 있다.
F1·F2 측정 후 재판단하는 것을 권한다.
