# Thin Core Refactor Context

> **Version**: 1.0.0
> **Created**: 2026-04-30

## 1. 배경

`claude-memory-layer`는 본래 Claude Code용 메모리 플러그인/레이어로 출발했지만, 현재는 다음을 모두 품고 있다.

- hook-based memory capture
- SQLite primary event storage
- vector indexing and retrieval
- markdown mirror
- local dashboard and REST API
- shared memory concepts
- optional Mongo sync
- continuity / working set / consolidated memories
- partial MCP surface

이 자체는 강점이다. 하지만 시간이 지나며 **코어 엔진과 확장 기능의 경계가 흐려지고 있다.**

---

## 2. 현재 구조의 핵심 특징

### 2.1 강점

1. **Claude lifecycle에 깊게 붙어 있음**
   - SessionStart / UserPromptSubmit / PostToolUse / Stop / SessionEnd를 통한 풍부한 capture 가능

2. **실전적인 retrieval**
   - vector + keyword + fallback chain + progressive retrieval + semantic daemon

3. **프로젝트 격리 설계**
   - project hash 기반 local storage isolation

4. **운영 관찰성**
   - dashboard, health, retrieval traces, helpfulness signals

### 2.2 약점

1. **`MemoryService` 비대화**
   - orchestration을 넘어 multi-subsystem god service에 가까워짐

2. **source of truth ambiguity 위험**
   - SQLite / LanceDB / markdown / shared / Mongo sync의 관계가 신규 독자에게 즉시 명확하지 않음

3. **문서 drift**
   - docs와 실제 코드가 일부 어긋남

4. **확장 기능의 코어 침투**
   - shared / continuity / analytics / vector concerns가 코어 경계 안에 많이 들어와 있음

---

## 3. 외부 레퍼런스에서 얻은 시사점

## 3.1 memsearch에서 얻은 시사점

`memsearch`의 가장 큰 장점은 **코어가 작고 선명하다**는 점이다.

배울 점:
1. **source of truth가 분명함**
   - markdown canonical, vector index derived

2. **plugin/adaptation 분리**
   - core library와 platform integration이 비교적 분리됨

3. **progressive disclosure UX**
   - search → expand → transcript drill-down

4. **incremental / deterministic indexing 관점**
   - stable chunk IDs

해석:
- `claude-memory-layer`는 memsearch처럼 단순해질 필요는 없지만,
- 최소한 **코어를 다시 설명 가능한 단위로 줄이는 discipline**은 배워야 한다.

## 3.2 superlocalmemory에서 얻은 시사점

`superlocalmemory`는 엄청 강력하지만 매우 큰 플랫폼이다.

가져올 만한 개념:
1. **raw memory vs atomic facts 분리**
2. **SQLite 중심 로컬 엔진 철학**
3. **검색 결과 explainability**
4. **lightweight feedback loop**

가져오지 말아야 할 것:
1. full platform sprawl
2. 너무 넓은 MCP/mesh/systems surface
3. 한 repo에 너무 많은 제품 축을 동시에 키우는 방식

해석:
- `claude-memory-layer`는 superlocalmemory처럼 모든 방향으로 커지기보다,
- 거기서 **좋은 모델링 개념만 선택적으로 흡수**해야 한다.

---

## 4. 왜 thin-core 방향인가

thin-core 방향은 단순히 “코드를 예쁘게 나누자”는 얘기가 아니다.

이 방향이 필요한 이유는 다음과 같다.

### 4.1 유지보수 속도 회복
기능이 많을수록, 새로운 기능 추가보다 “어디에 넣어야 하는지” 결정 비용이 커진다.
경계를 다시 세우지 않으면 개발 속도가 급격히 느려진다.

### 4.2 오류 격리
vector, hooks, shared memory, dashboard, MCP 문제가 모두 core 문제처럼 보이면 디버깅이 어려워진다.

### 4.3 테스트 구조 단순화
core / adapter / extension / app이 분리되면,
각 계층 테스트 목적이 분명해진다.

### 4.4 제품 집중력 유지
현재 프로젝트의 가장 큰 강점은 “Claude 특화 memory experience”다.
이를 유지하려면 오히려 코어를 가볍게 만들어 adapter 경쟁력을 살려야 한다.

---

## 5. 새 구조의 개념적 역할

### Core
이 시스템이 **반드시** 해야 하는 일만 맡는다.

- raw events 저장
- facts/summaries derivation
- retrieval
- source tracing
- registry
- journal projection

### Adapter (Claude)
Claude Code라는 외부 시스템과 대화하는 법을 안다.

- hook payload
- transcript parsing
- tool capture policy
- additionalContext formatting

### Extensions
있으면 좋은 기능들.

- vector acceleration
- analytics
- shared memory
- Mongo sync
- MCP
- continuity systems

### Apps
사용자-facing entrypoints.

- CLI
- server
- dashboard

---

## 6. 핵심 도메인 재정의 이유

### 6.1 RawEvent
현재 시스템은 대화/툴/세션 마커가 모두 비슷한 흐름으로 다뤄지지만, conceptual model은 충분히 분명하지 않다.

RawEvent를 분리하면:
- ingest가 단순해지고
- 원본 보존이 쉬워지고
- source tracing이 쉬워진다.

### 6.2 MemoryFact
검색 시스템이 진짜 필요로 하는 것은 항상 전체 transcript가 아니다.
작고 검색 가능한 fact unit이 더 실용적이다.

분리 효과:
- retrieval 품질 향상
- future reranking 확장 쉬움
- code-aware anchor 연결 쉬움

### 6.3 MemorySummary
session/project continuity는 중요하지만 raw event와 같은 층에 두면 혼란스럽다.
요약을 별도 층으로 두면:
- low-token retrieval
- dashboard readability
- export/journal readability
가 좋아진다.

### 6.4 MemoryRule
반복되는 선호/관례는 단순 fact가 아니다.
별도 개념으로 두는 편이 장기적으로 낫다.

---

## 7. 저장 계층 역할 정리 배경

현재는 “실제로 뭐가 원본이고 뭐가 파생인지”를 코드를 다 읽어야 이해된다.
이건 좋지 않다.

권장 해석:
- **SQLite** = authoritative store
- **Markdown journal** = 사람이 읽는 canonical projection
- **LanceDB** = disposable acceleration layer
- **shared/Mongo** = replication/extension

이 source-of-truth 계약과 현재 노출된 memory family 목록은
[`docs/architecture/memory-layer-manifest.md`](../../docs/architecture/memory-layer-manifest.md)에 정리한다. Thin-core 작업은 이 manifest를 기준으로 MCP tool이 어떤 layer를 query/mutate하는지 드러내야 한다.

이 정리가 있으면:
- 운영 판단이 쉬워지고
- 장애 복구가 쉬워지고
- 문서가 정직해진다.

---

## 8. retrieval UX를 왜 제품화해야 하나

현재 retrieval 능력 자체는 이미 꽤 좋다.
문제는 그것이 사용자/개발자에게 **명확한 mental model**로 전달되지 않는다는 점이다.

memsearch의 시사점:
- search
- expand
- transcript/source

이 3단 구조는 매우 이해하기 쉽다.

`claude-memory-layer`도 이를 도입하면:
- CLI가 더 명확해지고
- API가 더 깔끔해지고
- dashboard도 더 설명 가능해진다.

---

## 9. 코드 레벨 이행 전략 배경

완전 재작성은 위험하다.
이 프로젝트는 이미 훅/CLI/server/dashboard가 연결되어 있어 regression 위험이 크다.

따라서 다음 전략이 적합하다.

### Strangler migration
1. 새 경계 먼저 만든다
2. 새 타입 먼저 도입한다
3. 기존 facade는 유지한다
4. 내부 구현만 조금씩 새 서비스로 대체한다
5. 마지막에 legacy wrapper를 줄인다

이 전략의 장점:
- 작은 커밋 가능
- revert 쉬움
- 기능 중단 최소화

---

## 10. 성공 시 기대 상태

리팩터링이 성공하면 다음이 가능해야 한다.

1. 신규 개발자가 구조를 빠르게 설명할 수 있다.
2. vector index가 없어도 core memory는 쓸 수 있다.
3. Claude hooks는 강력하지만 core와 느슨하게 결합된다.
4. shared/MCP/continuity를 끄거나 발전시켜도 core에 미치는 영향이 작다.
5. 향후 code-aware memory anchor나 lightweight graph를 안전하게 넣을 수 있다.

---

## 11. 최종 맥락 요약

이번 리팩터링은 기능 축소 프로젝트가 아니다.

정확히는:
- **코어를 다시 작게 정의하고**
- **Claude 특화 강점은 더 분명하게 살리고**
- **무거운 기능은 올바른 곳으로 이동시키는 프로젝트**다.

즉, 이 작업은 구조 미화가 아니라,
`claude-memory-layer`를 앞으로도 계속 빠르게 발전시킬 수 있게 만드는 **장기 유지보수 투자**다.
