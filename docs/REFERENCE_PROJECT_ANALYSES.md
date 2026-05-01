# Reference Project Analyses for claude-memory-layer

이 문서는 `claude-memory-layer` thin-core refactor를 위해 작성/수집한 비교 분석 문서의 인덱스다.

## Target project

- [`PROJECT_STRUCTURE_ANALYSIS.md`](./PROJECT_STRUCTURE_ANALYSIS.md) — `claude-memory-layer` 현재 구조 분석
- [`TARGET_ARCHITECTURE_AND_FOLDER_STRUCTURE.md`](./TARGET_ARCHITECTURE_AND_FOLDER_STRUCTURE.md) — 목표 thin-core 폴더/계층 구조
- [`REFACTORING_PLAN_THIN_CORE.md`](./REFACTORING_PLAN_THIN_CORE.md) — 단계적 리팩터링 계획
- [`REFACTORING_MILESTONES_AND_ISSUES.md`](./REFACTORING_MILESTONES_AND_ISSUES.md) — milestone / issue 단위 작업 분해

## Reference project snapshots

- [`MEMSEARCH_PROJECT_STRUCTURE_ANALYSIS.md`](./MEMSEARCH_PROJECT_STRUCTURE_ANALYSIS.md) — Markdown-first + rebuildable Milvus index + skill/subagent recall 패턴
- [`SUPERLOCALMEMORY_PROJECT_STRUCTURE_ANALYSIS.md`](./SUPERLOCALMEMORY_PROJECT_STRUCTURE_ANALYSIS.md) — SQLite/FTS/fact/graph/learning까지 확장된 local memory OS 패턴

## Comparative synthesis

- [`ARCHITECTURE_COMPARISON_AND_RECOMMENDATIONS.md`](./ARCHITECTURE_COMPARISON_AND_RECOMMENDATIONS.md) — 세 프로젝트 비교와 `claude-memory-layer` 적용 권고

## 현재 refactor 방향 요약

`claude-memory-layer`는 `memsearch`의 단순한 source-of-truth/derived-index discipline과 `superlocalmemory`의 raw/fact/summary 분리 아이디어를 참고하되, dashboard/MCP/analytics/semantic daemon 같은 무거운 기능은 extension layer로 밀어내고 `MemoryService`는 점진적으로 얇은 facade로 축소한다.

다음 코드 작업의 핵심 slice는 retrieval coordination을 `MemoryService`에서 `RetrievalOrchestrator`로 분리하는 것이다.
