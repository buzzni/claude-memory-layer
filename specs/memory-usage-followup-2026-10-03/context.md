# 구현 맥락

- 사용자 요청: 최근 활용 감사 제안에 대한 spec/계획 → Claude Opus 5.5/high
  피드백 → 계획 반영 → 비용 효율적인 sub agent 구현.
- 기준 checkout: 7413fb4, package 2.4.7, 시작 시 git diff 없음.
- 기존 계측: typed retrieval items, usefulness v3, lesson_host_traces,
  navigation, tool_observation이 존재하지만 다른 provenance의 관측이다.
- 시작 시 MCP get만 snapshot read-only를 사용했다. 이번 구현에서는 list/get
  모두 한 번의 validated snapshot reader를 공유한다.
- 원본 로컬 분석은 읽기 전용. 새 spec의 지표는 인과적 생산성으로 해석하지 않음.
- 관련 문서: ../recent-memory-patterns-2026-09-06/, ../lesson-recall-hooks/,
  ../memory-utilization-improvements/. 기존 구현을 다시 만들지 않는다.
- 구현 경로: src/core/prompt-normalizer.ts, src/core/lesson-usage-audit.ts,
  src/core/registry/existing-store.ts, native hooks/importers와 lesson-host-service.
- 새 DB migration, 사용자 저장소 변경, install/uninstall, publish는 없다.
  최종 검증과 수용/보류 결과는 plan.md와 review.md에 기록한다.
