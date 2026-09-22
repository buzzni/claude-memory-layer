# 최종 구현 결과

2026-09-06 · [원본 spec](./spec.md) · [부모 코드 리뷰](./review-results.md)

PR 생성 이후의 추가 수정과 최신 검증은 [7개 라운드 셀프 리뷰 결과](./autopilot-review-results.md)에 기록한다. 아래 수치는 최초 PR 생성 시점의 검증이다.

사용자가 지정한 `claude / claude-opus-5 / high` 작성 에이전트의 구현 결과를 수집한 후, 부모 대화 모델이 직접 코드를 검토하고 회귀 테스트로 결함을 재현·수정했다. 이 문서는 에이전트의 초기 자기 보고를 최종 검증 결과로 갱신한다.

## 구현 범위

| 계약 | 최종 동작 |
|---|---|
| R1 | `(projectId, kind, id)` JSON tuple 키로 event/lesson/core 등의 정체성을 보존한다. 조회 배열과 typed 원장을 하나의 트랜잭션으로 기록한다. 기존 원장 읽기와 명시적 backfill CLI를 유지한다. |
| R2 | 조회 결과의 unknown·정책 제외·후보 없음·예외를 구분한다. requestId 중복을 처리하고, 구 runtime_error를 legacy_unclassified로 표시한다. 관측되지 않은 클라이언트 coverage는 unknown이다. |
| R3 | 선택과 전달 증거를 구분한다. v3 평가를 v2의 가정 기반 전달과 분리하고, 프로젝트·종류별 참조 탐색을 연결한다. 평가 cutoff와 30분 창을 적용하며 bounded 재평가 CLI를 제공한다. |
| R4 | sourceRefs·적용 조건·근거·재검토 조건을 갖춘 shadow 후보를 만든다. 민감정보, 미해결 실패, 일회성 서사, 문서 복사 후보를 차단한다. 원본을 보존하고 자동 승격하지 않는다. 저장/원본 시각과 출처별 지연을 보고한다. |
| R5 | read-only audit CLI가 저장소별 schema·alias·24/48시간·선택 종류·평가 분모·출처/클라이언트를 보고한다. 분류는 명시값 또는 unknown이며 경로 힌트는 `test-looking`/`other`처럼 익명 범주만 사용한다. 실패한 저장소도 coverage에 남긴다. |

핵심 연결 지점은 `sqlite-event-store.ts`, retrieval orchestrator, Claude/Codex 훅, MCP handlers, stats API, 대시보드와 CLI다. 신규 모듈은 `memory-ref.ts`, `retrieval-trace-ledger.ts`, `retrieval-navigation.ts`, `retrieval-rollout.ts`, `ingest-source-clocks.ts`, `derived-evidence-candidates.ts`, `memory-audit-report.ts`다.

## 사용과 롤백

```sh
node dist/cli/index.js audit --since 2026-09-03T15:25:00Z --until 2026-09-05T15:25:00Z --all-projects --read-only --format json
node dist/cli/index.js audit --all-projects --classify aaaaaaaa=production bbbbbbbb=test --format markdown
node dist/cli/index.js retrieval reevaluate
node dist/cli/index.js repair backfill-trace-items
```

분류 예시의 해시는 실제 저장소 해시로 바꾼다. 재평가와 backfill은 기본 dry-run이며 쓰기에는 명시적 `--apply`가 필요하다. 재평가는 수동 실행 가능한 bounded 작업으로, 자동 스케줄러를 설치하지 않는다.

독립 환경변수 `CML_TYPED_TRACE_WRITE`, `CML_USEFULNESS_V3_WRITE`, `CML_USEFULNESS_V3_UI`는 기본 활성화이며 `0`, `false`, `off`로 해당 신규 원장 쓰기·평가 쓰기·UI 표시를 끈다. 기존 테이블과 reader는 유지한다. 쓰기를 재활성화해도 과거 관측을 자동 재분류하지 않는다. R4 후보는 shadow 상태이며 회상에 자동 투입되지 않는다.

## 검증

- `npx vitest run --maxWorkers=4`: **240개 파일, 1,622개 테스트 통과**.
- `npm run typecheck`, `npm run build`, `npm run check:architecture`: 통과.
- lint: 오류 0개, 기존 `no-explicit-any` 경고 45개.
- `npm run check:public-output-privacy`: 10개 공개 산출물 검사, 발견 0개.
- 격리 HOME과 읽기 전용 원본 DB 백업을 사용한 Claude `session-start` → `user-prompt-submit` 실제 훅 프로브: JSON envelope·추가 context·전달 출력 모두 통과.
- 실제 기본 저장소 187개를 새 CLI로 읽기 전용 감사: 읽기 실패·미지원 스키마 0개.
- 고정 표본에서 이벤트 **6,704**, 조회 **957**, 선택 **2,424 = event 1,959 + lesson 465**, 활성 저장소 **26개**를 정확히 재현했다.

재현 산출물: [새 CLI 감사 JSON](../../docs/reports/memory-patterns-2026-09-06.implemented-audit.json). 원본 [분석 집계](../../docs/reports/memory-patterns-2026-09-06.aggregate.json)와 시간 경계가 같다. 해당 표본에는 신규 v3 관측이 없어 v3 평가 분모는 0이며, 구 v2 기록은 legacy 분모에만 포함된다.

## 실측 한계

토큰 중앙값 20% 감소, precision 감소 2%p 이내, warm p95 증가 10% 이내는 아직 입증하지 않았다. 프로젝트별 20개 이상의 검증된 질의와 baseline/후보 비교가 필요하며 현재 실험 상태는 `insufficient_sample`이다. 이 결과를 근거로 후보를 자동 승격하면 안 된다.

기존 importer는 독립적인 durable cursor를 제공하지 않는다. 보고서의 최신 원본 시각은 관측된 source clock이며 importer cursor나 backlog로 해석하지 않는다. cursor 계측 상태는 unknown이다. 출력 emitted 역시 소비자가 실제 읽었다는 acknowledged 증거가 아니다.

사용자 메모리 쓰기·초기화·삭제·병합·재임포트·설치 설정 변경은 수행하지 않았다. 실제 훅 프로브는 격리된 임시 HOME과 원본 DB의 SQLite 백업에서 실행했다.
