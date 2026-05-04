# claude-memory-layer Refactoring Milestones & Issue Breakdown

## 목적
이 문서는 `claude-memory-layer`를 thin-core 구조로 리팩터링하기 위한 실행 가능한 milestone과 issue 단위 작업 목록이다.

핵심 목표:
- 구조를 설명 가능하게 만든다
- 코어를 얇게 만든다
- Claude 통합은 유지한다
- 무거운 기능은 확장 계층으로 밀어낸다
- 완전 재작성이 아니라 단계적 이전을 한다

---

# Milestone 0. Architecture Alignment

## 목표
문서/용어/현실 구현을 맞춘다. 코드 수정 전에 반드시 필요하다.

### Issue 0-1. Canonical storage 정의 문서화
**내용**
- SQLite / LanceDB / markdown mirror / shared / Mongo sync의 역할을 명시
- canonical vs derived 레이어 정의

**산출물**
- 아키텍처 문서 업데이트
- 저장 계층 표

**완료 기준**
- 신규 기여자가 어떤 데이터가 원본인지 1분 내 이해 가능

### Issue 0-2. README drift 정리
**내용**
- DuckDB/Bun/MCP 관련 설명을 실제 구현과 맞춤
- 현재 shipped feature vs experimental feature 분리

**완료 기준**
- README와 실제 엔트리포인트/의존성이 일치

### Issue 0-3. 용어 정리
**내용**
- event / fact / summary / rule / shared memory / citation / retrieval trace 용어 정의

**완료 기준**
- 문서와 코드 naming이 서로 충돌하지 않음

---

# Milestone 1. Domain Model Separation

## 목표
현재 혼합된 메모리 개념을 raw / fact / summary 계층으로 분리한다.

### Issue 1-1. `RawEvent` 타입 도입
**내용**
- prompt / assistant / tool output / session marker / imported records를 단일 raw event 모델로 정리

**완료 기준**
- 모든 ingest path가 raw event로 normalize 가능

### Issue 1-2. `MemoryFact` 타입 도입
**내용**
- 검색 단위로 쓸 작은 fact 모델 정의
- source event reference 포함

**완료 기준**
- 최소 3개 ingest path(프롬프트/응답/툴 출력)에서 fact derivation 가능

### Issue 1-3. `MemorySummary` 타입 도입
**내용**
- turn/session/project/continuity summary 타입 정리

**완료 기준**
- 요약 결과가 raw event/fact와 분리 저장됨

### Issue 1-4. Retrieval result type 표준화
**내용**
- `fact`, `summary`, `tool_evidence`, `source`, `rule` 타입 도입

**완료 기준**
- search API 응답이 통일된 envelope를 사용

---

# Milestone 2. Core Engine Extraction

## 목표
`MemoryService`를 작은 조립층으로 축소하고 핵심 기능을 분리한다.

### Issue 2-1. `ProjectRegistryService` 추출
**내용**
- project path hash, storage path, session registry 관리 분리

**완료 기준**
- `memory-service.ts`에서 registry 관련 책임 제거

### Issue 2-2. `MemoryIngestService` 추출
**내용**
- raw event append 경로 분리
- privacy filter / capture normalization 연결

**완료 기준**
- append 관련 코드가 별도 서비스에 위치

### Issue 2-3. `FactDeriver` 추출
**내용**
- raw event → fact 변환 책임 분리

**완료 기준**
- fact derivation이 독립 테스트 가능

### Issue 2-4. `SummaryDeriver` 추출
**내용**
- turn/session/project 요약 생성 로직 분리

**완료 기준**
- summary 로직이 retrieval/index 로직과 분리됨

### Issue 2-5. `RetrievalEngine` 추출
**내용**
- 검색/확장/소스해석 책임 분리

**완료 기준**
- `MemoryService`는 retrieval orchestration만 함

---

# Milestone 3. Claude Adapter Isolation

## 목표
Claude-specific lifecycle을 adapter 레이어로 분리한다.

### Issue 3-1. `src/adapters/claude/hooks` 생성
**내용**
- 기존 `src/hooks/*` 파일을 새 adapter 위치로 이동 또는 re-export

**완료 기준**
- hook entrypoint가 adapter layer 아래 존재

### Issue 3-2. transcript parsing 분리
**내용**
- stop/session-end에서 사용하는 transcript reconstruction 로직 분리

**완료 기준**
- transcript 관련 유틸이 hook handler와 분리됨

### Issue 3-3. capture policy 분리
**내용**
- 어떤 prompt/tool/response를 저장할지 정책 모듈화

**완료 기준**
- capture heuristics가 테스트 가능한 정책 모듈이 됨

### Issue 3-4. context injection formatter 분리
**내용**
- additionalContext 생성 로직을 retrieval engine과 분리

**완료 기준**
- 검색 결과와 Claude용 문자열 포맷팅이 분리됨

---

# Milestone 4. Storage & Index Simplification

## 목표
SQLite 중심 구조를 선명히 하고, vector 계층을 optional accelerator로 명확히 한다.

### Issue 4-1. storage role matrix 작성 및 코드 반영
**내용**
- SQLite canonical / LanceDB derived / markdown journal projection 규칙 반영

**완료 기준**
- 코드 주석과 문서가 같은 storage 역할을 설명

### Issue 4-2. SQLite-only fallback 공식화
**내용**
- vector index 없이도 최소 search / recent context 동작

**완료 기준**
- vector 미초기화 상태 테스트 통과

### Issue 4-3. vector 계층 네임스페이스 이동
**내용**
- `vector-store`, `vector-worker`, `embedder` 등을 `extensions/vector`로 이동

**완료 기준**
- core 모듈이 vector 구현 세부사항에 직접 의존하지 않음

### Issue 4-4. stable derived key 도입
**내용**
- fact / summary / imported transcript memory에 deterministic key 부여

**완료 기준**
- dedupe/rebuild가 key 기반으로 가능

---

# Milestone 5. Retrieval UX Productization

## 목표
검색 품질보다 “검색 결과를 설명 가능하고 쓰기 쉽게” 만든다.

### Issue 5-1. `search -> expand -> source` API 설계
**내용**
- search 결과
- expanded context
- source drill-down을 별도 surface로 노출

**완료 기준**
- CLI/API/dashboard 모두 같은 mental model 사용

### Issue 5-2. retrieval reason 표준화
**내용**
- semantic / keyword / recent / continuity / entity / fallback reason taxonomy 도입

**완료 기준**
- 모든 search result에 최소 1개 reason 포함

### Issue 5-3. result type badge 추가
**내용**
- fact / summary / tool evidence / source 구분

**완료 기준**
- 사용자가 결과 종류를 즉시 이해 가능

### Issue 5-4. helpfulness minimal loop
**내용**
- shown / clicked / expanded / accepted / reused 등 최소 signal 수집

**완료 기준**
- retrieval trace와 연결된 lightweight feedback 저장 가능

---

# Milestone 6. Extensions Isolation

## 목표
무거운 기능을 core 바깥으로 이동한다.

### Issue 6-1. shared memory 모듈 분리
**내용**
- shared event store / shared vector / promoter를 `extensions/shared-memory`로 이동

**완료 기준**
- shared 기능 OFF 상태에서 core 영향 최소

### Issue 6-2. Mongo sync 분리
**내용**
- sync 관련 설정/worker/ops 스크립트 경계 분리

**완료 기준**
- Mongo dependency가 core 실행 경로에서 제거됨

### Issue 6-3. MCP extension 분리
**내용**
- MCP server/tools/handlers를 `extensions/mcp`로 이동

**완료 기준**
- MCP 비활성 상태가 정상 기본 경로가 됨

### Issue 6-4. continuity/endless mode 분리
**내용**
- working set / consolidated / continuity 관련 기능을 `extensions/continuity`로 이동

**완료 기준**
- core search/ingest와 endless mode가 느슨하게 결합됨

---

# Milestone 7. Apps Cleanup

## 목표
CLI / server / dashboard를 app layer로 정리한다.

### Issue 7-1. CLI app 경계 정리
**내용**
- CLI는 parsing/composition만 담당
- business logic 최소화

### Issue 7-2. server app 경계 정리
**내용**
- API route와 core service composition 분리

### Issue 7-3. dashboard asset modularization
**내용**
- `app.js` 단일 파일을 기능별 모듈로 분해

**완료 기준**
- Search / Sessions / Health / Projects 등 기능별 분리

---

# Milestone 8. Code-Aware Memory Anchors (Optional, Recommended)

## 목표
full code graph 대신 가벼운 code-aware memory를 도입한다.

### Issue 8-1. file path refs 도입
**내용**
- memory fact가 관련 파일 경로를 참조 가능하게 함

### Issue 8-2. symbol refs 도입
**내용**
- 함수/클래스/모듈명 anchor를 metadata에 저장

### Issue 8-3. commit/diff refs 도입
**내용**
- imported or observed coding actions에 git context 연결

**완료 기준**
- “이 기억이 어떤 코드와 관련 있는지”를 가볍게 설명 가능

---

# Milestone 9. Hardening & Migration Finish

## 목표
새 구조를 기본 구조로 전환하고 legacy compatibility를 줄인다.

### Issue 9-1. compat layer 축소
**내용**
- re-export/legacy wrapper 단계적으로 제거

### Issue 9-2. test matrix 재정리
**내용**
- core
- adapters/claude
- extensions
- apps
별로 테스트 층 구분

### Issue 9-3. docs refresh
**내용**
- architecture
- operations
- install
- extension status 표기

### Issue 9-4. release checklist 업데이트
**내용**
- 어떤 extension이 stable/experimental인지 릴리즈 노트에 명시

---

# 추천 우선순위

## 즉시 착수 권장
1. Milestone 0
2. Milestone 1
3. Milestone 2
4. Milestone 3

## 다음 단계
5. Milestone 4
6. Milestone 5
7. Milestone 6

## 선택적 후속
8. Milestone 7
9. Milestone 8
10. Milestone 9

---

# 90일 추천 로드맵

## 1~2주
- Milestone 0 완료
- 핵심 용어 및 문서 정리

## 3~5주
- Milestone 1~2 진행
- 도메인 타입과 core service 분리

## 6~8주
- Milestone 3~4 진행
- Claude adapter와 vector/storage 경계 정리

## 9~10주
- Milestone 5 진행
- retrieval UX/API 정리

## 11~12주
- Milestone 6 시작
- shared/MCP/Mongo/continuity extension 분리

---

# 현재 구현/검증 상태 (2026-05-04 KST)

## 이번 thin-core refactor에서 반영된 주요 항목
- `src/core/registry/`와 `src/services/memory-service-registry.ts`로 project path/hash/session/default/lightweight service-locator 책임을 분리했다.
- `src/services/memory-service-config.ts`가 disabled/enabled shared-store 기본값을 소유하고, `memory-service.ts`는 public compatibility export만 보존한다.
- `src/core/model/`에 raw/fact/summary/rule/retrieval result 계층 타입을 추가했다.
- `src/core/derive/fact-deriver.ts`와 summary derivation 흐름으로 deterministic derivation의 첫 slice를 분리했다.
- `src/core/engine/` 아래로 `MemoryService`의 주요 책임을 분리했다.
  - `memory-engine-services.ts`: SQLite/vector/embedder/retrieval/ingest/query bundle construction
  - `retrieval-orchestrator.ts`, `retrieval-disclosure-service.ts`, `retrieval-analytics-service.ts`, `retrieval-services.ts`
  - `memory-ingest-service.ts`, `memory-query-service.ts`, `memory-runtime-service.ts`
  - `embedding-maintenance-service.ts`, `endless-memory-services.ts`, `shared-memory-services.ts`
  - `memory-service-composition.ts`: constructor-time service graph wiring
- `MemoryService`는 현재 대부분 public compatibility facade + project state + composition assignment + service delegation 역할만 남겼다.
- Claude hook 구현은 `src/adapters/claude/hooks/`로 이동했고, `src/hooks/*`는 compatibility wrapper로 축소했다.
- Progressive retrieval disclosure는 service/API/CLI/dashboard까지 `search -> expand -> source` mental model로 연결했다.
- Shared disclosure drill-down은 `shared:<entryId>`를 local raw event처럼 위장하지 않고 shared provenance를 명시한다.
- `Retriever`에 deep retrieval 품질 개선용 intent rewrite merge, keyword rerank, graph-hop expansion, project scope filtering을 추가했다.
- `@modelcontextprotocol/sdk@1.29.0` 기준으로 MCP `CallToolResult` 타입을 명시해 full typecheck를 복구했다.

## 최근 완료 commit checkpoint
```text
2bd32b5 refactor(memory): centralize shared store defaults
4f6ccc8 test(memory): document project registry shared config caching
099dad1 [verified] Extract memory service registry
ddea95e refactor(memory): extract service composition wiring
54c360e refactor(memory): route embedding model facade through maintenance service
e776d57 refactor(memory): delegate graduation access through runtime service
36313a6 refactor(memory): move endless context formatting
28e144d refactor(memory): move ingest pipeline to ingest service
265899a refactor(memory): extract query service facades
53354e3 refactor(memory): extract memory runtime service
0b5bde4 refactor(memory): extract embedding maintenance service
95d2075 Extract endless memory services
6da4ddb refactor(memory): extract shared memory services
c19757d refactor(memory): bundle engine service construction
e186ee4 refactor(claude): move semantic daemon behind adapter boundary
8071313 refactor(claude): move hook implementations behind adapter boundary
50ff74e feat(dashboard): show shared retrieval provenance
518bdda feat(cli): show shared retrieval results
c58f50f fix(retrieval): keep disclosure drill-down lightweight
81bbf70 refactor(retrieval): bundle retrieval services
```

## 현재 milestone status
- **Milestone 0 — Architecture Alignment:** 부분 완료. 계획/비교 문서는 존재하지만 README drift와 extension stability 표시는 추가 정리가 필요하다.
- **Milestone 1 — Domain Model Separation:** 부분 완료. raw/fact/summary/retrieval result 타입과 일부 derivation은 분리됐지만 fact/summary 저장 모델의 제품화는 남아 있다.
- **Milestone 2 — Core Engine Extraction:** 큰 진전. `MemoryService`의 retrieval/ingest/query/runtime/shared/endless/embedding/composition/registry 책임이 대부분 별도 서비스로 이동했다.
- **Milestone 3 — Claude Adapter Isolation:** 큰 진전. hooks/transcript/semantic-daemon adapter boundary가 생겼다. capture policy 추가 분리는 후속 후보다.
- **Milestone 4 — Storage & Index Simplification:** 부분 완료. SQLite canonical / vector derived 관점은 구현에 반영됐지만 vector extension namespace 이동은 남아 있다.
- **Milestone 5 — Retrieval UX Productization:** 큰 진전. service/API/CLI/dashboard disclosure surface가 있다. helpfulness feedback loop의 제품화는 후속이다.
- **Milestone 6 — Extensions Isolation:** 시작됨. shared memory service implementation은 `src/extensions/shared-memory/`로 이동했고 `src/core/engine/shared-memory-services.ts`는 compatibility re-export로 남겼다. endless/vector/MCP 물리 이동은 후속이다.
- **Milestone 7~9:** 후속 hardening/release cleanup 단계.

## 통과한 검증
```bash
npm test -- --run tests/memory-service-config.test.ts tests/memory-service-registry.test.ts tests/memory-service-composition.test.ts
# 3 files / 12 tests passed

npm run typecheck -- --pretty false
# passed

git diff --check
# passed

npm test -- --run
# 35 files / 168 tests passed

npm run build
# Build complete

graphify update .
# graphify-out updated: 1250 nodes, 2602 edges, 49 communities
```

## 현재 known status
- full typecheck, full vitest suite, build가 모두 통과한다.
- full test에서 새 regressions는 발견되지 않았다.
- `graphify-out/`는 현재 `git status --short`에 tracked 변경으로 나타나지 않는다.
- `patch` 도구의 파일 단위 자동 lint는 tsconfig project mode가 아니라 단일 파일 컴파일 방식으로 동작해 `node_modules`/target 관련 false positive를 출력할 수 있다. authoritative check는 `npm run typecheck -- --pretty false`로 본다.

## 다음 권장 slice

1. **MemoryService facade audit 마무리**
   - `MemoryService`에 남은 직접 상태는 `projectHash`, `projectPath`, mode flags, service field assignment 정도다.
   - 더 뺄 후보는 `session-history-importer`, `codex-session-history-importer`, `mcp/handlers`처럼 아직 `MemoryService`에 직접 붙어 있는 adapter/app callsite다.

2. **Extension 물리 이동 여부 결정**
   - shared/endless/vector/MCP를 실제 `src/extensions/*`로 옮길지, 현재 `src/core/engine/*` service boundary를 안정화한 뒤 이동할지 결정한다.

3. **README / release docs refresh**
   - 현재 shipped feature와 experimental extension을 구분한다.
   - shared store, endless mode, disclosure API/CLI/dashboard 상태를 문서화한다.

4. **Generated graph/code-map artifact 정책 결정**
   - `graphify-out/`를 버전 관리할지, 생성물로 유지할지 명확히 한다.

---

# 최종 판단

이 계획에서 가장 중요한 것은 기능 삭제가 아니다.
오히려 **기능의 위치를 올바르게 재배치하는 것**이다.

즉:
- 코어는 더 얇게
- Claude 통합은 더 또렷하게
- 확장은 더 안전하게
- 문서는 더 정직하게

이 네 가지가 맞춰지면 `claude-memory-layer`는 지금보다 훨씬 강한 장기 구조를 갖게 된다.
