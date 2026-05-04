# claude-memory-layer 프로젝트 구조 분석

## 한 줄 요약
`claude-memory-layer`는 단순한 “메모리 플러그인”을 넘어, **Claude Code용 훅 기반 메모리 수집기 + 로컬 저장소 + 벡터 검색 + 대시보드 + 일부 공유/협업 기능**까지 포함한 **로컬 메모리 플랫폼**에 가깝다.

---

## 1. 프로젝트 목적과 현재 포지셔닝

이 저장소의 중심 목적은 다음이다.

- Claude Code 세션/턴/툴 사용 기록을 구조적으로 수집
- 프로젝트 단위로 메모리를 격리 저장
- 과거 대화/툴 결과를 이후 세션에서 재활용
- 대시보드/API를 통해 메모리 상태를 관찰
- 필요 시 shared memory, Mongo sync, MCP 같은 확장 경로를 제공

즉, 이 프로젝트는 **로컬 우선(local-first)** 철학 위에서,

1. **수집(Capture)**
2. **저장(Store)**
3. **임베딩/색인(Index)**
4. **검색/회상(Retrieve)**
5. **관찰/운영(Observe/Operate)**

까지 한 번에 다루는 구조다.

---

## 2. 기술 스택

### 런타임 / 언어
- Node.js 18+
- TypeScript (ESM)
- esbuild 기반 빌드

### 주요 라이브러리
- CLI: `commander`
- 서버/API: `hono`, `@hono/node-server`
- 로컬 DB: `better-sqlite3`
- 벡터 저장소: `@lancedb/lancedb`
- 로컬 임베딩: `@xenova/transformers`
- 선택적 동기화: `mongodb`

### 대표 엔트리 포인트
- CLI: `src/cli/index.ts`
- 대시보드/REST 서버: `src/server/index.ts`
- 훅들: `src/hooks/*.ts`
- 메모리 오케스트레이션: `src/services/memory-service.ts`
- 핵심 검색/저장 계층: `src/core/*`
- MCP 관련 코드: `src/mcp/*`

---

## 3. 디렉터리 구조 분석

### `src/core/`
가장 중요한 도메인 계층이다. 실질적인 메모리 모델과 검색 로직 대부분이 여기 있다.

핵심 역할:
- 이벤트 저장소
- 벡터 저장소
- 임베딩 큐/워커
- 검색기(retriever)
- 매처(matcher)
- 점진적 검색(progressive retrieval)
- 엔티티/엣지/태스크 관련 구조
- markdown mirror
- shared store
- privacy filter
- endless/consolidation 관련 구조

대표 파일:
- `sqlite-event-store.ts`
- `vector-store.ts`
- `vector-worker.ts`
- `retriever.ts`
- `progressive-retriever.ts`
- `matcher.ts`
- `entity-repo.ts`
- `edge-repo.ts`
- `working-set-store.ts`
- `consolidated-store.ts`
- `markdown-mirror.ts`
- `shared-event-store.ts`

### `src/services/`
실질적인 애플리케이션 서비스 계층이다.

대표 파일:
- `memory-service.ts`: 전체 메모리 시스템의 중심 오케스트레이터
- `session-history-importer.ts`: 기존 Claude transcript import
- `codex-session-history-importer.ts`: Codex 계열 import
- `bootstrap-organizer.ts`: 초기 지식 부트스트랩/정리

### `src/hooks/`
Claude Code 훅 기반 자동 수집의 진입점이다.

대표 파일:
- `session-start.ts`
- `user-prompt-submit.ts`
- `post-tool-use.ts`
- `stop.ts`
- `session-end.ts`
- `semantic-daemon.ts`
- `semantic-daemon-client.ts`

이 구조 덕분에 Claude Code lifecycle에 깊게 붙을 수 있다.

### `src/server/`
로컬 서버 + REST API 계층이다.

주요 API:
- `/sessions`
- `/events`
- `/search`
- `/stats`
- `/citations`
- `/turns`
- `/projects`
- `/chat`
- `/health`

### `src/ui/`
정적 HTML/CSS/JS 기반 로컬 대시보드다.
프론트엔드 프레임워크 없이 단일 앱 스타일로 구성되어 있어 배포는 단순하지만, UI가 커질수록 유지보수 난도가 올라갈 수 있다.

### `src/mcp/`
MCP 서버 관련 코드가 존재한다.
다만 현재 패키징/빌드/문서와의 정합성이 완전히 맞아 떨어지지는 않아 보이며, 일부는 “준비 중/부분 구현” 상태로 해석하는 것이 안전하다.

### 기타
- `.claude-plugin/`: Claude plugin manifest / hook 설정
- `tests/`: 핵심 로직 단위 테스트
- `scripts/`: 운영/빌드/헬스체크/버전업 스크립트
- `specs/`: 기능별 설계 문서와 구현 계획
- `docs/`: 운영 및 비교 문서

---

## 4. 데이터 저장 구조

이 프로젝트는 생각보다 훨씬 많은 저장 계층을 가진다.

### 4.1 프로젝트 격리 저장
프로젝트별 경로 해시를 기준으로 저장소를 분리한다.

예상 구조:
- `~/.claude-code/memory/projects/<project-hash>/...`

장점:
- 프로젝트간 contamination 방지
- 검색 범위 제어가 쉬움

### 4.2 세션 레지스트리
세션 ID → 프로젝트 매핑을 별도 registry에 유지한다.

장점:
- 훅이 현재 어느 프로젝트 저장소를 써야 하는지 빠르게 판단 가능

### 4.3 SQLite primary store
핵심 사실: README 일부는 DuckDB 중심처럼 보이지만, 실제 구현의 중심은 **SQLite(WAL)** 이다.

SQLite 내부 테이블은 단순 events 수준이 아니라 꽤 확장되어 있다.
예:
- `events`
- `sessions`
- `embedding_outbox`
- `memory_levels`
- `entries`
- `entities`
- `entity_aliases`
- `edges`
- `vector_outbox`
- `working_set`
- `consolidated_memories`
- `continuity_log`
- `memory_helpfulness`
- `retrieval_traces`
- `sync_positions`

즉, 단순 로그 저장소가 아니라 **이벤트 + 파생 메모리 + 그래프 + 운영 telemetry**가 한 DB에 공존한다.

### 4.4 LanceDB vector index
벡터 검색용 테이블 `conversations` 를 별도로 유지한다.

흐름:
- 이벤트 저장
- 임베딩 outbox 기록
- background worker가 임베딩 생성
- LanceDB에 upsert

### 4.5 Markdown mirror
일부 메모리는 markdown 형태로도 mirror 된다.

의미:
- 사람이 읽기 쉬움
- git 연동/백업/감사 측면 유리
- 하지만 저장 계층이 또 하나 늘어남

### 4.6 Shared / Mongo sync
공유 메모리, 다중 장치/다중 프로젝트 공유를 위한 구조가 이미 들어가 있다.
이건 장점이지만 복잡도를 크게 올리는 요인이다.

---

## 5. 수집 파이프라인

이 프로젝트의 가장 큰 강점 중 하나는 **hook-based capture pipeline** 이다.

### `SessionStart`
- 세션 등록
- 최근 메모리 요약 주입
- semantic daemon 시작 시도

### `UserPromptSubmit`
- 사용자 프롬프트 저장
- retrieval gate 판단
- semantic retrieval / fallback retrieval 수행
- trace/helpfulness 기록

### `PostToolUse`
- 의미 있는 툴 출력만 선택 수집
- privacy 필터 적용
- turn과 연결

### `Stop`
- transcript JSONL에서 마지막 assistant 출력 복원
- 응답 저장
- helpfulness/summary 계산

### `SessionEnd`
- 세션 마무리 요약/정리

이 구조는 “Claude Code가 실제로 어떤 작업을 했는지”를 비교적 풍부하게 재현할 수 있다는 장점이 있다.

---

## 6. 검색 구조

검색은 단순 벡터 검색이 아니라 여러 층으로 되어 있다.

### 주요 구성요소
- `retriever.ts`
- `matcher.ts`
- `progressive-retriever.ts`
- `semantic-daemon.ts`

### 특징
- vector + keyword 조합
- fallback chain
- retrieval trace 기록
- confidence band
- progressive disclosure
- 필요 시 shared scope 확장

즉, “한 번 검색해서 끝”이 아니라,
**빠른 후보 → 더 깊은 후보 → 범위 확장 → 요약 fallback** 식의 다단계 검색으로 설계되어 있다.

---

## 7. 서버/API/대시보드 구조

### 서버
`src/server/index.ts` 에서 로컬 서버를 띄워 API와 정적 UI를 함께 제공한다.

### API 역할
- 검색
- 세션/이벤트 조회
- 통계
- citations
- 프로젝트 정보
- health
- chat proxy

### UI
`src/ui/app.js` 단일 스크립트에 기능이 많이 몰려 있는 편이다.

장점:
- 프레임워크 의존이 적음
- 빌드가 단순함

단점:
- 커질수록 모듈성/테스트/상태관리 한계가 생김

---

## 8. 테스트 / 품질 신호

대략적인 성격:
- 핵심 로직 단위 테스트는 존재
- retriever / matcher / mirror / consolidator 쪽은 확인 가능
- 하지만 end-to-end 훅 흐름, 대시보드 UI, MCP 서버 전체가 아주 탄탄하게 검증되는 구조는 아직 아님

즉,
- **core 로직 신뢰도는 중상**
- **전체 운영 플로우 신뢰도는 추가 E2E 보강 필요**

---

## 9. 아키텍처 강점

### 강점 1: 실제 사용 흐름에 밀착한 hook 중심 구조
Claude Code lifecycle에 직접 붙기 때문에 “기억할 만한 작업”을 비교적 자연스럽게 수집할 수 있다.

### 강점 2: `MemoryService` 중심 오케스트레이션
메모리 시스템 전체를 서비스 계층 하나로 묶어둔 점은 구조적으로 좋다.

### 강점 3: 다층 검색 전략
vector-only보다 훨씬 실용적이다.

### 강점 4: 프로젝트 격리 + 관찰성
project-local memory, retrieval traces, helpfulness, dashboard까지 있어 운영 관점에서 강하다.

### 강점 5: 확장성의 씨앗이 많다
shared store, entity-edge model, task 모델, MCP, bootstrap import 등이 이미 존재한다.

---

## 10. 구조적 리스크 / 약점

### 약점 1: 시스템이 무거워지고 있다
현재는 다음이 동시에 있다.
- hooks
- semantic daemon
- vector worker
- dashboard server
- SQLite
- LanceDB
- markdown mirror
- shared store
- optional Mongo sync
- entity/task graph
- endless/consolidation

이 정도면 “plugin” 수준을 넘어선다.

### 약점 2: 문서와 구현의 drift
분석상 아래와 같은 drift가 보인다.
- README 상 DuckDB vs 실제 SQLite
- README 상 Bun 서술 vs 실제 Hono node-server
- MCP 문서 vs 실제 packaging/entry wiring 간 어긋남

이건 신규 기여자/미래의 본인에게 큰 비용이다.

### 약점 3: 기능 간 중첩 가능성
- event store
- markdown mirror
- shared store
- consolidated store
- working set
- continuity log
이런 계층이 많아지면 “어떤 것이 source of truth인지”가 흐려질 위험이 있다.

### 약점 4: 운영 프로세스 수 증가
daemon/worker/server/hook 조합은 디버깅 난이도를 높인다.

### 약점 5: 일부 기능은 아직 덜 닫혀 보임
MCP, shared, 일부 spec-driven 기능은 코드는 있으나 제품 surface는 덜 정리된 인상이 있다.

---

## 11. 유지보수 관점 평가

이 프로젝트는 **기술적으로 흥미롭고 강한 기반**을 갖고 있지만,
현재 구조를 그대로 계속 확장하면 다음 문제가 생길 가능성이 높다.

- 기능 추가 속도는 느려짐
- 버그 원인 추적이 어려워짐
- 데이터 정합성 이슈가 생길 수 있음
- 문서 부채가 빨리 증가함
- “코어 메모리”보다 주변 기능 운영 비용이 더 커질 수 있음

즉, 지금 시점에서 필요한 건 “기능 더 추가”보다 **코어/확장/실험 계층 분리**다.

---

## 12. 가장 중요한 구조적 해석

이 저장소는 현재 사실상 3개의 제품이 한곳에 들어있다.

1. **코어 메모리 엔진**
   - 이벤트 저장
   - retrieval
   - embedding/index

2. **Claude 통합 제품**
   - hooks
   - plugin manifest
   - transcript import

3. **실험/확장 플랫폼**
   - shared store
   - Mongo sync
   - MCP
   - entity/task graph
   - endless/consolidation
   - dashboard analytics

이 셋을 명확히 분리하지 않으면 관리비가 계속 오른다.

---

## 13. 결론

`claude-memory-layer`는 이미 **작고 예쁜 유틸리티**가 아니라,
**강한 기능을 가진 로컬 메모리 플랫폼**이다.

좋은 점은:
- 실제 사용 가치가 있는 구조를 이미 많이 갖췄고
- 검색/수집/운영 관점이 모두 살아 있으며
- 발전 가능성이 매우 크다.

하지만 동시에:
- 구조가 빠르게 비대해지고 있고
- 문서/구현 drift가 생기고 있으며
- 앞으로는 “무엇을 더 넣을지”보다 “무엇을 코어에서 분리할지”가 더 중요하다.

이 프로젝트는 충분히 더 강해질 수 있다.
다만 그 방향은 **기능 추가형 비대화**보다,
**얇은 코어 + 선택형 확장 모듈** 구조로 가는 것이 더 유리해 보인다.
