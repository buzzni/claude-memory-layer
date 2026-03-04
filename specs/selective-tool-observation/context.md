# Context: Selective Storage (전체 이벤트 타입 분석)

## 실측 데이터 (f4d5c120 / shopping_assistant)
> SQLite events.sqlite 직접 쿼리 기준 (10,536개)

### 이벤트 구성

| eventType         | count  | 비율   | avg_len |
|-------------------|--------|--------|---------|
| tool_observation  | 7,212  | 68.5%  | 4,166   |
| agent_response    | 2,222  | 21.1%  | 417     |
| user_prompt       |   948  |  9.0%  | 620     |
| session_summary   |   154  |  1.5%  | 172     |

---

## 1. tool_observation 분석

### 도구별 분포 (전체)

| Tool         | count | avg_len | 저장 가치 |
|--------------|-------|---------|-----------|
| Read         | 2,285 | 4,678   | ❌ 낮음 (재현 가능) |
| Bash         | 2,034 | 2,593   | ✅/⚠️ 조건부 |
| Grep         | 1,338 | 1,931   | ❌ 낮음 (재현 가능) |
| Edit         |   737 | 11,034  | ✅ 높음 (변경 기록) |
| Write        |   323 | 5,042   | ✅ 높음 (생성 기록) |
| Glob         |   171 | 3,733   | ❌ 낮음 (재현 가능) |
| ToolSearch   |   133 | 301     | ❌ 낮음 (시스템 내부) |
| Task         |   114 | 7,592   | ✅ 높음 (서브태스크 결과) |
| Skill        |    23 | 203     | ❌ 낮음 |
| ExitPlanMode |    10 | 5,594   | ⚠️ 조건부 |
| EnterPlanMode|    10 | 275     | ❌ 낮음 |
| Agent        |     6 | 8,320   | ✅ 높음 |
| WebFetch     |     2 | 1,868   | ❌ 낮음 (재현 가능) |
| 기타 MCP     |    ~16| -       | ⚠️ 케이스별 |

### 문제
- Read/Grep/Glob 합계 **3,794개 (52.6%)** → 모두 재현 가능, 저장 불필요
- Bash 중 의미 없는 빈 출력 다수 존재 가능
- 현재 제외 목록: TodoWrite, TodoRead만 (너무 좁음)

---

## 2. agent_response 분석

### 길이 분포

| 구간         | count | 비율  | 특성 |
|--------------|-------|-------|------|
| < 50 chars   |   608 | 27.4% | 도구 체인 전환 메시지 |
| 50~200 chars |   587 | 26.4% | 짧은 중간 응답 |
| 200~1k chars |   758 | 34.1% | 실질적 내용 |
| > 1k chars   |   269 | 12.1% | 명확히 가치 있음 |

### 실제 저장된 짧은 응답 예시

```
[15]  "**문제 찾았습니다!** 🎯"
[20]  "이제 실제로 서버를 시작해보겠습니다:"
[44]  "code-server 문제를 진단해보겠습니다. 먼저 현재 상태를 확인하겠습니다."
[50]  "이제 ChatGraph를 수정하여 ManualQuestionService를 통합합니다."
```

→ Claude가 다음 도구를 호출하기 전에 내뱉는 **전환 문장**. 단독 retrieval 가치 없음.

### 문제
- 608개 (27%)가 50자 미만 전환 메시지 → 노이즈
- min-length 150자 적용 시 **~53% (1,195개) 감소** 가능

---

## 3. user_prompt 분석

### 문제: import 시 필터 미적용

```
[1]  '1', '2', '3'    ← 메뉴 번호 선택
[2]  'go', 'go'       ← 단순 실행 명령
[2]  '커밋', '커밋'   ← 한글 단어 2자
[2]  '\x03\x03'       ← Ctrl+C 입력 (!!!)
```

- 188개가 15자 미만 쓰레기 입력
- **원인**: 임포터가 shouldStorePrompt() 필터를 적용하지 않아 transcript의 모든 user 메시지 저장
- Ctrl+C 입력까지 저장되는 것이 결정적 증거

---

## 전체 최적화 효과 예측

| 대상 | 현재 | 감소량 | 방법 |
|------|------|--------|------|
| tool_obs / Read+Grep+Glob+ToolSearch | 3,927개 | -3,927 | blocklist |
| tool_obs / Bash (empty output) | ~500개 | -500 | min-output-len |
| tool_obs / Skill+EnterPlanMode | ~33개 | -33 | blocklist |
| agent_response < 150자 | ~1,195개 | -1,195 | min-length |
| user_prompt tiny (import) | 188개 | -188 | importer 필터 |
| **합계** | **10,536개** | **약 -5,843개** | |
| **결과** | | **→ 약 4,693개** | **-55% 감소** |
