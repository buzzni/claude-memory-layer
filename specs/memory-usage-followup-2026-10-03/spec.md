# 로컬 메모리·교훈 활용 후속 개선

상태: Opus 5.5/high 사전·최종 리뷰 반영, 구현·검증 완료 · 기준: 7413fb4 / CML 2.4.7

## 목적과 근거

현재 머신의 최근 14일 읽기 전용 감사에서 메모리 수집과 교훈 본문 조회 후
관련 검증 명령을 실행한 사례를 확인했다. 그러나 SessionStart 목록 노출,
host 전달 확인, MCP 본문 조회가 다른 원장에 남고, 자동 메시지가 사용자
요청과 섞인다. 이번 변경은 수집량 확대보다 이 의미와 연결을 바로잡는다.

관측은 기본 프로젝트 저장소에 한정됐고 테스트 저장소·자동 메시지·수집
시각 기준 기록을 포함했다. 머신 합계는 실제 작업량이나 생산성 지표가 아니다.
민감한 원문·절대 경로·세션 ID를 spec에 복사하지 않는다.

핵심 관측:
- Desktop 교훈 선택 470건 중 468건은 SessionStart reference 목록 노출.
- Desktop MCP 교훈 조회 18건 중 found=true 15건, Web 24건 모두 found=true.
- Host 교훈 전달 확인은 Desktop 67건, Web 16건. 본문 조회와 동의어가 아니다.
- Desktop user_prompt 1,479건 중 task-notification 557건, 공통 교훈 제안
  wrapper 포함 309건. wrapper 안에 실제 요청이 있으므로 메시지 전체를 버리면 안 된다.
- Desktop 교훈 254개 중 이벤트 근거 참조 없는 항목 215개. 근거 없음과
  교훈이 잘못됨은 다르다. 자동 삭제·비활성화하지 않는다.
- 사전 감사의 MCP mem-lesson-list는 readonly_runtime 오류를 반환. 원인은 실행 중인
  서버까지 검증되지 않았다. 코드 개선과 설치본 반영을 구분한다.

## 범위와 비목표

기존 `audit` CLI, native hook/importer, lesson host contract, MCP handler를
확장한다. 신규 LLM 호출, 교훈 벡터 재설계, provider 연동, 자동 데이터 정리,
배포·전역 재설치·실제 사용자 DB 마이그레이션은 이번 개발에 포함하지 않는다.
수정되지 않은 기존 자료는 읽기 전용으로 해석하며 원본 기록을 삭제하지 않는다.
외부 Happy/Desktop의 provider 채택·작업 성공 연동은 계약 후속으로 문서화한다.

## R1. 공통 사용자 요청 분류 및 정규화 (P0)

순수 함수로 `user | task_notification | scaffold_only` 분류와
`requestText`, 제거한 scaffold 종류 enum을 반환한다.

- 알려진, 경계가 명확한 Saycode 교훈 제안 wrapper, title 지시문,
  주입된 교훈 목록만 제거한다. arbitrary XML/Markdown/영문 단락은 보존한다.
  교훈 목록은 알려진 전체 footer가 인용·fence 밖의 독립 문단일 때만 닫힌 것으로
  인정한다. 마지막 짧은 문장만 있거나 footer가 인용·코드 안에 있으면 보존한다.
- task-notification은 메시지 전체가 해당 envelope일 때 자동 메시지로 취급.
  뒤에 실제 요청이 붙으면 실제 요청을 보존한다.
- 인용·코드 예시로 주어진 wrapper는 제거하지 않는다. 4칸 공백 또는 탭으로
  들여쓴 Markdown 코드도 분류 전에 들여쓰기를 보존한다. 불완전하거나 모호한
  경계는 보수적으로 원문을 유지한다. 사용자가 쓴 실제 title 변경 요청도 보존한다.
  닫히지 않은 Markdown fence 뒤의 host suffix도 모호한 사용자 텍스트로 보존한다.
  후행 title variant당 한 번만 제거하며 사용자 copy를 반복해서 제거하지 않는다.
- 제안 token은 파서 출력·metadata·쿼리·로그에 남지 않는다. 기존 privacy
  필터는 정규화 이후 저장 경계에서 계속 적용한다.
- native UserPromptSubmit 검색·질의 재작성·adherence·저장 모두 동일한
  requestText를 사용한다. 자동 메시지에는 검색과 사용자 프롬프트 저장을 하지 않는다.
- Claude/Codex/Hermes importer도 같은 정책을 사용하되 raw source 파일은
  수정하지 않는다. 자동 메시지도 새 턴 경계를 열며 prompt는 저장하지 않는다.
  해당 응답에는 turnTrigger enum을 남겨 이전 실제 요청의 응답에 섞이지 않게 한다.
  자동 턴 뒤의 짧은 사용자 요청도 저장 임계값을 바꾸지 않고 사용자 턴을 연다.
  native hook도 새 turn state는 쓰되 자동 메시지로 adherence turnCount/lastPrompt를
  갱신하지 않는다. 자동 알림 본문은 새 user_prompt로 보관하지 않는다.
- normalizer → privacy 순서를 통일한다. importer는 과거 raw/privacy 적용 본문
  dedupe key를 확인해 구자료 재임포트 및 hook→import 중복을 차단한다.
  과거 본문 검사는 같은 세션의 user_prompt에 한정하며 assistant/tool 본문이
  일치한다는 이유로 실제 사용자 요청을 건너뛰지 않는다.
  SQLite 저장 단계의 새 dedupe key도 이벤트 유형을 포함한다. 기존 키는 같은
  유형일 때만 중복으로 인정하며, 구자료 재가져오기·머신 간 동기화에서도 두 키
  형식을 호환한다. 기존 행·키를 재작성하거나 schema migration을 추가하지 않는다.
  source timestamp/message identity가 있는 경우 활용하되 새 중복 쓰기를 만들지 않는다.
- Codex 기존 실제 요청의 trivial 필터 정책은 바꾸지 않는다. environment/AGENTS
  envelope의 새 분류는 범위 밖이며 classifier v1에서는 user로 표시될 수 있다.
- 새 저장 이벤트 metadata에 버전과 enum만 남긴다. 기존 이벤트는 감사에서
  분류할 수 있으나 재작성/backfill을 자동으로 수행하지 않는다.
- 기존 trivial prompt 임계값 변경은 비목표. wrapper 때문에 길어진 요청으로
  필터를 우회하거나 의미 없는 scaffold를 저장하는 동작만 바로잡는다.

## R2. 교훈 사용의 읽기 전용 감사 (P0)

기존 `audit --since --until --format json|markdown`에 저장소별
`promptQuality`, `lessonUsage`, `lessonQuality`를 추가한다. 기존 필드는 유지한다.
구간은 `[since, until)`이고 missing table/column은 unknown/unsupported로 표시한다.
prompt/lookup은 기존 audit과 같은 저장 시각(events.timestamp) 기준임을 출력한다.
source occurredAt과 수집 시각은 source clocks에서 분리하며 backlog로 해석하지 않는다.
감사 실행은 DB 생성·마이그레이션·navigation 쓰기·checkpoint를 하지 않는다.
예상 밖 계산 실패는 lessonAuditError=computation_failed로 표시하며, 미지원
schema와 구분하고 raw error text는 노출하지 않는다.

서로 다른 의미는 분리한다:
- typed retrieval item의 lesson selection: trace의 reference/evidence 모드를 분리.
  prompt lane의 실제 항목 injectionMode는 기록되어 있지 않으므로 unknown이며,
  trace evidence 모드를 교훈 본문 전달로 해석하지 않는다.
- lesson_host_traces selected/delivered/read: phase별 trace 수와 항목 수를 분리.
- MCP body lookups: tool_observation에서 정확한 toolName과 구조화된
  toolOutput의 found=true/false를 파싱한다. content의 도구명 언급은 조회가 아니다.
  정확한 도구 alias allowlist를 사용하고 double-encoded 실제 output을 지원한다.
  operation=mem-lesson-get인 완전한 JSON만 found를 판정한다.
  불완전·과대·truncation marker·알 수 없는 output은 unknown으로 남긴다.
  success=true만으로 found를 추정하지 않는다. Codex/Hermes 조회는 현재 native
  PostToolUse 관측 경로 밖이므로 unobserved이며 0%로 표시하지 않는다.
- host read, MCP lookup, navigation을 더해 단일 read 총계나 채택률을 만들지 않는다.
  중복 연결을 입증할 수 없는 자료는 provenance별 관측값을 병렬 제공한다.
- applied/task_success는 증거가 없는 한 unknown. 텍스트 유사도나 후속 Bash만으로
  교훈의 인과적 효과를 확정하지 않는다. access_count를 조회의 분모로 쓰지 않는다.
- promptQuality는 원래 user_prompt 수, 자동 envelope 수, scaffold 포함 수,
  정규화 후 실제 요청/공통 지시문만 남는 수를 별도로 제공한다. 겹치는 집계를 합하지 않는다.
- classifierVersion과 recognized-by-classifier 의미를 표시한다. 기존 wrapper
  token 포함 수는 집계만 제공하고 실제 token은 출력하지 않는다. token은 이번
  턴 후보 staging용 일시적 권한값으로 취급하며 기존 자료 정리는 opt-in 후속이다.
- 보고서에 원문·toolInput·toolOutput·교훈 본문·이름·절대 경로·사용자/세션 ID를
  포함하지 않는다. 알려진 enum, 집계, 프로젝트 hash만 출력한다.
- event 읽기는 페이지 단위로 순회하고 raw 내용 전체를 배열에 쌓지 않는다.
  지원하지 않는 JSON/구자료 때문에 저장소 전체 보고서를 실패시키지 않는다.

## R3. 기존 Host 전달 lineage 회수와 ack replay 수정 (P1)

- 새 schema column은 추가하지 않는다. delivered row와 같은 project/actor/request
  idempotency(operation=delivered)의 result_json.traceId가 selected trace ID다.
  감사는 이 관계와 전체 binding/lesson revision 일치를 검증해 exact로 연결한다.
  교훈 ID와 revision 배열은 같은 순서의 일대일 대응이어야 하며 각 ID는 유일하고
  revision은 양의 정수여야 한다. 두 빈 배열은 정상적인 항목 없는 결과로 인정한다.
  누락·외부 ID·중복된 교훈 ID는 exact 또는 legacy unique로 연결하지 않는다.
- 기존 v1 요청/응답을 바꾸지 않고 자료를 자동 backfill하지 않는다.
  ackDelivery는 현재 binding 확인 후 transaction 안에서 idempotent replay를
  먼저 확인한다. 이미 성공한 동일 요청은 revision 변경 뒤에도 원래 응답을 반환.
  최초 ack는 기존 project/actor/machine/session/generation/turn/revision fencing 유지.
- idempotency 근거가 없는 과거 자료의 전체 binding+turn+lesson revision이
  유일하게 일치하는 경우를 legacy unique로, 다중 후보를 ambiguous로 구별한다.
  불명확한 관계를 성공으로 처리하거나 requestId가 같아야 한다고 가정하지 않는다.
- linked delivered 수는 distinct selected trace 단위도 제공하며 반복 ack를
  중복 적용으로 해석하지 않는다. listTraces에 selectionTraceId를 additive 노출.

## R4. 조회 안정성과 교훈 품질 진단 (P1)

- mem-lesson-list를 기존 mem-lesson-get의 읽기 전용 snapshot 경로로 연결.
  등록된 asset의 권한·requester·프로젝트 경계를 보존하고 read 중 canonical
  테이블 초기화/수정 없이 기존 WAL 자료를 읽는다. missing store는 생성하지 않는다.
  asset table이 없는 구자료는 미등록 정책을 적용한다 (requester 필요,
  registered 허용 / strict 제외). 존재하는 table의 오류는 미등록으로 숨기지 않는다.
  임시 snapshot 경로 준비·생성 실패는 source_unreadable과 분리한다.
- 기존 get는 read-only snapshot에 navigation을 쓰려고 하지만 실패를 무시해
  실제 canonical navigation은 기록되지 않는다. MCP 조회는 tool observation으로
  측정하고 navigation coverage는 unsupported라고 명시한다. canonical telemetry
  쓰기를 복구하려고 read-only 계약을 약화하지 않는다. MCP 프로세스 재시작은 하지 않는다.
- snapshot helper는 APFS copy-on-write clone을 우선(COPYFILE_FICLONE, 실패 시 copy)
  사용한다. torn snapshot은 bounded retry와 안전한 typed 오류로 처리한다.
  resolveExistingStore의 검증 정책을 재사용/공유하되 probe 후 다시 snapshot을
  복제하는 이중 복사를 추가하지 않는다. 1GB 자동 성능 테스트와 새 hard latency
  SLA는 후속이며 이번에는 clone 경로·fallback·readonly fixture를 검증한다.
- lessonQuality에 총/활성/비활성 수, event/session 근거 존재 여부,
  validation/reconsiderWhen 충족 수와 최근 selected unique 수를 집계한다.
  activeBasis=recall_enabled이며 scope/permission/version 통과를 뜻하지 않는다.
  근거는 no refs / local refs found / refs unresolved here로 나누며 alias 누락을
  invalid lesson으로 처리하지 않는다. row project_hash가 store와 다른 경우 별도
  coverage로 제외/표시한다. runtime_version별 trace 수도 추가한다.
  오래됨·근거 부족만으로 교훈을 삭제하거나 잘못된 교훈으로 분류하지 않는다.
- prompt/MCP 본문 조회 안내는 stable lessonId를 우선하고 name은 호환 조회로 유지한다.
  예산 절약을 위한 기존 names-only SessionStart 목록은 유지한다.
  SessionStart의 전체 탐색 목록은 discovery 역할이며 실제 적용은 prompt/host의
  기존 relevance·permission·version gate를 사용한다. 무관 항목을 채우지 않는다.
- no-match·권한 거부·일반적 동사·disabled/version mismatch를 회상 실패율로 합치지 않는다.

## R5. 운영 진단과 적용 경계 (P1)

운영 문서에 안전한 순서를 제공한다: 설치 CLI 버전 확인 → 동일 프로젝트
stats/context 조회의 storage view 대조 → audit의 source clocks와 runtime versions
확인 → 필요할 경우 사용자가 장기 실행 MCP를 재시작 → 동일 read smoke 재실행.
기록 없는 기간은 활동 없음을 뜻할 수 있으며 backlog로 단정하지 않는다.
설치·재시작·refresh/import는 자동으로 실행하지 않는다.

## 수용 기준과 검증

1. wrapper+한국어 요청은 실제 요청으로 검색/저장되고 token·공통 지시문은 남지 않는다.
   wrapper only/자동 알림은 검색·저장에서 제외. 코드·인용·불완전 경계·혼합 요청 보존.
2. 세 importer의 실제 import fixture와 native hook fixture에서 정규화 일관성,
   privacy, turn/assistant buffering, force/skipExisting 기존 동작을 검증한다.
3. 감사 fixture에서 동일 ID의 event/lesson 구분, found false/invalid JSON,
   duplicated provenance, legacy schema, 구간 경계, 타 프로젝트 조회 제외,
   selected/reference와 body read 분리 및 applied unknown을 검증한다.
4. source DB·WAL·SHM와 파일 목록 snapshot 전후 동일. 보고서 생성이 미지원
   컬럼을 추가하지 않는다. 새 telemetry migration은 격리된 테스트 DB에서만 실행.
5. ack 기존 exact lineage 정확성, revision 변경 후 idempotent replay, cross-scope/revision/generation
   거부, legacy unique/ambiguous fallback 검증.
6. read-only canonical DB에서 MCP list/get, live WAL, strict permissions,
   unknown project, temp snapshot 경계, optional 컬럼이 없는 구자료의 호환 읽기,
   required 컬럼 미지원 typed schema_incompatible 검증.
7. 관련 테스트 → typecheck/lint → 전체 suite → build → architecture boundary.
   baseline 실패와 신규 회귀를 구분하고 필요한 수정 후 다시 검증한다.

## 비용·협업

Opus 5.5/high는 spec 리뷰와 최종 위험 리뷰에 사용한다. 구현 child는 해당
작업 단위만 전달하고 생략된 model/agent/effort는 임의 지정하지 않는다.
같은 worktree에 쓰는 child는 한 번에 한 명. 리뷰는 read-only.
child의 결과와 git diff를 부모가 확인하며 설치·publish는 하지 않는다.

## 최종 구현 경계

복제 snapshot은 SQLite 오류가 있는 경우 bounded retry하나 checkpoint 경합에서
유효하지만 오래된 자료가 나오는 경우까지 검출하지는 않는다. consistency와
latency SLA는 보장하지 않는다. 실제 host suffix의 알려지지 않은 변형은 제거하지
않으며 classifier v1의 한계로 남긴다. MCP schema description은 기존 byte-budget
계약을 유지하고, prompt-time lessonId 우선 안내를 그대로 사용한다.
