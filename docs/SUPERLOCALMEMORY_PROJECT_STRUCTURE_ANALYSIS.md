<!-- Imported from `/Users/namsangboy/workspace/superlocalmemory/docs/PROJECT_STRUCTURE_ANALYSIS.md` as a local comparison snapshot for claude-memory-layer refactoring. -->

# superlocalmemory 프로젝트 구조 분석

## 한 줄 요약
`superlocalmemory`는 단순 메모리 라이브러리가 아니라, **SQLite 기반 로컬 메모리 엔진 위에 MCP, CLI, 훅, 대시보드, 코드 그래프, 학습/적응 계층, 멀티에이전트 mesh까지 얹은 거대한 로컬 메모리 플랫폼**이다.

---

## 1. 프로젝트 목적

이 프로젝트의 목적은 매우 넓다.

핵심적으로는:
- 세션 간 persistent memory 제공
- IDE/에이전트 환경에 자동 주입/회상 제공
- 로컬 우선 프라이버시 보장
- MCP 도구 제공
- 대시보드/운영 화면 제공
- 코드 그래프와 메모리를 연결
- 학습/피드백/패턴 마이닝을 통해 점점 더 똑똑한 memory system 구축
- 멀티에이전트 coordination까지 확장

즉, 이 프로젝트는 “메모리 기능”을 넘어서 **agent memory operating system** 에 가깝다.

---

## 2. 기술 스택

### 언어 / 배포
- Python 중심
- PyPI + npm 양쪽 배포

### 서버 / 인터페이스
- FastAPI
- uvicorn
- websockets
- static dashboard UI

### 저장 / 검색 / 그래프 / ML
- SQLite/WAL
- FTS5
- sentence-transformers
- torch
- scikit-learn
- lightgbm
- networkx
- rustworkx
- tree-sitter
- watchdog

즉, 전형적인 앱/도구 수준을 넘어서,
**애플리케이션 + 검색엔진 + 분석엔진 + 연구 레이어**가 같이 있는 스택이다.

---

## 3. 엔트리 포인트

### CLI
- `slm` → `superlocalmemory.cli.main:main`

### MCP 서버
- `slm mcp`
- stdio 기반 MCP surface 제공

### 대시보드/서버
- unified daemon 및 UI server 경로 존재

### hooks
- 저지연 hook fast-path 존재

즉, 사용자 접점이 매우 많다.
- CLI
- MCP
- hooks
- dashboard
- daemon
- IDE integrations

---

## 4. 전체 구조 해석

이 저장소는 사실상 **대형 모듈러 모놀리스**다.

중심은 `MemoryEngine` 이며,
그 주변에 여러 서브시스템이 붙는다.

대략 구조:
1. ingestion / encoding
2. storage / schema / migration
3. retrieval / ranking / rerank
4. learning / adaptation / consolidation
5. hooks / IDE automation
6. MCP / CLI / dashboard
7. code graph bridge
8. mesh / multi-agent coordination
9. parameterization / soft prompt injection
10. evolution / skill learning

즉, 아주 많은 기능이 하나의 플랫폼으로 엮여 있다.

---

## 5. 디렉터리 구조 분석

### `src/superlocalmemory/core/`
플랫폼 핵심 엔진과 wiring 계층이다.

- `engine.py`: top-level orchestrator
- `engine_wiring.py`: 서브시스템 연결
- worker/consolidation/config 계층

### `storage/`
DB, schema, migration 레이어다.

- primary SQLite schema
- versioned schema files
- migration scripts
- code graph 전용 schema

### `encoding/`
raw memory를 구조화된 fact/entity/scene/observation으로 변환하는 계층이다.

예:
- fact extraction
- entity resolution
- temporal parsing
- graph building
- entropy gating

### `retrieval/`
가장 중요한 검색 계층 중 하나다.

포함 기능:
- semantic
- BM25
- entity graph
- temporal
- spreading activation
- hopfield
- fusion / rerank / diversity logic

### `learning/`
이 프로젝트를 특별하게 만드는 큰 축이다.

포함:
- reward / feedback
- outcomes
- pattern mining
- ranker retraining
- bandits
- consolidation
- behavioral analysis
- rollback/shadow test

즉, 단순 회상이 아니라 **memory quality를 스스로 개선하려는 시스템**이다.

### `code_graph/`
코드베이스 구조를 memory와 연결하는 계층이다.

포함:
- parser/extractors (Python/TypeScript)
- incremental updates
- graph storage/search
- communities / blast radius / flows
- event bridge

### `hooks/`
세션 시작, recall gate, tool use checkpoint, observation posting 등 agent workflow에 직접 개입한다.

### `mcp/`
FastMCP 기반 tool/resource 등록 레이어다.

### `server/`
대시보드/API/daemon 계층이다.

### `mesh/`
멀티에이전트 브로커/메시징/락/공유상태를 담당한다.

### `parameterization/`
soft prompt, prompt injection, PII filter 등 “메모리를 파라미터화된 컨텍스트”로 바꾸는 계층이다.

### `evolution/`
스킬 진화 및 학습된 패턴을 다루는 계층이다.

---

## 6. 데이터 모델

### 6.1 SQLite primary store
핵심 저장소는 SQLite/WAL이다.

장점:
- 로컬 배포 쉬움
- 단일 파일 관리 가능
- 멀티프로세스 접근에 대한 운영 노하우가 축적됨

### 6.2 Raw memory + atomic facts 이중 구조
중요한 특징:
- `memories` = raw records
- `atomic_facts` = 실제 검색 단위

이건 꽤 강력한 설계다.
즉, 원문과 검색용 정규화 fact를 분리한다.

### 6.3 매우 풍부한 스키마
스키마에는 다음이 포함된다.
- memories
- atomic facts
- entities / aliases / profiles
- graph edges
- temporal events
- scenes
- trust / provenance / feedback
- behavioral / action outcomes
- compliance / config
- soft prompt 관련 테이블
- mesh 관련 테이블
- code graph 관련 테이블

즉, 단순 memory DB가 아니라 **knowledge + behavior + learning + infra metadata DB**다.

### 6.4 FTS + embeddings + lifecycle
사실 검색 가능한 fact unit에 다음이 다 붙는다.
- content
- entity list
- temporal field
- confidence
- importance
- evidence
- embedding
- lifecycle state
- emotion

이건 매우 풍부하지만, 동시에 유지비가 크다.

---

## 7. ingestion / encoding 구조

문서상 11단계 pipeline이 설명되어 있고,
코드도 실제로 꽤 세분화돼 있다.

예:
- metadata
- entity extraction
- fact extraction
- emotion detection
- belief extraction
- entity resolution
- graph wiring
- foresight tagging
- observation building
- entropy gating
- storage

이 구조는 “대화/로그를 그냥 chunk 저장하는 것”보다 훨씬 깊다.
대신 계산비용과 복잡성이 높다.

---

## 8. retrieval 구조

문서보다 구현이 더 발전해 있다.

실제 검색 채널은 대체로 다음과 같다.
- semantic
- BM25
- entity graph
- temporal
- spreading activation
- hopfield

그리고 위 결과를 fusion/rerank 한다.

장점:
- 다양한 종류의 기억을 잘 찾을 가능성
- 단순 검색보다 더 풍부한 연상 가능

단점:
- 설명/디버깅이 어려워짐
- 성능 튜닝 포인트가 많아짐
- 문서 drift가 생기기 쉬움

---

## 9. 학습/적응 계층

이 프로젝트의 가장 큰 차별점 중 하나다.

단순히 메모리를 저장하고 꺼내는 것이 아니라,
- 어떤 기억이 유용했는지
- 어떤 retrieval 채널이 잘 먹혔는지
- 어떤 패턴이 반복되는지
- ranker를 어떻게 개선할지
- forgetting/consolidation을 어떻게 적용할지

를 계속 학습하려고 한다.

이건 매우 야심찬 구조다.
잘 되면 강력하지만,
잘 관리하지 않으면 가장 무거운 부채가 되기 쉽다.

---

## 10. code graph 통합

`superlocalmemory`는 code graph를 memory와 직접 연결하려고 한다.

예상되는 가치:
- 대화 메모리와 코드 구조 연결
- 특정 함수/모듈/파일과 관련된 기억 회상
- blast radius / dependency 기반 recall

이 방향은 매우 좋다.
다만 일부 구현은 여전히 진행 중인 흔적이 보여,
완전한 안정 제품보다는 “활발히 발전 중인 연구-제품 중간 단계”로 보인다.

---

## 11. hooks / IDE automation

이 프로젝트는 단순 assistive memory가 아니라,
**에이전트 workflow를 강하게 통제하는 계층**도 갖고 있다.

예:
- session init 강제
- recall gate
- tool 사용 전후 흐름 제어
- observation posting
- learning/evolution 트리거

장점:
- memory system을 실제 워크플로우에 강하게 결합 가능

단점:
- 사용자가 “무겁다/간섭이 많다”고 느낄 수 있음
- 통합 대상이 많을수록 유지비 증가

---

## 12. MCP / CLI / Dashboard 구조

### MCP
도구 수와 범위가 크다.
core memory뿐 아니라 learning/code graph/mesh/evolution까지 노출한다.

### CLI
기능 폭이 매우 넓다.
단순 remember/recall 수준이 아니라 setup, doctor, health, migrate, serve, dashboard, warmup 등 운영형 CLI다.

### Dashboard
지식 그래프, 메모리, recall lab, clusters, patterns, timeline, learning, agents, trust, behavioral, compliance, math health, settings 등 탭이 많다.

즉, 대시보드는 단순 viewer가 아니라 **운영 콘솔**에 가깝다.

---

## 13. 테스트 / 품질 신호

장점:
- 테스트 범위가 매우 넓다
- cross-platform CI
- CLI/MCP/hooks/retrieval/learning/mesh 등 다수 계층 테스트 존재

의미:
- 큰 시스템치고는 품질 방어에 많은 노력을 들이고 있다

하지만 해석상:
- 시스템이 워낙 커서 테스트가 많아도 전체 복잡도를 상쇄하긴 어렵다
- 테스트 유지비도 상당할 것

---

## 14. 아키텍처 강점

### 강점 1: 제품 완성도 범위가 넓다
memory, MCP, dashboard, hooks, learning, code graph, mesh까지 모두 갖춘다.

### 강점 2: 로컬 우선 철학
SQLite/WAL 중심이라 배포성과 프라이버시 측면에서 강하다.

### 강점 3: retrieval sophistication
다채널 retrieval과 ranking/fusion은 강력한 경쟁력이다.

### 강점 4: 사실상 platform-level ambition
단순 라이브러리가 아니라 큰 비전을 담고 있다.

### 강점 5: 코드 그래프/학습/행동 분석까지 결합
이건 다른 memory 프로젝트에서 쉽게 보기 어려운 깊이다.

---

## 15. 약점 / 리스크

### 약점 1: 지나치게 넓은 범위
memory 시스템 하나에 너무 많은 제품/연구 축이 들어와 있다.

### 약점 2: 문서와 구현 drift
tool count, retrieval channel count, 일부 구조 설명이 최신 구현과 어긋난다.

### 약점 3: 모놀리스 비대화
겉보기엔 모듈화되어 있지만, 실제론 하나의 커다란 플랫폼으로 결합돼 있다.

### 약점 4: migration / legacy / compatibility 비용
versioned schema와 과거 호환 레이어가 계속 쌓인다.

### 약점 5: 일부 계층은 여전히 evolving
code graph 일부, unified daemon vs legacy UI server 공존 등 전환기 흔적이 보인다.

### 약점 6: 사용자 경험이 무거울 수 있음
모든 기능이 다 좋더라도, 실제 사용자 입장에서는 너무 많은 개념과 운영 surface가 부담일 수 있다.

---

## 16. 구조적 해석

`superlocalmemory`는 매우 인상적이지만,
핵심적으로는 다음 질문을 던지게 만든다.

> “이 프로젝트는 memory engine인가, agent operating platform인가?”

현재 답은 거의 후자에 가깝다.

즉,
- 아주 강력하지만
- 매우 무겁고
- 유지보수와 제품 집중력 측면에선 큰 discipline이 필요한 구조다.

---

## 17. 결론

`superlocalmemory`는 **가볍고 단순한 메모리 라이브러리**가 아니다.
그보다 훨씬 크고 야심차며,
**로컬 AI memory OS**에 가까운 구조다.

배울 점은 많다.
특히:
- SQLite 기반 단일 로컬 엔진
- atomic facts 모델
- retrieval 채널 다변화
- learning/feedback 통합
- code graph bridge
- 운영 도구/대시보드의 풍부함

하지만 동시에,
이 구조 전체를 그대로 가져오면 작은 프로젝트는 거의 반드시 과체중이 된다.

즉, 이 저장소는 “그대로 모방할 대상”이라기보다,
**어떤 아이디어를 선택적으로 흡수할지 신중히 골라야 하는 참조 아키텍처**라고 보는 것이 맞다.
