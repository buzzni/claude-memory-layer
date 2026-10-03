# Opus 5.5/high 사전 피드백 반영

2026-10-03, Claude `claude-opus-5-5` / high. Read-only 검토 후 계획 업데이트.

## 수용한 변경

- B1: idempotency 원장에 과거 exact linkage가 이미 있음. 신규 DB column을
  제거하고 read-only 조인 활용. ack replay가 revision 변경 후 깨지는 문제 수정.
- B2/B3: 자동 턴 경계/응답 metadata 명시, native adherence 보존, normalizer→privacy
  순서 통일 및 legacy dedupe·반복 import·hook→import 검증.
- B4/B5: exact tool alias/operation, double-encoded output, truncation unknown,
  Codex/Hermes unobserved. get의 canonical navigation은 unsupported로 명시.
- C1/C2/C8: item injectionMode unknown, 저장 시각 기준을 명시, classifier v1
  인식 집계는 ground truth가 아님.
- C3/C4: project scope가 다른 row 분리, 근거 없음/로컬 확인/미해결 참조 분리.
- C5/C6: runtime version 집계 추가, names-only SessionStart 예산 계약 유지.
- C7/C9/C10: Codex trivial 정책 유지, environment/AGENTS 분류 후속. 기존 token은
  집계만 제공, cleanup은 opt-in 후속. native requestText 한 번 계산 및 저장면 검증.
- C11/C12: 구자료 optional schema 호환/required schema 안전한 오류, MCP read
  먼저 구현. baseline 전체 246 files / 1,766 tests 통과를 기록.
- O3/O4: bounded paging, exact selected trace별 dedup 집계.

## 조정·보류

- B6의 안전성·clone·bounded retry는 수용. resolveExistingStore를 그대로 호출한
  뒤 reader를 다시 열면 DB를 두 번 복제하므로 검증 정책을 공유하고 열린 snapshot을
  재사용한다. ≥1GB fixture latency SLA는 이번 기능의 요구로 채택하지 않는다.
  기존 snapshot 비용이 사라졌다고 주장하지 않으며 대규모 benchmark는 후속이다.
- 자동 알림 원문은 새 user_prompt로 저장하지 않음. 결과를 응답/도구 근거로
  관찰할 수는 있지만 알림 자체의 정리된 task_result 타입 도입은 후속이다.
- 실제 설치본 버전/프로세스 갱신·legacy token cleanup·외부 provider 채택 연동은
  별도 운영/통합 작업. 이번 변경에서 사용자 저장소나 설정을 변경하지 않는다.

## Opus 5.5/high 최종 코드 리뷰

확정된 blocking finding은 없었다. 부모 검토와 다음 보강을 구현·검증했다.

- 알려진 제목 지시문이라도 닫히지 않은 backtick/tilde fence 안에 있으면
  보존한다. 후행 지시문은 variant당 한 번만 제거한다. 사용자의 열린 fence 뒤에
  실제 host suffix가 붙는 모호한 경우도 보존한다는 계약을 명시했다.
- 자동 턴 뒤 trivial 사용자 입력은 저장 임계값을 유지하면서 사용자 턴 경계를
  연다. Claude/Hermes에서 자동 응답과 후속 사용자 답변이 섞이지 않는 fixture 통과.
- 예상 밖 감사 계산 실패는 lessonAuditError=computation_failed로 구분한다.
  raw error/path를 보고서에 넣지 않는다.
- SQLite 파일/WAL 복제는 best effort다. checkpoint 경합의 유효하지만 오래된
  snapshot은 검출되지 않을 수 있으며 운영 문서에 반복 read와 한계를 명시했다.

검토자가 가정한 `Read the output file to retrieve the result:` 알림 suffix는
최근 native Claude JSONL 30개에서 읽기 전용으로 확인했다. 알림 user message
146건 중 envelope-only 145건, 임의 후행 내용 1건, 해당 exact suffix 0건이었다.
이는 모든 host version의 포맷을 보장하지 않으므로 추측 기반 제거는 추가하지
않았다. 알 수 없는 후행 내용은 혼합 사용자 요청으로 보존한다.

부모 검토에서 MCP underscore alias와 SQL prefilter, 손상된 ack의 legacy fallback
금지, revision 없는 schema의 lineage unsupported, strict JSON, runtime semver,
Hermes privacy→bounds, 101번째 evidence ref까지의 확인을 추가 보강했다.

## PR 전 worktree 재검토 — 2026-10-03

사용자 요청에 따라 부모와 기존 Opus read-only reviewer가 다시 검토했다.
다음 두 회귀는 새 fixture가 수정 전 실패하고 수정 후 통과하는 것으로 재현했다.

- 임시 디렉터리에 쓸 수 없으면 원본 DB의 source_unreadable로 오진했다.
  snapshot의 임시 경로 준비·생성 실패를 SQLITE_SNAPSHOT_UNAVAILABLE로 구분해
  MCP의 snapshot_unavailable / snapshot_runtime으로 전달한다. 원본 읽기
  권한 실패의 분류와 안전한 snapshot 위치 검사는 유지한다.
- memory_assets가 없는 오래된 저장소는 registered/strict 모드에서 오류가 났다.
  없는 테이블만 미등록으로 해석한다. requester는 계속 필요하고 registered는
  미등록 정책대로 허용, strict는 제외한다. 존재하는 테이블의 오류는 숨기지
  않으며 읽기에서 table 생성·migration 없이 원본 snapshot 불변을 확인했다.

복잡성도 줄였다. 전달 결과 파서를 작은 core/lesson-host-lineage.ts로 분리해
런타임 host가 감사·prompt 모듈에 의존하지 않게 했다. ack의 binding 검사를
읽기 쉽게 펼치고 같은 교훈을 두 번 조회하지 않는다. 사용하지 않는 prompt
storage transform 인자와 중복 privacy 호출을 제거했다.

운영 문서에서 retrieval-trace writer 버전을 실행 중인 MCP 버전으로 해석할
수 없다는 점을 바로잡았다. 전체 verify는 252 files / 1,806 tests 통과,
typecheck/lint 오류 0 (기존 경고 45), build와 architecture/diff 검사 통과.
