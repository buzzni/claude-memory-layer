# 구현 계획

상태: 구현 및 Opus 5.5/high 최종 리뷰 반영 완료 — 최종 검증 결과는 아래 기록

## 순서

1. 현재 코드 계약·baseline 확인, spec 초안 작성. 완료.
2. Claude / claude-opus-5-5 / high child에 spec·계획 read-only 리뷰 요청.
   반환된 피드백의 수용/기각 이유를 review.md에 기록하고 문서 업데이트.
3. T0 MCP list/get read-only snapshot 안정성·호환 schema 개선.
4. T1a pure normalizer/native hook → T1b importers/legacy dedupe 통합.
5. T2 읽기 전용 교훈 활용·품질·promptQuality audit 및 T3 기존 idempotency
   lineage 회수·ack replay 수정. 신규 schema migration은 제거했다.
6. 부모 통합 리뷰와 Opus read-only 최종 리뷰, 필요한 수정 및 전체 검증.
7. spec/context에 최종 구현·검증·외부 통합 경계를 기록하고 사용자에게 전달.

## 작업 단위

### T0 — 조회 안정성

- 기존 snapshot read-only helper 정책 재사용, clone/fallback 및 bounded retry.
- mem-lesson-list도 no-create/no-migrate, strict permission·WAL 유지.
- source 파일 snapshot 전후 불변 검증; double snapshot probe는 피한다.

### T1a/T1b — 사용자 요청과 자동 지시문 분리

- src/core에 작은 순수 classifier/normalizer와 unit tests.
- Claude native prompt hook와 Claude/Codex/Hermes importer에서 공유.
- 실제 요청을 query rewriting/adherence/persist에 동일하게 전달.
- 운영 prompt state/원본 데이터의 migration은 하지 않음.
- 자동 메시지는 새 턴으로 분리하되 adherence 상태는 보존, 응답에 turnTrigger.
- normalizer→privacy 통일, legacy raw dedupe 및 hook→import 중복 fixture.
- 검증: 토큰 없는 출력, 정상 코드·인용, 자동/혼합 envelope, wrapper+요청,
  importer fixtures, hook storage/retrieval tests.

### T2 — 감사와 읽기 안정성

- 새 core read-only aggregate helper를 기존 memory-audit-report snapshot에 연결.
- 기존 json/markdown 출력 유지 + 집계 의미·coverage 추가.
- legacy/missing columns/partial tool output, explicit bounds/privacy fixture.
- MCP mem-lesson-list가 get과 같은 readonly snapshot 계약 사용.
- lessonId 우선 조회 안내와 운영 진단 문서.
- 검증: audit readonly snapshots/WAL/schema, MCP list strict permissions,
  unsupported stores도 분모 보존.

### T3 — Host lineage 및 ack 호환성

- 기존 lesson_host_idempotency의 delivered result.traceId로 exact 관계 회수.
- ack transaction에서 replay를 revision 검증보다 먼저 처리.
- trace output additive selectionTraceId. 기존 host contract는 호환 유지.
- 감사 exact/legacy_unique/ambiguous/unlinked 집계, scope/revision fencing 유지.
- fixture에서 시간 구간이 다른 select→ack 관계도 올바르게 구별.

## 협업·검증

쓰기 child 한 명을 순차적으로 사용한다. root는 child가 쓰는 동안 read-only
검토·검증만 수행한다. child가 끝나면 happy agent wait --until turn-end 후
read로 실제 결과를 수집한다. 후속 작업은 prompt로 보낸다.

테스트는 격리된 임시 저장소를 사용. 실제 hooks install/uninstall, 사용자
메모리 reset/import/refresh, 공개 발행을 실행하지 않는다.
검증 산출물은 수행한 명령·통과/실패 수·잔여 위험을 포함한다.

## 기준 검증

- npm run typecheck: 통과.
- 관련 baseline: 2 files / 11 tests 통과.
- 전체 baseline: 246 files / 1,766 tests 통과 (31.65s).
- worktree 로컬 의존성만 준비했으며 사용자 캐시·전역 설정은 수정하지 않았다.

## 구현 결과

- T0: MCP list/get에 한 번의 snapshot·필수 schema 검사·최대 2회 시도 공유.
  missing store를 생성하지 않으며 WAL·strict permission·구자료 호환 회귀 통과.
- T1a/T1b: native hook와 세 importer의 공통 정규화, privacy, legacy dedupe.
  자동 턴의 응답과 이전 사용자 snippet/adherence를 분리했다. Hermes는
  privacy 후 길이를 제한하며, 자동 턴 뒤 짧은 사용자 입력도 새 사용자 턴을 연다.
- T2: promptQuality/lessonUsage/lessonQuality와 안전한 lessonAuditError 추가.
  exact tool aliases, 완전한 output, 시간·scope·활성 기준을 구분한다.
- T3: 기존 idempotency 원장의 exact lineage 회수와 revision 변경 뒤 ack replay.
  불완전한 ack·잘못된 JSON은 연결을 추정하지 않으며 새 migration은 없다.
- 구현은 동일한 writing child를 순차 재사용했다. Opus는 사전/최종 read-only
  리뷰에만 사용했고, 부모가 diff·반환 결과·격리된 CLI smoke를 확인했다.

## 잔여 운영 경계

실제 설치본 갱신, 장기 실행 MCP 재시작, 과거 원문/token 정리와 데이터
refresh/import는 실행하지 않았다. 복제 snapshot은 best effort이며 checkpoint와
경합할 때 유효하지만 오래된 view가 나올 수 있다. 대규모 latency SLA는 검증하지
않았다. Codex/Hermes MCP body lookup은 미관측이며 교훈 적용·작업 성공은 unknown이다.

## 최종 검증 — 2026-10-03

- `npm run verify`: 통과. typecheck 오류 0, lint 오류 0 / 기존 경고 45.
  전체 252 files / 1,804 tests 통과 (30.82s). 시작 기준보다 6 files / 38 tests 증가.
- `npm run build`: 통과. CLI/MCP/hooks/services/server 번들 생성.
- `npm run check:architecture`: 통과. 299 files 검사, 기존 baseline 4 entries 유지.
- `git diff --check`: 통과.
- 빌드된 CLI의 `audit --all-projects --since --until --format json|markdown`을
  임시 SQLite fixture에 실행: 새 집계·lessonAuditError=null 확인. 원본 파일 목록,
  크기, mtime, SHA-256 불변과 fixture token/요청/세션/절대 경로 미노출 확인.
  실제 홈 변수는 바꾸지 않고 자식 프로세스의 homedir 반환값만 격리했다.
- 관련 fixture는 정상/자동/혼합/불완전·fenced 요청, 모든 importer, legacy/hook
  중복, privacy 경계, host scope/generation/revision replay, malformed lineage,
  MCP readonly/WAL/권한/미지원 schema와 감사 실패 구분을 포함한다.

위 검증 당시 코드·문서는 미커밋 상태였다. 설치·배포·실제 MCP 재시작과
사용자 데이터 정리는 수행하지 않았다.

## PR 준비 재검증 — 2026-10-03

- 원격 main fetch 결과 기준 HEAD(7413fb4)와 동일. memory-usage-audit의 기존 PR 없음.
- 추가 검토에서 임시 snapshot 생성 실패 분류와 asset table 없는 old schema의
  registered/strict 정책 회귀를 재현·수정했다. 상세는 review.md.
- 런타임 host/감사 모듈 결합 및 중복 privacy·교훈 조회를 줄였다.
- 관련 7 files / 65 tests 통과. 이어 전체 `npm run verify`:
  252 files / 1,806 tests 통과 (32.77s), typecheck/lint 오류 0, 기존 경고 45.
- `npm run build`, `npm run check:architecture`, `git diff --check` 통과.
  architecture 300 files 검사, 기존 baseline 4 entries 유지.
- 커밋·push·PR로 리뷰 가능한 결과를 전달하며, merge나 npm publish는 이 작업의
  범위에 포함하지 않는다.
