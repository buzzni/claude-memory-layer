# Implementation Context

## Baseline findings

- 선택 프로젝트 store: 840 events, 184 vectors, 3 stored sessions
- 검색 35회 중 selection이 있는 query 31회
- helpful evaluation 76건 중 helpful 9건(11.8%)
- 평균 content grounding 12%
- global store는 4 events지만 UI는 전체 프로젝트 합계처럼 표시
- Useful Recall KPI current/previous/daily가 동일 all-time 값을 공유
- global scope에서 결과 평가가 없어도 복합 점수 75 / good이 표시될 수 있음
- 프로젝트 디렉터리 81개 중 backup/unknown/zero-byte 항목이 선택기에 섞임
- 390px viewport에서 document 폭이 679px로 확장됨

## Implementation status

완료.

### Delivered

- helpfulness 통계의 `[since, until)` 조회와 KPI current/previous 분리, 인덱스 범위 기반 단일 daily 집계
- outcome evidence가 없을 때 `score.value: null`, `status: insufficient-data`
- 평가가 없는 Useful Recall KPI/일별 추세를 unavailable로 처리하고 임계치 경고에서 제외
- Global Store / Stored Sessions 의미 정정
- valid hash + non-empty SQLite 프로젝트 필터
- `.aplus/worktrees` 별칭에서 main checkout 대표 경로 추론
- 600px 이하 header/search/usefulness 세로 레이아웃 및 overflow 방지

### Verification results

- targeted Vitest: 6 files, 38 tests passed
- full Vitest: 172 files, 1,091 tests passed
- TypeScript typecheck: passed
- ESLint: 0 errors, 기존 경고 44개
- build: passed
- dashboard smoke: passed
- live project API: 71개 모두 valid hash + non-empty DB, 현재 저장소는 `claude-memory-layer`로 정규화
- desktop browser: Global Store, Stored Sessions, insufficient-data 표시 확인
- 390px rendering context: viewport 390px, document 384px, horizontal overflow 없음; header/usefulness column 확인
- browser console: desktop/mobile 모두 log error 없음

## Deferred follow-ups

- 실제 all-project aggregate view가 필요하면 별도 집계 API/semantic definition으로 설계한다.
- L2~L4, lessons/actions/graph/perspective가 0인 원인은 projector 활성화/운영 흐름 관점의 별도 작업으로 다룬다.
- 장기 실행 MCP의 project hash/version parity는 전역 프로세스 재시작 권한과 함께 별도 운영 작업으로 다룬다.
