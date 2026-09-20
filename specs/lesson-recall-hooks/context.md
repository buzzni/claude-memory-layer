# Lesson Recall Hooks Context

> **Status**: 완료 — PR #87 머지, v2.4.0 발행·전역 설치 반영 (2026-09-05)
> **Created**: 2026-09-05
> **Last Updated**: 2026-09-21

## 1. 배경 — 어떻게 발견됐나

Desktop 저장소 세션에서 교훈을 저장한 직후 `mem-context-pack` 으로 회수를 시험했더니 방금 저장한
교훈이 안 나왔다. 질의를 전혀 다른 것으로 바꿔도 **같은 3건이 같은 순서로** 나와 최신순 고정임을
확인했고, 이어서 훅 코드·원장(`memory_helpfulness`, `retrieval_traces`)·시뮬레이션으로 정량화했다
(수치는 spec §1.1). 핵심 사실: **교훈 주입은 원장에 거의 남지 않아, "잘 활용되는지"를 지금은 알 수 없다.**

## 2. 결정 로그 (최신이 위)

- [2026-09-05] SessionStart 인덱스는 CML 훅에 둔다 / 이유: `~/.claude/settings.json` 의 5개 훅을 CML 이
  전부 소유하고 있어 init-project 셸 훅에서 넣으면 같은 절이 두 번 들어간다.
- [2026-09-05] 인덱스 항목에 lessonId 를 넣지 않고 `name` 으로 단건 조회 / 이유: 예산의 22% 절약,
  `UNIQUE(project_hash, name)` 이 있어 안전.
- [2026-09-05] 교훈 임베딩은 비목표 / 이유: 어휘 스캔 전체 151건이 ms 단위이고 p90 0.98. 필요가 증명된 뒤.
- [2026-09-05] 슬롯 예약은 1건·minScore 이상·비어 있을 때만 / 이유: 이벤트 근거를 교훈이 밀어내면
  안 된다는 기존 정책 주석("a reviewed runbook must not outrank exact evidence")과 충돌하지 않게.

## 3. 시도했으나 실패한 접근

- 설치된 `user-prompt-submit.js` 에 가짜 stdin 을 넣는 단독 프로브 → **빈 봉투만 반환.** 원인: 훅은
  `session-registry.json` 의 세션→프로젝트 매핑으로 스토어를 찾는데, session-start 를 거치지 않은
  가짜 session_id 는 매핑이 없다. 검증은 `CLAUDE_MEMORY_EVAL_MODE=true` 로 session-start → user-prompt-submit
  을 **같은 session_id 로 연쇄 실행**해야 한다.
- 스크래치패드 경로에서 `npx tsx` 로 CML 소스를 import → `better-sqlite3` 해석 실패. 저장소 안에서 실행할 것.

## 4. 발견된 문제 (범위 밖)

- CLI `lesson list --json` 은 `count: 100` 인데 배열은 25건 — `sanitizeOperationOutput` 이 모든 배열을 25로 자른다.
- `retrieval_traces.candidate_details_json` 이 비어 있는 행이 많아 후보 점수 사후 분석이 불가하다.

## 5. 구현 결과 (2026-09-05)

| 항목 | 결과 |
|------|------|
| R1 SessionStart 인덱스 | `formatLessonIndexContext` — 실기 프로브에서 151건 중 **14건이 2,267자**에 주입, 꼬리에 "14 of 151" |
| R2 전체 스캔 | `LESSON_SCAN_LIMIT = 500` (저장소 상한) |
| R3 슬롯 예약 | `reserveLessonSlot` — 변이 3종(minScore 게이트·중복 가드·최약체 교체) 모두 red |
| R4 `mem-lesson-get` | id 또는 name, 타 프로젝트 행 차단, enforced 모드 권한 검사, 스키마 베이스라인 갱신(44→45) |
| R5 context-pack | `rankCuratedLessons` — 변이 2종 red |
| R6 참조 카드 | fetch 안내 → `mem-lesson-get` |

실기 검증(임시 HOME 에 DB `.backup` 복사, `CLAUDE_MEMORY_EVAL_MODE=true`, session-start → user-prompt-submit
같은 session_id 연쇄): 인덱스 주입 확인, 교훈과 거의 같은 문장을 넣은 프롬프트에서 **해당 교훈(806a9068)이
Memory evidence 에 `[lesson]` 로 등장.** 이전에는 같은 절차로 빈 봉투(원장 기준 4,767건 중 5건).

### 결정: `[event:<id>]` 라벨은 교훈에도 그대로 둔다
`formatMemoryContext` 는 교훈에도 `[event:<lessonId>]` 를 붙인다. 바꾸려 했으나 기존 테스트
("marks each memory with its event id for the evaluation harness")가 그 정규식을 평가 하네스 계약으로
고정하고 있어 유지. 모델이 이 id 로 `mem-details` 를 부르면 실패하지만, 안내 문구가 fetch 가 아니라
📎 인용을 요구하므로 실사용 영향은 작다. `[lesson:<id>]` 로 바꾸려면 하네스 정규식도 함께 바꿔야 한다 — 후속.

### 변이 검증에서 드러난 중복 1건
`formatLessonIndexContext` 의 `budgetChars <= 0 || lessons.length === 0` 조기 반환은 루프의 break 와
`items.length === 0` 반환이 이미 보장하는 동작이라 제거했다(변이 M3 가 red 가 되지 않아 드러남).

## 6. 배포 기록과 다음 단계

- 2026-09-05 PR #87 머지 → `chore(release): v2.4.0` → 태그 푸시. 첫 발행은 `npm audit --omit=dev` 에서
  실패(v2.3.5 이후 공개된 fast-uri·qs advisory, 의존성 변경은 없었음) → `npm audit fix` 로 lock 만 갱신
  (`22c4955`) → 미발행 태그 재지정 → 발행 성공. 전역 설치 2.3.5 → 2.4.0, 설치본으로 실기 프로브 확인.
- 함정: `npm audit fix --omit=dev` 는 node_modules 에서 devDependencies 를 지운다(tsc·vitest 사라짐).
  audit fix 는 omit 없이 실행하고, 검사만 `npm audit --omit=dev` 로 할 것.
- MCP 서버 프로세스는 세션 시작 시 로드되므로 이미 열려 있던 세션에는 `mem-lesson-get` 이 없다.

1. ~~발행·업그레이드~~ 완료.
2. 배포 뒤 init-project `session_start.sh` 의 안내 문구("mem-context-pack / mem-lesson-list 로 회수할 수
   있습니다")를 "인덱스는 위에 주입됨, 본문은 mem-lesson-get" 으로 갱신(별도 저장소, 서브모듈 bump 필요).
3. 활용 측정: `retrieval_traces.strategy='session-start-lessons'` 와 `memory_helpfulness.event_id IN
   memory_lessons` 로 주입·인용 비율을 본다. 지금까지는 이 숫자가 0 에 가까웠다.
4. 후속 후보: 예산 초과 시 통합 압박(hermes "consolidate now"), `[lesson:]` 라벨 + 하네스 정규식.

## 7. 2026-09-20 후속 회수 수정 (로컬 미배포)

Desktop `specs/lesson-learning-reliability` 후속 구현 요청으로 context-pack을 개선했다. 위 v2.4.0 배포 기록은 과거 기준선이며 아래 변경은 별도 `lesson-search-regression` branch의 로컬 수정이다.

- 질의가 있으면 관련 교훈만 반환하며 무관한 항목으로 남은 슬롯을 채우지 않는다. 질의가 생략되면 기존 탐색 목록을 유지한다. handler의 내부 기본 검색어를 교훈 질의로 잘못 전달하는 회귀도 실제 MCP 호출 테스트로 수정했다.
- context-pack은 SQLite snapshot에서 500건씩 페이지를 읽어 전체 eligible catalog를 평가하고 상위 3건만 유지한다. 실제 DB에 501건을 넣어 낮은 confidence의 마지막 관련 교훈 회수와 무관 질의 미주입을 확인했다. native UserPromptSubmit의 500건 상한은 아직 별도 후속이다.
- 한국어 조사 정규화에 `로` 등 표현을 추가하고 두 글자 어근을 보존했다. 형태소 분석이 아닌 휴리스틱이므로 의미상 동의어 전체를 해결했다거나 오탐이 없다고 해석하지 않는다.
- context-pack의 본문 조회 안내를 `mem-lesson-get` + lessonId로 통일했다. reference 모드 본문 비노출 테스트도 추가했다. native prompt의 event/lesson 참조 혼용과 실제 전달 ack는 아직 미변경이다.
- 주 에이전트 리뷰에서 queryless 호출 회귀, 실제 DB와 무관한 >500 배열 테스트의 한계, 잘못된 injectionMode fixture와 과도한 정규화 주석을 발견해 보완했다.
- 검증: 관련 95 tests, 전체 232 files / 1,565 tests, typecheck, build, architecture boundary 통과. lint 0 errors / 기존 45 warnings. 실제 사용자 DB·설치 artifact·hooks 설정은 바꾸지 않았다.

다음 단계는 native prompt 전체 범위·고정 평가셋·전달 예산/권한/ack 검증이다. 신규 후보 queue/API/비용 작업은 Desktop plan의 T4 계약 검토와 별개 승인 경계이며 이 로컬 패치로 완료 처리하지 않는다.

## 8. 2026-09-20 authenticated host contract (local, not integrated)

- `specs/lesson-recall-hooks/host-contract.md` fixes the v1 callable package
  contract at `dist/services/lesson-host-service.js`. CML verifies an opaque
  host binding and neither mints identity nor exposes an unauthenticated REST
  route. Happy/Desktop must supply the verifier and gateway/budget execution.
- `memory_lessons` now has additive `revision` and `recall_enabled`; automatic
  injection selection excludes disabled lessons in legacy and registered modes
  while preserving existing asset lifecycle checks. The shared injection query
  reads all 500-row pages, so native prompt/session-start callers no longer
  silently omit a 501st eligible lesson.
- Persistent candidate and id-only lifecycle trace tables support
  pending/reviewed/accepted/rejected/expired, SHA-256 payload CAS, source
  project validation, UI snapshots, and selected/delivered/read separation.
  Candidate approval is an authenticated transaction; an existing lesson name
  returns merge-required rather than being overwritten.
- Verified locally: targeted host/native tests, full CML test suite, typecheck,
  lint (0 errors, pre-existing warnings), build, and architecture boundary.
  Actual Happy binding, provider acceptance, gateway budget reservation,
  runtime A→B smoke, and the fixed recall-quality evaluation remain unverified.

## 9. Fixed lexical evaluation finding (separate from host contract)

Parent fixture `specs/lesson-learning-reliability/recall-evaluation.json` and
`scripts/evaluate-lesson-recall.mjs` reported lexical recall@3 `0.60`,
precision `1.00`, and negative false injection `0` (60 positives / 40
negatives). Most misses are Korean lesson → English paraphrases, plus four
Korean paraphrases. This is a measurement record, not a fixture-tuning task.

Existing semantic retrieval cannot be directly reused for lessons: its vector
outbox item kinds exclude `lesson`, and lesson rows have no embedding/index
path. A separate approved follow-up must add a lesson vector projection/outbox
and hybrid candidate union behind lexical exact-match preservation, then run
the unchanged 60/40 fixture and negative/cross-scope gates. No synonym list or
fixture-specific rule was added here.

## 10. Host correctness follow-up and local hybrid diagnostic

- Candidate writes and idempotency records now share SQLite transactions;
  candidate review/approval rejects a mismatched generation, expired 30-day
  item, or source-session/event mismatch. Pending/review capacity is 20.
  Confirmed lessons retain scope, validation, reconsideration, and valid-version
  metadata. Version-constrained lessons stay out of automatic injection until a
  future host supplies a matching version context.
- Candidate snapshots preserve duplicate lesson-id proposals without automatic
  merge. Host snapshot lists are paginated at 100. Selected/delivered traces
  store lesson revisions, and acknowledgement rejects a revision changed before
  provider acceptance. The stable opening factory owns store migration and has
  a post-build dynamic-import smoke test.
- `npm run eval:lesson-hybrid -- <fixture> <existing-local-cache-dir>` performs
  local cosine ranking with remote model access disabled. The isolated empty
  cache diagnostic on 2026-09-20 returned `local_model_unavailable`; it made no
  provider/API call and produced no cosine threshold claim.
- A subsequently approved clone-only download through the existing managed
  Embedder resolver measured the unchanged 60 positive / 40 negative fixture:
  raw cosine retrieval@3 was 0.9833, raw precision@3 was 0.1967, and raw
  negative false-injection was 1.0. This is explicitly not an operational
  hybrid gate because the diagnostic always returns three neighbours. It does
  not implement, calibrate, or enable hybrid recall. Any adoption needs the
  existing relevance-abstention contract plus a separately frozen calibration
  set and held-out evaluation; the fixed fixture must not tune a threshold.

## 11. Final local verification boundary (2026-09-20)

- Host recall now has a 900ms internal read/permission/ranking deadline, scans
  100-row pages with event-loop yields, holds only page-local top candidates,
  and returns typed `timeout` with no selection trace or write. The existing
  warm lexical performance check is not evidence of a hard end-to-end budget.
- Worker generation fencing applies to enqueue and `markReviewed`; a reviewed
  candidate can be approved/rejected by a later current UI generation when its
  exact revision/hash and expiry remain valid. The last async host verification
  is immediately before each mutation transaction.
- The model artifact actually used by the raw diagnostic was
  `Xenova/multilingual-e5-small`, artifact SHA-256
  `a89c5cc413885d7c2af5906da0f77f30d2ce4ef4bb11751fc7e22d652373ec4d`.
  The Embedder download contract did not expose a revision, so it is recorded
  as unavailable rather than invented. The cache is clone-local and ignored.
- Verified: `npm run verify` (233 files / 1,575 tests; lint has 45 pre-existing
  warnings and zero errors), `npm run build`, dist host-opening smoke,
  `npm run check:architecture`, targeted host tests, and the local raw cosine
  diagnostic. No user database, installation, hooks configuration, provider,
  paid call, or publish action was changed.

## 12. Approved T6 follow-up started (not complete)

The fixed 60/40 fixture is held out unchanged. The raw cosine diagnostic is
not an enabled recall path. The next implementation unit is a process-local,
revision-keyed derived lesson-vector cache at the shared lexical ranking
boundary, with asynchronous model warmup/status and cold lexical fallback.
It must use a separately authored calibration corpus containing relevant,
irrelevant, and condition-opposite cases to freeze any abstention threshold
before measuring the held-out fixture. No authoritative SQLite vector schema
change, user cache/config mutation, provider call, or threshold tuning against
  the 60/40 fixture is authorized by this recorded state.

## 13. T6 calibrated common hybrid result (2026-09-20)

`benchmarks/lesson-recall/calibration-v1.json` is independent from the held-out
60/40 fixture and includes English/Korean relevant cases, unrelated cases, and
condition-opposite cases. It froze the general negation/skip/prohibition guard
plus absolute cosine `0.82` and top-1 margin `0.03`; held-out labels did not
choose these values. `rankCuratedLessonsHybrid` preserves lexical hits, starts
a background process-local index build on cold semantic fallback, and only
uses ready revision-keyed vectors in foreground. The held-out common-function
result is saved at `benchmarks/lesson-recall/results/heldout-v1.json`: lexical
recall@1 .6000 / precision 1 / negative false 0 / identifier .5932 / p95
.175ms; hybrid .7667 / 1 / 0 / .7627 / 2.325ms. Native short-lived hook
processes remain lexical-only: the existing persistent semantic daemon exposes
only retrieve/graduate/summarize, not a lesson-cache warm/status operation.
No new public daemon API was introduced without a separate contract.

## 14. E5 prefix v2 experiment (2026-09-20)

The official `intfloat/multilingual-e5-small` model card specifies `query:`
and `passage:` retrieval prefixes. Lesson vectors alone now use that contract
when the active model is an E5 family model; the global Embedder/event index
remains unchanged. Cache keys include model and `e5-prefix-v2`. Independent
calibration froze absolute `.826` and margin `.029` with the existing general
negative-intent guard. The unchanged held-out v2 result is recall@3 `.7000`,
precision `1`, negative false `0`, identifier retention `1`, p95 `2.667ms`.
It misses the .80 quality target; no held-out threshold adjustment was made.

## 15. Primary review and independent calibration v3 (2026-09-20)

The independent 20-lesson/100-query calibration fixture includes 20 explicit
opposite-condition queries. A shared prohibition guard now abstains before
lexical ranking as well as semantic rescue; Korean spaced `하지 마라` is covered.
The deterministic calibration-only grid froze cosine `.829` and margin `.026`.
The unchanged held-out result is recall@3 `.683333`, precision `1`, negative
false injection `0`, identifier retention `1`, warm p95 `42.798ms`.
Semantic rescue remains off by default because the `.80` quality gate failed.
Results and provenance are in `benchmarks/lesson-recall/results/`; neither
held-out labels nor thresholds were altered after this measurement.

Primary review also fixed cached recall revision comparison, tested final
binding/policy withdrawal, and retained only a SHA-256 request fingerprint.
Latest verification: 234 files / 1,592 tests passed, typecheck, lint (45 existing
warnings, no errors), build, and import-boundary check passed. The stable artifact advertises native-owner support; both SessionStart and
UserPromptSubmit skip only the lesson lane for host ownership. The local npm
archive passed extracted-package factory/schema/capability smoke. No live user
store, hook installation, paid review, or deployment was changed.


## 8. 2026-09-21 후속 검증 (PR #89, 미배포)

- native 공통 query에서 host의 개별 교훈 제외가 DB 재시작 후에도 유지되고, registered asset 철회가 host/native 양쪽에 적용되는 통합 테스트를 추가했다. Happy 프로젝트 전체 OFF는 이 계약과 별개이며 native가 해당 설정을 읽는다고 주장하지 않는다.
- `scripts/evaluate-lesson-hybrid-heldout.ts <fixture.json> <result.json>`은 결과 JSON에 ranking gate를 쓰고 미달이면 exit 1을 반환한다. recall ≥.80, precision ≥.90, negative ≤.05, identifier=1, warm p95≤300ms를 검사하며 누락·비정상 수치는 성공으로 인증하지 않는다. 이 gate는 실제 runtime/권한·cold 성능 검증을 대신하지 않는다.
- 회귀 14건 및 실제 frozen held-out 실행: recall .6833으로 `failures: [recallAt3]`, exit 1. semantic 기본 OFF와 기존 threshold/label을 유지했다.
- 최종 전체 235 files / 1,608 tests 통과(`npm run test:run -- --maxWorkers=2`), typecheck·lint(기존45warnings/오류0)·build·architecture 통과. 이 변경은 아직 발행하거나 사용자 설치에 반영하지 않았다.
