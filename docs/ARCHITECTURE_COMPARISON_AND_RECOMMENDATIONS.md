# claude-memory-layer vs memsearch vs superlocalmemory

## 목적
이 문서는 다음 3개 프로젝트를 비교해,

- `claude-memory-layer`
- `memsearch`
- `superlocalmemory`

현재 `claude-memory-layer`에 **도입하면 좋은 구조/기능/운영 패턴**을 정리하고,
동시에 이 프로젝트가 너무 무거워지지 않도록 **더 가볍고 강력한 방향**을 제안하기 위한 문서다.

---

# 1. 세 프로젝트를 한 문장으로 요약하면

## claude-memory-layer
**Claude Code에 깊게 결합된 훅 기반 로컬 메모리 플랫폼**.
강점은 실제 workflow에 밀착된 capture/retrieval/telemetry이고, 약점은 확장 기능이 한 저장소에 많이 쌓이며 구조가 무거워지고 있다는 점이다.

## memsearch
**Markdown source-of-truth + Milvus hybrid search** 중심의 가볍고 선명한 memory engine.
강점은 코어의 단순함과 UX 패턴이고, 약점은 integration edge에서 운영 복잡도가 올라간다는 점이다.

## superlocalmemory
**SQLite 기반의 거대한 로컬 memory OS / agent platform**.
강점은 breadth와 retrieval sophistication이고, 약점은 범위가 너무 넓어서 유지보수 discipline이 없으면 쉽게 비대화된다는 점이다.

---

# 2. 구조 비교

## 2.1 코어 철학 비교

### claude-memory-layer
- 이벤트 중심 수집
- 프로젝트 격리 저장
- hook-driven capture
- vector + keyword retrieval
- dashboard/telemetry 강함
- 확장 기능이 코어 내부로 많이 들어와 있음

### memsearch
- markdown 원본 우선
- vector index는 파생물
- 코어는 작은 indexing/search engine
- agent별 통합은 plugin으로 분리
- progressive disclosure UX 강함

### superlocalmemory
- local-first memory engine + retrieval + learning + graph + mesh
- atomic facts 기반 구조화 기억
- 도구/대시보드/학습/에이전트 coordination까지 모두 포함
- 사실상 memory platform + agent operating substrate

### 핵심 인사이트
현재 `claude-memory-layer`는 방향상 **memsearch보다 superlocalmemory 쪽으로 끌려가는 중**이다.
즉,
- 시작점은 “좋은 메모리 플러그인”이었을 수 있지만
- 이미 “작은 플랫폼”이 되었고
- 계속 놔두면 “큰 플랫폼”이 될 가능성이 높다.

이건 나쁜 게 아니라, **의도적 분리 없이 커지면 위험하다**는 뜻이다.

---

## 2.2 저장 모델 비교

### claude-memory-layer
- SQLite primary store
- LanceDB vector store
- markdown mirror
- shared store
- optional Mongo sync
- telemetry/helpfulness/retrieval traces

장점:
- 기능 강함
- 분석 가능성 높음

약점:
- source of truth가 무엇인지 흐려질 수 있음
- 저장 계층이 많음

### memsearch
- markdown source of truth
- Milvus derived index
- 단순하고 설명 가능

장점:
- 구조 명확
- 복구/백업/버전관리 쉬움

약점:
- 구조화 메타모델은 얇음

### superlocalmemory
- SQLite primary store
- raw memory + atomic facts 분리
- FTS + embeddings + graph + learning metadata + code graph schema

장점:
- 표현력 매우 높음

약점:
- 스키마가 비대하고 migration 비용 큼

### 핵심 인사이트
`claude-memory-layer`는 지금 상태에서 **memsearch의 source-of-truth 단순성**과 **superlocalmemory의 fact 분리 아이디어**를 동시에 참고하는 것이 좋다.

추천 방향:
- source of truth를 다시 명확히 정의
- raw event와 derived memory를 명시적으로 분리
- derived 계층은 재생성 가능하게 유지

---

## 2.3 검색 구조 비교

### claude-memory-layer
- vector + keyword
- fallback chain
- progressive retriever
- semantic daemon
- helpfulness/retrieval trace 기록

### memsearch
- dense + BM25 + RRF
- search → expand → transcript drill-down
- retrieval UX가 선명함

### superlocalmemory
- semantic / BM25 / entity graph / temporal / spreading activation / hopfield
- 고급 fusion / rerank / diversity

### 핵심 인사이트
`claude-memory-layer`는 검색 품질 측면에서 이미 꽤 좋다.
문제는 “더 많은 채널”이 아니라 **검색 구조를 얼마나 명확하게 제품화하느냐**다.

즉, 지금 바로 필요한 것은:
- superlocalmemory처럼 채널을 6개, 8개로 늘리는 것보다
- memsearch처럼 **사용자 입장에서 이해되는 retrieval UX**를 만드는 것

예:
- quick hits
- expanded context
- original transcript/source
- why this was retrieved

---

## 2.4 통합 구조 비교

### claude-memory-layer
- Claude Code 특화가 강함
- 훅 통합이 깊고 강력함
- 하지만 Claude 바깥 확장 경로(MCP 등)는 아직 덜 닫힘

### memsearch
- core와 plugin이 비교적 잘 분리됨
- Claude/Codex/OpenClaw/OpenCode 각각 적응
- cross-platform portability 좋음

### superlocalmemory
- MCP/CLI/hooks/IDE integrations가 매우 넓음
- 거의 모든 surface를 제공하려 함

### 핵심 인사이트
`claude-memory-layer`는 당장 superlocalmemory처럼 모든 플랫폼을 다 품으려 하기보다,
**memsearch처럼 “코어 엔진”과 “Claude adapter”를 더 분리**하는 편이 낫다.

---

# 3. claude-memory-layer에 바로 도입하면 좋은 아이디어

## 3.1 memsearch에서 가져오면 좋은 것

### A. Markdown source-of-truth 또는 적어도 “사람이 읽는 canonical layer” 강화
현재도 markdown mirror가 있지만 보조 레이어처럼 보인다.

추천:
- markdown mirror를 단순 로그가 아니라 **canonical human-readable memory journal**로 승격 검토
- 또는 최소한 “event store는 machine canonical, markdown journal은 human canonical”처럼 역할을 명확히 정의

왜 좋은가:
- 디버깅 쉬움
- 백업/내보내기 쉬움
- 사용자 신뢰도 상승
- 다른 시스템과 상호운용 쉬움

### B. Search → Expand → Transcript drill-down UX
이건 매우 좋다.

현재 `claude-memory-layer`에도 progressive retrieval이 있지만,
사용자-facing UX로 더 분명하게 드러내면 좋다.

추천 기능:
1. `memory search` → 요약 후보
2. `memory expand` → 해당 기억의 더 넓은 컨텍스트
3. `memory transcript` 또는 `memory source` → 원문/근거

### C. Core와 plugin integration의 경계 명확화
`memsearch`는 코어가 작다.
이 점이 매우 중요하다.

`claude-memory-layer`도 다음처럼 나누는 것이 좋다.
- `core-memory-engine`
- `claude-adapter`
- `dashboard`
- `experimental extensions`

### D. Chunk identity / incremental reindex 사고방식
`memsearch`의 composite ID 전략은 매우 실용적이다.

`claude-memory-layer`에서도:
- event-derived memory
- summary memory
- tool-derived memory
- imported transcript memory

각 타입에 대해 stable derived key를 더 엄밀히 두면 dedupe/reindex/rebuild가 쉬워진다.

---

## 3.2 superlocalmemory에서 가져오면 좋은 것

### A. Raw memory vs atomic facts 분리
이건 가장 가치 있는 아이디어 중 하나다.

현재 `claude-memory-layer`는 event/entry/entity/edge가 있지만,
개념적으로는 다소 혼합되어 보인다.

추천:
- **Raw events**: 원본 대화/툴 결과/세션 정보
- **Derived facts**: 검색에 최적화된 작은 사실 단위
- **Higher-order memory**: summaries / rules / working set / continuity

이 3층을 더 명시적으로 나누자.

효과:
- retrieval 품질 향상
- consolidation 설계 명확화
- feature 추가 시 어디에 넣어야 하는지 분명해짐

### B. SQLite one-engine 철학
superlocalmemory의 장점 중 하나는 “기본 중심축이 SQLite 하나”라는 점이다.

`claude-memory-layer`는 지금 SQLite + LanceDB + markdown + shared + optional Mongo로 축이 많다.

추천:
- 코어 운영 모드는 최대한 **SQLite-only 기본값**으로 재정의
- LanceDB는 optional acceleration layer로 격하 검토
- shared/Mongo는 플러그인/extension으로 분리

### C. Retrieval channel metadata
superlocalmemory처럼 채널을 많이 늘리라는 뜻은 아니다.
대신 검색 결과에 “어떤 이유로 나왔는지”를 구조적으로 남기는 것은 좋다.

예:
- matched by: semantic / keyword / entity / recency / continuity
- evidence strength
- source type: prompt / assistant / tool / summary / imported

이건 explainability를 높인다.

### D. Code graph bridge (선택적)
이건 매우 강력할 수 있다.
다만 그대로 가져오면 과체중이다.

추천은 full code graph가 아니라 **lightweight code-link layer**다.

예:
- memory item ↔ file path
- memory item ↔ symbol name
- memory item ↔ git commit / diff chunk

즉, graph DB를 만들기 전에 먼저 **code-aware memory anchors** 부터 도입하는 게 좋다.

### E. Learning/feedback 루프의 최소형 버전
superlocalmemory의 전체 learning 시스템은 무겁다.
하지만 그 핵심 문제의식은 좋다.

추천 최소 버전:
- retrieval shown count
- retrieval accepted/used count
- user helpfulness feedback
- implicit signals:
  - retrieved memory 인용 후 성공적으로 작업 완료
  - retrieved memory 직후 같은 검색 반복 여부

이 정도만 있어도 rank 개선/cleanup에 충분히 유용하다.

---

# 4. claude-memory-layer에 도입하지 않는 게 좋은 것

## 4.1 superlocalmemory식 “모든 것 다 포함” 접근
지금 상태의 `claude-memory-layer`는 이미 무거워질 조짐이 있다.
여기에 아래를 한 번에 넣으면 위험하다.

- full learning platform
- full mesh multi-agent broker
- full code graph platform
- huge dashboard surface
- massive MCP tool surface

이건 제품 초점을 흐릴 수 있다.

## 4.2 너무 이른 구조화 과잉
엔티티/엣지/태스크/연속성/요약/공유 메모리까지 이미 있는 상태에서,
더 많은 추상화를 곧바로 넣으면 “좋아 보이지만 관리되지 않는 복잡성”이 된다.

## 4.3 source-of-truth 다중화
SQLite, Markdown, Shared, Mongo, Vector가 모두 서로 경쟁하는 canonical layer가 되면 안 된다.

반드시 정리해야 한다.

---

# 5. claude-memory-layer를 더 가볍고 강하게 만드는 리팩터링 방향

## 핵심 원칙
> **작은 코어를 먼저 명확히 만들고, 실험 기능은 모듈로 밀어낸다.**

---

## 5.1 목표 아키텍처

### Layer 1: Core Memory Engine
반드시 항상 필요한 것만 둔다.

포함:
- session/project registry
- raw event store
- derived fact store
- retrieval engine
- minimal citations/source tracing
- import/export

### Layer 2: Claude Adapter
Claude Code 훅 통합만 담당한다.

포함:
- session lifecycle hooks
- transcript extraction
- tool capture policy
- context injection

### Layer 3: Optional Accelerators
선택 기능이다.

포함 예:
- semantic daemon
- LanceDB vector index
- reranking
- helpfulness analytics
- dashboard advanced panels

### Layer 4: Experimental Extensions
코어 밖 실험장이다.

포함 예:
- shared memory
- Mongo sync
- MCP
- task/entity graph 고도화
- endless/consolidation 실험
- code-aware memory

이렇게 나누면,
사용자는 “가볍게 쓸 수 있고”,
개발자는 “무거운 기능을 버리지 않으면서도 분리”할 수 있다.

---

## 5.2 저장 구조 단순화 제안

### 현재 문제
저장 계층이 많고 책임이 흐릴 수 있다.

### 제안

#### Option A: SQLite canonical + markdown export
- SQLite를 machine canonical로 유지
- markdown은 human-readable projection
- vector index는 disposable

#### Option B: SQLite raw + facts, markdown journal as user-facing memory ledger
- raw event와 derived facts는 SQLite
- 사람이 보는 memory book은 markdown
- dashboard/API는 둘 다 사용

둘 중 하나를 명확히 선택하는 게 중요하다.

개인적으로는 현재 프로젝트엔 **Option A 또는 B 둘 다 가능**하지만,
최소한 “LanceDB는 canonical이 아니다”는 확실히 해야 한다.

---

## 5.3 도메인 모델 정리 제안

현재의 핵심 도메인을 아래처럼 재정의하면 좋다.

### 1) RawEvent
- prompt
- assistant response
- tool output
- session marker
- import record

### 2) MemoryFact
검색/회상에 최적화된 작은 단위
- fact text
- source event ids
- scope (project/shared)
- tags
- confidence
- source type
- privacy level
- timestamps

### 3) MemorySummary
- turn summary
- session summary
- project summary
- continuity summary

### 4) MemoryRule / Preference
- recurring pattern
- user/project preference
- stable conventions

### 5) RetrievalTrace
- query
- selected facts
- why matched
- whether used/helpful

이렇게 나누면 현재 있는 여러 테이블/개념이 훨씬 읽기 쉬워진다.

---

## 5.4 검색 계층 고도화 제안

### 바로 적용할 것
- result type 분리: `fact`, `summary`, `tool evidence`, `session memory`
- retrieval reason 표준화
- `search -> expand -> source` 3단 UX
- recency와 semantic score 분리 표기

### 나중에 선택적으로 적용할 것
- entity-aware rerank
- code-anchor aware rerank
- task-aware continuity recall

즉, 먼저 **설명 가능한 retrieval product**를 만들고,
그 후에 더 복잡한 채널을 넣는 것이 좋다.

---

## 5.5 대시보드 축소/재구성 제안

대시보드는 기능이 많아질수록 개발비가 크게 든다.

추천 기본 탭:
1. Search
2. Sessions
3. Facts
4. Summaries
5. Sources / Citations
6. Health / Queue

추천 고급 탭(옵션):
- Helpfulness
- Shared memory
- Graph
- Experiments

즉, 제품의 중심을 “운영 콘솔”이 아니라 **memory inspectability**에 두는 것이 좋다.

---

# 6. 추천 기능 우선순위

## 가장 먼저 하면 좋은 것

### Priority 1. 도메인/저장 계층 재정의
- raw event vs derived fact 분리
- canonical source 명확화
- 문서 drift 해소

### Priority 2. Retrieval UX 명확화
- search / expand / source drill-down
- retrieval reasons 표준화
- helpfulness minimal feedback

### Priority 3. Core / Adapter / Extensions 분리
- `core`
- `adapters/claude`
- `extensions/*`
- `apps/dashboard`

이건 장기 유지보수성에 가장 큰 효과가 있다.

---

## 그다음 하면 좋은 것

### Priority 4. Lightweight code-aware memory
full graph 말고 먼저:
- file path links
- symbol links
- commit/diff links

### Priority 5. Minimal learning loop
- helpful / not helpful
- auto-promote / auto-demote candidates
- stale memory cleanup signals

### Priority 6. Shared memory를 extension으로 재배치
Mongo/shared를 기본 코어가 아니라 옵션 패키지로 다루기

---

# 7. 아주 구체적인 제안: “thin-core rewrite without rewrite”

전체 재작성 대신 내부 구조만 단계적으로 바꾸는 방법이다.

## Phase 1: 개념 정리
- README와 실제 구현을 맞춘다
- 현재 저장계층의 canonical/derived 관계를 문서화
- `MemoryService` 내부에서 raw/fact/summary 경계를 명확히 분리

## Phase 2: 패키지/폴더 재구성
예시:
- `src/core/engine/*`
- `src/core/model/*`
- `src/core/retrieval/*`
- `src/adapters/claude/*`
- `src/extensions/shared/*`
- `src/extensions/mcp/*`
- `src/apps/dashboard/*`

## Phase 3: 결과 타입 정리
- fact
- summary
- source
- tool evidence
- continuity item

## Phase 4: vector와 daemon을 가속 계층으로 격하
- 코어는 SQLite만으로도 최소 동작
- vector/daemon은 성능 향상 옵션

## Phase 5: shared/Mongo/MCP 실험 격리
- 기본 설치에서 빠질 수 있게
- 별도 feature flag / package boundary 제공

이렇게 하면 “지금 자산을 버리지 않고” 점진적으로 가벼워질 수 있다.

---

# 8. 최종 제안

## 결론 1
`claude-memory-layer`는 **memsearch처럼 더 얇고 선명한 코어**를 배워야 한다.

## 결론 2
동시에 `superlocalmemory`에서 **raw vs fact 분리, explainable retrieval, lightweight feedback loop** 같은 좋은 개념은 선택적으로 가져오면 된다.

## 결론 3
하지만 `superlocalmemory`식의 전체 플랫폼 범위를 그대로 따라가면,
현재 프로젝트는 빠르게 과체중이 될 가능성이 높다.

---

# 9. 추천하는 최종 방향 한 문장

> `claude-memory-layer`는 앞으로 **“Claude 특화 메모리 플랫폼”** 이 아니라, **“얇은 코어 메모리 엔진 + 강한 Claude 어댑터 + 선택형 확장 모듈”** 구조로 재정의되는 것이 가장 유리하다.

이 방향이면:
- 지금의 강점은 유지하고
- 유지보수성은 높이고
- 다른 플랫폼으로도 확장 가능하며
- 기능이 늘어도 코어는 작게 지킬 수 있다.

---

# 10. 추천 액션 아이템

## 바로 할 일
1. README/문서 drift 정리
2. canonical storage 정의 문서 추가
3. raw event / fact / summary 모델 재정의
4. search / expand / source UX 추가 또는 정리

## 다음 단계
5. `core / adapters / extensions / apps` 구조 분리
6. vector/daemon을 optional acceleration layer로 정리
7. lightweight code-aware memory anchor 추가
8. minimal helpfulness feedback loop 추가

## 보류 권장
9. full code graph platform
10. full learning platform
11. full mesh / multi-agent substrate
12. 너무 넓은 MCP surface 확장

---

# 11. 최종 판단

`claude-memory-layer`는 이미 꽤 좋은 위치에 있다.

- `memsearch`보다 richer하고,
- `superlocalmemory`보다 아직 더 집중된 상태이며,
- 적절히 정리만 잘하면 **가볍고 강하면서도 확장 가능한 memory architecture**로 발전할 수 있다.

핵심은 더 많은 기능 추가가 아니라,
**코어를 다시 가볍게 만드는 구조적 결단**이다.
