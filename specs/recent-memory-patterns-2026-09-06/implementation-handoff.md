# 전체 구현 에이전트 인계

사용자 최신 요청: Claude Opus 5 / high 한 명이 R1~R5 전체를 구현하고, 부모 모델이 최종 코드 리뷰와 수정을 수행한다. 기존 R1~R3 작업이 종료된 후 현재 변경 위에서 이어서 구현한다. 병렬 작성자나 추가 에이전트를 만들지 않는다.

## 전체 범위

- spec.md의 R1~R5를 실제 호출 경로, SQLite 호환성, CLI/UI, 테스트까지 연결한다.
- 기존 분석 JSON과 원본 spec을 보존한다. 구현 상태와 검증 증거는 별도 문서에 기록한다.
- 기존 수정본을 검토하고 이어간다. 테스트를 통과하기 위해 기존 검증을 약화하지 않는다.
- install/uninstall, 사용자 메모리 초기화/GC/재임포트, 외부 배포는 하지 않는다. 테스트는 격리된 저장소를 사용한다.
- 종료 시 R1~R5별 구현 파일, 실제 연결 경로, 테스트 결과, 남은 실험 조건을 명시한다. 토큰/precision/지연 목표는 실측 없이 달성했다고 주장하지 않는다.

## 부모의 중간 검토 항목

아래는 작업 중인 변경을 읽고 찾은 검증 후보다. 최종 코드에 남아 있는지 먼저 확인하고, 남아 있다면 회귀 테스트와 함께 수정한다.

1. `memoryRefKey`에 projectId가 빠지면 서로 다른 프로젝트의 같은 kind/id가 합쳐질 수 있다. typed trace와 navigation/helpfulness까지 동일한 scope-aware identity가 필요하다.
2. usefulness 관측의 기존 PK가 `(trace_id,event_id,observation_kind,evaluator_version)`이면 같은 trace의 event/lesson 동일 ID가 덮어써진다. additive 호환을 유지하면서 typed key 충돌을 해결한다.
3. `recordDeliveryOutcome.refs`가 kind를 무시하고 event_id만 필터링하거나 v2 관측 전체 trace를 갱신하면 다른 항목의 전달 상태가 바뀐다.
4. 전달 재평가 창은 실제 delivered_at과 평가 cutoff를 사용해야 한다. 현재 시각/주입 생성 시각 혼용, 늦게 들어온 response, navigation 창 미제한 여부를 확인한다.
5. read-only backfill dry-run이 신규 typed 테이블이 없는 구스키마에서 바로 0을 반환하면 진단이 무의미하다. unresolved를 자동 deleted로 단정하지 않는다.
6. `core:` 접두어만으로 존재를 확인하지 않고 resolved 처리하는지, 프로젝트 권한 필터가 일관적인지 검증한다.
7. stdout reporter는 응답이 실제 출력된 뒤 evidence를 기록해야 한다. 타임아웃/출력 오류에서 잘못 emitted로 바뀌거나 watchdog 때문에 관측이 사라지는 경로를 검증한다.
8. 읽기 전용 보고서가 initialize/migration, snapshot cleanup, metadata write를 유발하는지 검사한다. JSON/Markdown 원문·절대 사용자 경로 유출도 검사한다.
9. requestId 중복 처리가 SELECT 후 INSERT만 사용하면 다른 프로세스의 동시 쓰기에서 중복될 수 있다. scope-aware unique 계약 및 트랜잭션이 필요하며, 중복 갱신 시 legacy 배열과 typed 선택 항목이 서로 다른 최신 상태를 나타내지 않아야 한다.
10. reference navigation이 선택 trace만 검사하면 formatted/failed 전달에 열람을 귀속할 수 있다. 실제 전달 증거와 시간 경계를 확인하고, legacy ID 충돌에서는 타입을 추측하지 않는다.
11. 전달 증거가 formatted/failed인데 후속 답변의 overlap만으로 grounded 및 task success가 생기는지 확인한다. 전달이 관측되지 않은 자료로 채택을 확정하지 않으며, 새 테스트가 이 잘못된 기존 구현을 기대값으로 고정하지 않도록 검토한다.

## R4/R5 기존 확장 지점

- `src/core/operations/lesson-candidate-service.ts`: 기존 candidate/extractor/cache, 근거 이벤트와 privacy/recovery 판정이 있다. 후보 시스템을 중복 생성하기 전에 재사용한다.
- `src/services/read-only-diagnostics-service.ts`: 모델/worker 없이 읽는 기존 합성 서비스와 missing store 처리가 있다.
- `src/apps/cli/project-scope-audit.ts`: 기존 scope 진단 및 프로젝트별 집계와 통합한다.
- `src/core/registry/project-path.ts`: git common-dir/marker 수렴을 재사용한다.
- `src/core/engine/memory-ingest-service.ts`, Codex/Hermes importers: occurredAt/ingestedAt 명시와 실제 저장 호출을 연결한다.

## 필수 검증

typecheck, lint, 영향 테스트, 전체 테스트, build, architecture 검사 등 저장소 필수 검증을 실행하고 실패를 해결한다. 환경/기존 실패는 신규 회귀와 구별해 근거를 보고한다. 최종 부모 리뷰가 이어지므로 commit/publish하지 않는다.
