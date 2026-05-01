<!-- Imported from `/Users/namsangboy/workspace/memsearch/docs/PROJECT_STRUCTURE_ANALYSIS.md` as a local comparison snapshot for claude-memory-layer refactoring. -->

# memsearch 프로젝트 구조 분석

## 한 줄 요약
`memsearch`는 **markdown을 source of truth로 삼고, Milvus를 파생 인덱스로 사용하는 가볍고 실용적인 semantic memory/search 엔진**이다. 코어 라이브러리는 비교적 작고 명확하며, 복잡성의 대부분은 각 에이전트/플랫폼용 플러그인 통합 계층에 있다.

---

## 1. 프로젝트 목적

이 프로젝트의 핵심 목적은 다음이다.

- markdown 기반 메모리/지식 문서를 semantic search 가능하게 인덱싱
- 여러 AI coding agent/도구(Claude Code, Codex, OpenClaw, OpenCode)에서 공통 memory layer로 활용
- 기억의 “원본”은 사람이 읽고 편집 가능한 markdown으로 유지
- 벡터 DB는 언제든 다시 만들 수 있는 파생 인덱스로 취급

즉, 이 프로젝트는 **vector DB 중심 시스템**이 아니라,
**markdown 중심 메모리 시스템**에 더 가깝다.

---

## 2. 기술 스택

### 언어 / 런타임
- Python 3.10+
- 일부 플러그인은 shell / TypeScript / Node 조합

### 핵심 라이브러리
- CLI: `click`
- 벡터 저장소: `pymilvus` / Milvus Lite
- 파일 감시: `watchdog`
- 임베딩 제공자: OpenAI / Google / Voyage / Jina / Mistral / Ollama / local / ONNX
- 문서/툴링: mkdocs, pytest, ruff, uv

### 주요 엔트리 포인트
- Python API: `src/memsearch/core.py`
- CLI: `src/memsearch/cli.py`
- 모듈 실행: `src/memsearch/__main__.py`
- 플랫폼 플러그인: `plugins/*`

---

## 3. 디렉터리 구조 분석

### `src/memsearch/`
코어 라이브러리 영역이다.

주요 파일:
- `core.py`: 공개 API `MemSearch`
- `store.py`: Milvus wrapper, hybrid retrieval
- `chunker.py`: markdown chunking, chunk ID 생성
- `scanner.py`: markdown 파일 스캔
- `watcher.py`: 파일 변경 감지 및 debounce
- `config.py`: layered TOML config
- `compact.py`: LLM 기반 요약/압축
- `reranker.py`: optional cross-encoder rerank
- `embeddings/*`: provider abstraction

이 구조는 매우 명확하다.
핵심 기능이 파일 단위로 잘 나뉘어 있고, 각 모듈의 책임이 비교적 분명하다.

### `plugins/`
플랫폼별 통합 레이어다.

구성:
- `claude-code/`
- `codex/`
- `openclaw/`
- `opencode/`
- `_shared/`

즉, 메모리 엔진은 공통이고,
각 에이전트별 capture/retrieval/injection 방식을 다르게 붙이는 구조다.

### `tests/`
chunking, config, store, CLI, transcript 파싱 등 코어 품질을 검증한다.

### `docs/`
문서 품질이 높은 편이다.
아키텍처 설명, 플랫폼별 설치, 설정, FAQ, CLI 등이 비교적 잘 정리되어 있다.

---

## 4. 데이터 모델

### 4.1 Source of truth = Markdown
이 프로젝트에서 가장 중요한 원칙이다.

메모리는 결국 markdown 파일이다.
예:
- `.memsearch/memory/YYYY-MM-DD.md`

장점:
- 사람이 직접 읽고 수정 가능
- git 관리 가능
- vendor lock-in이 약함
- 인덱스가 깨져도 원본은 남음

### 4.2 Vector index = Milvus
Milvus는 파생 검색 인덱스다.

대표 스키마 필드:
- `chunk_hash` (PK)
- `embedding`
- `sparse_vector`
- `content`
- `source`
- `heading`
- `heading_level`
- `start_line`
- `end_line`

즉,
**문서 provenance를 꽤 잘 보존하는 chunk index** 구조다.

### 4.3 Chunk ID 전략
`chunker.py`의 composite ID 설계가 핵심이다.

대략 구성:
- source
- line range
- content hash
- model

이 방식의 장점:
- 자연스러운 dedupe
- 변경 감지 쉬움
- 파일 일부만 바뀌어도 필요한 chunk만 재색인 가능

---

## 5. 인덱싱 파이프라인

코어 흐름은 매우 직관적이다.

### 단계
1. `scanner.py`가 markdown 파일 탐색
2. `chunker.py`가 heading 기반 분할
3. 필요 시 oversized section을 추가 분할
4. content 정리 후 embedding 생성
5. `store.py`가 Milvus에 upsert
6. 기존 chunk와 비교해서 stale chunk 삭제

특징:
- heading 중심 chunking
- preamble chunk 지원
- line overlap 지원
- HTML comment 제거 후 embedding
- changed chunk만 재처리

즉, 단순하지만 실전적인 indexing pipeline이다.

---

## 6. 검색 구조

### hybrid retrieval
이 프로젝트의 핵심 강점이다.

- dense vector search
- BM25 sparse search
- RRF(Reciprocal Rank Fusion)

즉, vector-only가 아니라 lexical 검색을 기본 결합한다.
이건 실제 회상 정확도에서 꽤 중요하다.

### progressive disclosure
- L1: search
- L2: expand (원문 markdown section 복원)
- L3: transcript drill-down (플랫폼별)

특히 Claude Code plugin은 이 구조를 잘 활용한다.

### optional reranker
추가적으로 cross-encoder reranker도 붙일 수 있다.
하지만 기본은 비교적 가볍게 유지되어 있다.

---

## 7. 플랫폼 플러그인 구조

`memsearch`의 진짜 복잡성은 여기 있다.
코어보다 플러그인 계층이 훨씬 운영적으로 까다롭다.

### Claude Code 플러그인
구성 요소:
- hooks
- shared shell runtime (`common.sh`)
- transcript parser
- `memory-recall` skill

역할:
- SessionStart 시 최근 메모리 주입
- Stop 시 마지막 턴 요약/기록
- Skill을 통한 forked memory recall

이건 단순 자동 검색보다 더 세련된 구조다.
메인 컨텍스트를 더럽히지 않고 recall을 subagent skill로 위임한다.

### Codex 플러그인
Claude 구조와 유사하지만,
Codex lifecycle 제약(SessionEnd 부재 등) 때문에 프로세스 정리 로직이 더 복잡하다.

### OpenClaw 플러그인
TypeScript 기반 plugin으로 붙어 있으며,
메모리 검색/원문 조회/트랜스크립트 조회 도구를 제공한다.

### OpenCode 플러그인
가장 무거운 편이다.
배경 Python daemon이 SQLite를 polling하며 새 턴을 요약/기록한다.

---

## 8. Watch / Sync 구조

`watcher.py`는 `watchdog` 기반의 debounce watcher다.

하지만 플러그인 레벨에서는 백엔드 종류에 따라 전략이 달라진다.

- Milvus server/remote: 장기 watch 가능
- Milvus Lite: file lock 문제 때문에 일회성 index 위주 fallback

즉, 저장소 기술 선택이 integration 전략에 직접 영향을 준다.

---

## 9. 설정 구조

`config.py`는 layered configuration 구조를 가진다.

우선순위:
1. defaults
2. `~/.memsearch/config.toml`
3. 프로젝트 로컬 `.memsearch.toml`
4. CLI flags

장점:
- 사용성과 운영 flexibility가 좋음
- 전역/로컬 설정 분리가 자연스러움

또한 secret을 `env:VAR_NAME` 으로 간접 참조할 수 있어 실전성이 높다.

---

## 10. 테스트 / 품질 평가

이 저장소는 코어 라이브러리 품질 신호가 좋다.

강점:
- chunker / config / store / scanner / transcript 등 핵심 경로 테스트 존재
- CI, lint, format 정리되어 있음
- 코어가 작아서 테스트 범위를 잡기 쉬움

한계:
- 플랫폼 integration 전체를 완전히 일관되게 검증하기는 어렵다
- 일부 경로는 외부 API/환경 의존이 있다

즉,
- **core는 비교적 단단함**
- **plugin edge는 환경 의존성이 큼**

---

## 11. 아키텍처 강점

### 강점 1: source of truth가 명확하다
markdown이 원본이다.
이건 설명 가능성, 복구성, 이식성 면에서 매우 큰 장점이다.

### 강점 2: 코어가 작고 선명하다
scanner → chunker → embedder → store 라는 파이프라인이 아주 명료하다.

### 강점 3: hybrid retrieval 기본 제공
실전 회상 품질을 높이는 중요한 선택이다.

### 강점 4: 플러그인 분리 구조가 좋다
코어 메모리 엔진과 각 에이전트 통합 레이어가 비교적 깔끔하게 분리돼 있다.

### 강점 5: progressive disclosure 철학
search → expand → transcript drill-down은 메모리 시스템 UX 측면에서 매우 좋다.

---

## 12. 약점 / 리스크

### 약점 1: Milvus 의존성
문서 원본은 markdown이지만, 실제 semantic search 운영은 Milvus 특성에 많이 의존한다.

### 약점 2: 플랫폼별 유지보수 비용
Claude/Codex/OpenClaw/OpenCode 각각 lifecycle과 transcript format이 다르므로 plugin maintenance cost가 커진다.

### 약점 3: shell hook brittleness
shell script 기반 훅은 OS/환경 차이, PATH, 프로세스 정리 등에서 취약할 수 있다.

### 약점 4: Lite 모드 동시성 제약
Milvus Lite file lock 문제로 이상적인 watch 구조를 항상 쓰기 어렵다.

### 약점 5: 메타데이터 모델은 상대적으로 얇다
현재는 markdown chunk 중심 구조라,
고급 엔티티 그래프, task graph, helpfulness 학습 같은 계층은 상대적으로 약하다.

---

## 13. 구조적 해석

`memsearch`는 크게 두 부분으로 나뉜다.

1. **아주 잘 정리된 코어 라이브러리**
2. **상대적으로 복잡한 플랫폼별 통합 계층**

즉,
“엔진은 가볍고 선명한데, 실제 제품화 complexity는 integration에 있다.”

이 점이 매우 중요하다.

---

## 14. 결론

`memsearch`는 무거운 메모리 플랫폼이 아니라,
**좋은 철학을 가진 가벼운 semantic memory engine** 이다.

핵심적으로 배울 점은 다음이다.
- 원본을 markdown에 두는 것
- 코어를 작게 유지하는 것
- retrieval을 hybrid로 설계하는 것
- 플랫폼 통합을 core 밖으로 밀어내는 것
- progressive disclosure로 UX를 설계하는 것

즉, 이 프로젝트는 “엄청 많은 기능”보다,
**작지만 강한 코어와 좋은 메모리 UX 패턴**이 매력인 구조다.
