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

### 2026-05-10 claude-memory-layer dashboard dogfood 추가 관측

- **대상 URL**: live dashboard on port 37777 (password redacted)
- **대상 project**: `/Users/namsangboy/workspace/claude-memory-layer` (`b7f03a73`)
- **상태**: login/root dashboard 렌더 정상, browser console error 0
- **Project stats**:
  - total events: 47
  - active sessions: 10
  - retrieval queries: 15
  - retrieval selection rate: 93.3%
  - vector nodes: 0
  - embedding_outbox: 34 pending
  - memory usefulness score: 33.9 / low confidence 0.45
  - helpfulness evaluations: 0
- **검색 품질**:
  - exact/keyword queries(`publish`, `mcp 서버`, `ouroboros skill`)는 200과 관련 source result를 반환
  - semantic/current-issue query(`dashboard Internal Server Error query_rewrite_kind`)는 현재 DB에 아직 ingest되지 않아 0건
  - vector nodes 0이라 의미있는 semantic recall 판단은 불가, keyword-only recall 상태
- **대시보드 안정성 이슈**:
  - legacy DB schema에서 stats 500을 유발했던 `query_rewrite_kind` missing 문제는 `v1.0.35`에서 수정됨
  - dashboard read-only endpoints(`/api/health`, `/api/events`, `/api/sessions`, `/api/stats`, `/api/stats/shared`, `/api/stats/endless`, `/api/stats/levels/:level`, `/api/stats/most-accessed`, `/api/stats/timeline`, `/api/stats/helpfulness`, `/api/stats/usefulness`, `/api/stats/retrieval-traces`, `/api/stats/retrieval-review-queue`, `/api/stats/kpi`)도 full embedder init 대신 lightweight service를 써야 함
  - published `1.0.38` fresh-install UI smoke에서 stats subroutes가 embedder/model init failure로 500을 낸 것을 재현했고, `1.0.39`에서는 POST `/api/stats/graduation/run`을 제외한 dashboard read stats subroutes를 SQLite/read-only path로 고정함
  - published `1.0.39` smoke에서 `/api/health`도 같은 full-service init 문제로 500을 낸 것을 재현했고, `1.0.40`에서는 GET `/api/health`도 lightweight read path로 고정함
  - disclosure search `auto`는 embedding backend unavailable 시 lightweight fast fallback이 필요함
- **메모리 의미성 이슈**:
  - `claude-memory-layer` project DB 안에 legacy unscoped Hermes imports가 들어 있어 `predictor`, `Streamlit`, `alpha-ai-trader` snippets가 project view에 보일 수 있음
  - Ask Memory는 Claude CLI auth 상태에 의존하며, auth failure 시 memory retrieval 품질과 provider 오류가 섞여 보임

### 2026-05-10 구현/검증 업데이트

- **Outbox/vector readiness**:
  - 기존 `embedding_outbox processing=34` stuck 상태를 recovery로 해소
  - CLI `process` 실행 후 `Processed 32 embeddings`
  - CLI/API stats 기준 `eventCount=51`, `vectorCount=51`
  - outbox aggregate: embedding/vector `pending=0`, `processing=0`, `failed=0`
- **Ask Memory/provider 분리**:
  - `/api/chat` memory-only mode 추가
  - provider 호출 없이 `event: diagnostic` + retrieved context + `event: done` 반환
  - provider 실패는 `event: provider_error`로 분리하고 memory fallback을 제공
  - dashboard UI `/memory <query>` command 추가
- **Live dogfood 결과**:
  - `/health`, login, `/api/stats`, `/api/events`, `/api/sessions`, `/api/health/recover`, `/api/chat` memory-only 모두 local smoke 200
  - memory-only query는 retrievedMemories count를 반환하고 context를 직접 보여준다.
- **남은 품질 이슈(해소됨)**:
  - generic `dashboard` query에서 Alpha AI Trader/Streamlit legacy imports가 top result로 섞였다.
  - 원인은 provider/auth가 아니라 project DB 내부의 mis-scoped legacy corpus였다.
  - `repair legacy-project-scope -p /Users/namsangboy/workspace/claude-memory-layer --apply`로 content-project-mismatch 11건을 quarantine했다.
  - 이후 raw predictor PR contamination memory는 기본 검색에서 제외됐다.
  - CML repair 설명/회고 메모리가 predictor-contamination audit query에 매칭되는 것은 정상으로 보고, detector가 이런 설명 메모리를 quarantine하지 않도록 false-positive를 보정했다.
  - `getLevelStats`/`getEventsByLevel`뿐 아니라 `getEvent`, `getSessionEvents`, `getRecentEvents`, `getEventsSince*`, `getEventsPage`, `getEventsByTurn`, `getSessionTurns`, `countSessionTurns`, `getMostAccessed`, `getHelpfulMemories`, `countEvents`, `keywordSearch` 기본 path에서 active quarantine rows를 제외한다. quarantine audit은 명시적 `includeQuarantined` opt-in만 사용한다.
  - invalid legacy metadata JSON은 default read에서 crash하지 않고 metadata를 비워 읽으며, session project path evidence가 있으면 repair/quarantine 대상이 된다.
  - 이미 current hash/tag가 있더라도 explicit `projectPath`/`sourceProjectPath`/session project path가 foreign project를 가리키면 `project-path-mismatch`로 quarantine한다.
  - core repair API와 CLI helper는 `projectPath`/`projectHash` mismatch를 fail-closed 처리하고, CLI는 명시적 빈 `--project` 및 hash-only missing-store dry-run side effect를 막는다.
- **Privacy dogfood 보강**:
  - dashboard smoke command의 `--password ...`, prefixed CLI secret options(`--client-secret ...`, `--db-password ...`, `--access-token ...`), hyphenated secret assignment(`db-password=...` 등), URL 다음 줄에 붙여넣은 password-looking 문자열이 memory event에 저장되기 전 `[REDACTED]` 처리되도록 privacy filter를 확장했다. URL 다음 줄의 일반 상태 단어는 과잉 redact하지 않는다.
  - 이미 실데이터 DB에 들어간 credential-like smoke rows는 content cleanup을 적용했고, conservative scan 기준 unredacted credential-like row 0건을 확인했다.

---

### 기존 분석 환경

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
