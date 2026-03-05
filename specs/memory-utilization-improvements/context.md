# Context: Memory Utilization Improvements

## 분석 대상

- **프로젝트**: shopping_assistant
- **프로젝트 키**: f4d5c120
- **분석 일자**: 2026-03-04
- **데이터 기간**: 2026-02-25 ~ 2026-03-04

---

## 실제 측정 데이터

### 전체 지표

| 지표 | 값 | 상태 |
|------|-----|------|
| 총 이벤트 수 | 1,587 | - |
| L0 이벤트 | **1,587 (100%)** | 🔴 심각 |
| L1+ 이벤트 | **0** | 🔴 심각 |
| 총 세션 수 | 40 (f4d5c120) / 55 (전체) | - |
| 벡터 수 | 1,586 | - |
| Retrieval Trace | **1건** | 🔴 심각 |
| 세션 요약 | **2건** | 🔴 심각 |
| 검색 후보 선택률 | 100% (5/5) | ⚠️ 경고 |

### 이벤트 유형 분포

```
Tool Observation:  1,475건  (92.9%)  ← 노이즈 지배적
User Prompt:          94건   (5.9%)
Agent Response:       16건   (1.0%)
Session Summary:       2건   (0.1%)
```

### 활동 타임라인

- 2026-02-25: 521건 (피크)
- 2026-02-26: 478건 (피크)
- 2026-03-04: 40건 (당일)
- 7일 누적: 1,039건

### 주요 세션 샘플

| 세션 ID | 이벤트 수 | 지속 시간 | 날짜 |
|---------|---------|---------|------|
| 5ef326be | 82 | 11분 | 02-25 |
| 790b37f6 | 53 | 2시간 | 02-25 |
| 7302c0af | 69 | - | 02-25 |
| 49653e19 | 31 | 24분 | 03-04 |

---

## 핵심 발견: 실제 증거

### 발견 1: 검색은 실행되나 Trace가 기록되지 않음

User Prompt 이벤트의 metadata를 보면:

```json
// Turn 1 (첫 번째 턴)
{ "adherence": true, "reason": "first-turn" }

// Turn 3
{ "adherence": false, "reason": "skip" }

// Turn 4
{ "adherence": false, "reason": "skip" }

// Turn 5
{ "adherence": true, "reason": "interval-based" }
```

**결론**: `adherence: true`인 경우 검색이 실행됨 → 검색 자체는 작동함.
그러나 DB에 기록된 retrieval trace는 단 1건.
**검색 실행 ≠ Trace 기록 성공** → trace INSERT가 실패하거나 비동기 타이밍 문제.

### 발견 2: Embedding 모델 반복 오류

세션 로그에서 확인된 오류들:

```
"RotaryEmbedding node execution errors"
"Unknown model class 'eurobert'"
"8389 tokens exceeding limits"
"Processing embeddings... ONNX Runtime errors"
```

전체 이벤트 1,587건 중 벡터 1,586개 생성 → 거의 임베딩은 됨.
하지만 모델 오류가 지속적으로 발생 중이며 사용자에게 오류가 노출되고 있음.

### 발견 3: Cascade Failure 구조

```
Trace 기록 실패
    ↓
access_count 미증가
    ↓
Graduation 미발생 (L0 고착)
    ↓
고품질 메모리 없음
    ↓
검색 품질 저하
    ↓
Helpfulness 측정 불가
    ↓
개선 피드백 루프 단절
```

### 발견 4: Tool Observation 과잉 저장

93%가 tool observation이며 내용은 주로:
- 일상적인 bash 명령 결과 (ls, grep 출력)
- 파일 읽기 내용 (반복적)
- Glob 검색 결과

이 데이터들은 다음 세션에서 재사용 가치가 낮음.
오히려 FTS5 검색 코퍼스를 비대화시켜 검색 노이즈 증가.

### 발견 5: Stop Hook 미작동

40 세션 중 세션 요약 2건 → 95%의 세션에서 Stop Hook이 발생하지 않음.
Session-start의 백필 메커니즘도 요약을 생성하지 못하고 있음.

---

## 시스템 환경

- **OS**: Linux 5.15 (Ubuntu)
- **런타임**: Node.js (TSX)
- **DB**: SQLite (better-sqlite3)
- **벡터 DB**: LanceDB
- **임베딩 모델**: jinaai/jina-embeddings-v5-text-nano-text-matching
- **대체 모델**: onnx-community/embeddinggemma-300m-ONNX
- **Heap**: 116MB / 135MB (86% 사용)

---

## 관련 기존 스펙

- `specs/20260207-dashboard-upgrade/` - 대시보드 개선
- `specs/vector-outbox-v2/` - 벡터 임베딩 파이프라인
- `specs/endless-mode/` - 세션 연속성
- `specs/entity-edge-model/` - 엔티티 추적
- `specs/selective-tool-observation/` - Tool observation 선택적 저장 (부분 설계됨)
