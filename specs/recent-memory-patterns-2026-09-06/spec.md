# 최근 다중 프로젝트 메모리 활용 개선 Spec

상태: 개발 구현·부모 코드 리뷰 완료 / 품질·성능 실험 미측정 · 작성일: 2026-09-06 · 코드 기준: `853f5a4` / 패키지 2.4.0

## 1. 결론과 범위

최근 48시간에는 메모리가 활발히 쌓이고, 과거 이벤트와 lesson도 실제 검색에 선택됐다. 다음 우선순위는 **메모리 종류·선택·전달·채택을 정확하게 연결하는 계측**, **빈 검색의 원인 구분**, **프로젝트별 근거 품질 개선**이다. 단순 수집량 증가나 일괄 삭제는 우선하지 않는다.

이 문서는 현재 머신의 로컬 CML 저장소를 읽어 작성한 분석과 구현 계약이다. 최초 분석 이후 제품 코드를 구현하고 부모 모델이 리뷰·수정했다. [최종 구현 결과](./implementation-results.md)와 [부모 리뷰 결과](./review-results.md)를 참고한다. 원본 메모리와 설치 설정은 변경하지 않았다. 기존 `lesson-recall-hooks`와 usefulness v2 구현을 확장하며, 이미 구현된 lesson 검색·프로젝트 경로 수렴·품질 필터를 다시 만들지 않는다.

## 2. 조사 방법과 해석 한계

- 고정 관측 구간: **2026-09-04 00:25:00 이상 ~ 2026-09-06 00:25:00 미만 KST**, 정확히 48시간. UTC로는 09-03 15:25 ~ 09-05 15:25.
- 기본 CML 루트의 프로젝트 저장소 186개와 전역 저장소 1개, 총 187개를 읽었다. 최근 이벤트 또는 retrieval trace가 있는 저장소는 26개(프로젝트 25 + 전역 1), 없는 저장소는 161개. 조회 오류는 0개였다.
- 범위 밖: 별도 설정한 사용자 지정 메모리 루트, 다른 제품의 내장 메모리, 원본 대화 전체와 클라우드 기록. 따라서 “머신의 모든 에이전트 활동”을 전수 측정한 것은 아니다.
- Python SQLite URI `mode=ro`, `query_only=ON`, 저장소별 읽기 트랜잭션을 사용했다. 마이그레이션·refresh·재임포트·GC·임베딩 실행은 하지 않았다. DB별 스냅샷이며 머신 전체 원자적 스냅샷은 아니다. 운영 중 후속 평가·삭제가 일어나면 재실행 결과가 달라질 수 있다.
- 이벤트 수는 `events.timestamp`, 검색 수는 `retrieval_traces.created_at`, lesson 생성은 `memory_lessons.created_at` 기준이다. SQLite `julianday`로 ISO 문자열과 SQLite UTC 문자열을 함께 비교했다.
- `events.timestamp`는 일부 importer에서 저장 시각이다. 원래 대화 시각과 동일하다고 가정하지 않는다. 이번 구간에서 `originalTimestamp`가 있는 112건에는 24시간을 넘는 저장 지연이 없었다. 나머지 이벤트의 수집 지연은 알 수 없다.
- 분석 중 로컬에서 basename을 확인했지만 공개 산출물에는 보존하지 않았다. `store-NNN`은 이번 정렬 목록에서만 유효한 익명 식별자다. 프로젝트 개수와 저장소 개수를 동일시하지 않는다.
- 원문·질의·세션 ID·사용자 절대 경로·인증 정보는 산출물에 포함하지 않았다. 내용 중복은 DB 안에서 정확 일치로만 비교했다. 의미적 정확성에 대한 원문 표본 평가는 수행하지 않았다.
- 조사 시작 시 CML context pack도 조회했다. 관측 종료 경계 직전의 이 조회가 계측에 섞였을 가능성이 있으며, 호출자 ID 기반 제외를 하지 않았으므로 조사 유발 효과를 완전히 제거한 baseline은 아니다.

재현 도구: [scripts/analyze-recent-memory.py](../../scripts/analyze-recent-memory.py)

```bash
python3 scripts/analyze-recent-memory.py --until 2026-09-05T15:25:00Z
```

고정 집계: [memory-patterns-2026-09-06.aggregate.json](../../docs/reports/memory-patterns-2026-09-06.aggregate.json). JSON의 `age_at_window_end.lesson_reference`는 나이가 아니라 이벤트 외 타입 분류다. 기존 이벤트 중심 스키마의 한계를 명시하기 위해 분리했다.

## 3. 관측 결과

### 3.1 저장은 두 프로젝트와 도구 관측에 집중된다

| 항목 | 최근 48시간 |
|---|---:|
| 저장 이벤트 | 6,704 |
| 앞 24시간 / 뒤 24시간 | 1,810 / 4,894 |
| 도구 관측 | 5,147 (76.8%) |
| 사용자 프롬프트 / 에이전트 응답 / 세션 요약 | 762 / 747 / 48 |
| 저장 본문 길이 합 | 20,424,746 문자 |
| 새 lesson | 47, 모두 최다 활동 저장소 |
| 새 consolidated_memories | 0 |
| 동일 저장소·동일 event_type·동일 본문 중복 초과분 | 41 (0.61%) |

뒤 24시간 수집량은 앞 구간의 2.70배다. 작업량 증가와 수집 정책 변화의 기여도는 현재 자료로 분리할 수 없다. 본문 문자 수는 디스크 바이트나 토큰 수가 아니다. 정확 중복은 낮으므로 전역 dedup 강화보다 도구 기록에서 재사용할 근거를 추출하는 개선을 먼저 실험한다. 41건에도 의도적인 반복 질문이 포함될 수 있어 삭제 대상으로 간주하지 않는다.

### 3.2 프로젝트별 차이

선택 건수는 trace마다 선택한 항목의 합으로 동일 메모리가 여러 번 포함된다. 이벤트와 lesson을 모두 포함한다. 마지막 열은 v2 관측에 있는 grounded 건수이며, 실제 도움이나 인과적 성공의 확정값이 아니다.

| 대표 프로젝트 / 저장소 | 이벤트 | 도구 관측 | trace | 선택 | 선택 0 trace | grounded / v2 관측 |
|---|---:|---:|---:|---:|---:|---:|
| 최다 활동 저장소 / 070 | 3,821 | 2,809 | 557 | 1,631 | 68 | 153 / 1,627 |
| 차상위 활동 저장소 / 158 | 2,625 | 2,194 | 259 | 572 | 24 | 48 / 567 |
| store-052 | 77 | 50 | 13 | 31 | 2 | 4 / 31 |
| ms7phrmksimu / 145, 이름 미확정 | 61 | 51 | 6 | 21 | 0 | 10 / 21 |
| store-060 | 26 | 20 | 5 | 11 | 0 | 2 / 11 |
| store-096 | 17 | 12 | 3 | 7 | 0 | 2 / 7 |
| noble-panda-mitg / 108, 이름 미확정 | 12 | 8 | 4 | 9 | 0 | 1 / 9 |
| project / 001, 테스트 혼입 후보 | 51 | 2 | 91 | 139 | 42 | 0 / 135 |

상위 두 저장소가 이벤트의 96.2%, trace의 85.3%를 차지한다. 머신 합계가 개선돼도 소규모 프로젝트에서 회상이 악화될 수 있다. 최소 표본과 프로젝트별 결과를 함께 제시해야 한다.

테스트·임시 작업으로 보이는 basename의 저장소와 전역 저장소가 운영 집계에 섞인다. 이름만으로 자동 삭제하거나 테스트로 확정할 수는 없다. `store-001`은 선택 139회 중 상위 5개 메모리가 92회(66.2%)를 차지해 반복 노출의 진단 후보지만, 테스트 재생의 영향부터 확인해야 한다.

### 3.3 회상은 작동하지만 계측 의미가 섞여 있다

| 항목 | 관측 |
|---|---:|
| 전체 trace | 957 |
| 하나 이상 선택 / 선택 0 | 803 / 154 |
| 전체 선택 횟수 | 2,424 |
| trigger: user_prompt / session_start / unknown | 696 / 260 / 1 |
| presentation: evidence / reference / unknown | 799 / 157 / 1 |
| delivery_client: claude-hook / unknown | 956 / 1 |
| 선택된 원본 이벤트 / lesson | 1,959 / 465 |
| 원본 이벤트 나이: 2일 이하 / 2~7일 / 7일 초과 | 1,308 / 259 / 392 |

나이는 검색 당시가 아니라 관측 종료 시각 기준이다. 일주일 넘은 이벤트도 392회 선택돼 과거 메모리 회상은 확인된다. 오래됐다는 이유만으로 삭제하면 유효한 근거를 잃을 수 있다.

처음 이벤트 테이블만 조인하면 465회가 dangling ID로 보였다. 별도 확인에서 **465회 모두 같은 저장소의 `memory_lessons.lesson_id`로 해석됐다**(최다 활동 저장소 453, 차상위 저장소 9, 다른 저장소 3). 현재 자료에서 이 465건을 데이터 유실로 볼 근거는 없다. `selected_event_ids`라는 필드가 실제로는 여러 메모리 타입을 담는다.

신규 source가 `codex`인 이벤트는 112개이며, 나머지 6,592개는 native 또는 출처 미명시다. 그런데 trace 956개가 Claude 훅으로 기록됐다. **Codex가 저장한 메모리의 재사용**과 **Codex가 수행한 조회**는 서로 다른 지표다. 현재 자료로 Codex/Hermes 전체 조회량이나 클라이언트별 성공률을 계산할 수 없다.

선택 0인 154개 trace 모두 `runtime_error`로 기록돼 있었다. 코드에서 진단이 없고 선택이 비면 `runtime_error`를 기본값으로 사용하며, 프롬프트 훅은 `outcomeDiagnostics`를 넘기지 않는다. 따라서 16.1%는 빈 선택 비율이고 **런타임 장애율은 아니다**.

### 3.4 활용 평가의 관측과 추론을 분리해야 한다

최근 trace와 조인되는 v2 관측 2,408건은 grounded 220, not_observed 1,782, unknown 406이다. legacy helpfulness의 measured는 2,409건으로 1건 차이가 있어 동일 모집단으로 취급하지 않는다. trace 연결이나 fallback ID 때문에 차이가 날 수 있지만 해당 1건의 원인은 확정하지 않았다.

| v2 presentation / trigger | grounded | not_observed | unknown |
|---|---:|---:|---:|
| evidence / user_prompt | 185 | 797 | 259 |
| evidence / session_start | 35 | 316 | 147 |
| reference / user_prompt | 0 | 62 | 0 |
| reference / session_start | 0 | 607 | 0 |

주요 비교 지표는 **프롬프트 evidence의 관측된 grounding: 185 / (185 + 797) = 18.8%**다. unknown 259건은 분모에서 제외하고 별도 표시한다. 전체 2,408건을 분모로 한 9.1%와 의미가 다르다. reference 669건에는 navigated가 기록되지 않았지만, 이를 “아무도 읽지 않았다”로 단정할 수 없다.

현재 `grounded`는 텍스트 겹침 0.3 이상을 이용한 추정이다. 선택 기록만으로 전달을 보장할 수 없는데 평가 코드가 `delivered: true`를 넣는다. task outcome도 채택 추정이 있을 때 후속 30분 도구 성공 여부로 유도된다. 따라서 **전달률 100%, 실제 작업 성공률, 메모리로 인한 생산성 향상**을 현재 숫자로 주장해서는 안 된다.

`consolidated_memories` 신규 0건도 장기 메모리 생성 실패를 뜻하지 않는다. 실제 lesson 생성과 선택은 관측됐다. 특정 파생 테이블 한 개를 전체 메모리 성숙도의 지표로 삼지 않는다.

## 4. 구현 요구사항

### R1 · P0 · 메모리 종류를 보존하는 조회 원장

**문제:** 465회 lesson 선택이 이벤트 ID로 기록돼 조인 기반 지표를 왜곡한다.

- `MemoryRef = { projectId, kind: event | lesson | rule | core | unknown, id }`를 공통 타입으로 정의한다. 프로젝트 ID는 메모리 권한 경계와 일치해야 한다.
- 신규 `retrieval_trace_items`에 `trace_id, item_key, memory_kind, memory_id, project_id, rank, selected, score`를 저장한다. `item_key`는 같은 trace 내 참조의 고유 키다.
- 기존 배열은 호환 목적으로 유지하되 신규 reader는 typed 항목을 우선한다. 같은 ID가 여러 타입에 존재하면 추측하지 않고 `unknown/ambiguous`로 분류한다.
- helpfulness, navigation, access count도 같은 typed key를 사용한다. lesson ID로 `events.access_count`를 갱신하는 무효 쓰기를 방지한다.
- 전체 본문을 복제하지 않고 필요한 버전·내용 해시·삭제 상태만 남긴다. 삭제된 메모리의 원문을 telemetry로 되살리지 않는다.
- 구자료 해석은 보고서에서 read-only resolver로 수행한다. 영구 backfill은 별도 명령과 dry-run 결과를 제공하며 보고서 실행이 자동 실행하지 않는다.

**수용 기준:** 이번 고정 표본에서 event 1,959 / lesson 465를 재현하고 미해결 참조를 별도 계수한다. event/lesson 동일 ID, 삭제된 항목, 타 프로젝트 권한 거부를 테스트한다. 혼합 배열 조인으로 lesson이 누락되는 회귀를 차단한다.

### R2 · P0 · 빈 검색 원인과 클라이언트 관측 범위

**문제:** 빈 검색 154건이 모두 장애로 보이고, 사실상 훅 계측만으로 머신 활용도를 설명한다.

- 진단 누락 기본값을 새 `unknown`으로 바꾼다. `runtime_error`는 실제 예외가 포착된 경우에만 기록한다. 구자료는 자동 재분류하지 않고 `legacy_unclassified`로 표시한다.
- Claude 훅 최종 필터·세션 시작·MCP context pack·명시 검색 경로에서 existing `RetrievalOutcomeDiagnostics`를 채운다. 품질 제외, scope 제외, 후보 없음, 임계값 미달을 구별한다.
- `client`, `trigger`, `runtimeVersion`, `telemetrySchemaVersion`, `requestId`, `evaluationRunId`를 표준화한다. 같은 요청의 자동 trace와 외부 trace 중복은 requestId로 검증한다.
- 클라이언트별 `observed_requests`, `instrumented_requests`, `unobserved_or_unknown`을 제공한다. 호출 자체가 관측되지 않으면 coverage는 `unknown`이며 0%로 만들지 않는다.
- 의도적으로 쓰기를 하지 않는 진단/read-only 경로는 그 계약을 유지한다. telemetry가 필요하면 호출 측의 독립 큐를 사용하고 검색 저장소 초기화나 모델 로딩을 유발하지 않는다.

**수용 기준:** 빈 프로젝트, lexical miss, quality filter, threshold miss, 실제 예외가 서로 다른 이유로 기록된다. 실제 예외를 제외한 fixture에서 runtime_error가 0이다. 클라이언트마다 명시적으로 생성한 검색 1회가 정확히 1개 request로 집계된다.

### R3 · P0 · 선택·출력·채택의 증거 분리

**문제:** 평가 단계가 전달을 가정하며 reference 탐색과 evidence grounding이 섞인다.

- 선택 시점에 `delivered=null`로 시작한다. `deliveryStatus = unknown | formatted | emitted | acknowledged | failed`와 증거 출처를 기록한다. 훅 stdout 성공은 emitted이고 모델이 읽었다는 뜻은 아니다.
- 기존 v2 자료는 `deliveryEvidence=legacy_assumed`로 보여준다. 신규 evaluator 버전을 지정하고 v2와 섞어 평균 내지 않는다.
- lesson-get, source-ref, details 등 참조 확장을 R1의 typed key와 원래 trace에 연결한다. 여러 trace가 일치하면 ambiguous로 남긴다.
- 대화 종료 훅 외에 bounded 재평가 작업을 둬, 뒤늦게 도착한 응답·탐색 기록을 처리한다. 관측 창은 기존 30분을 기본으로 하며 결과에 window와 평가 cutoff를 표시한다.
- 기본 지표는 `evidence/user_prompt`의 grounded / (grounded + not_observed), unknown 비중, reference의 attributed navigation, delivered 증거 수준이다. session_start는 별도 표에 둔다.
- 텍스트 겹침과 도구 성공은 heuristic임을 UI와 JSON에 명시한다. explicit feedback과 평가자 검증 결과를 별도 보존한다.

**수용 기준:** 선택 후 출력 실패가 delivered=true가 되지 않는다. 응답 미수집은 unknown이다. 참조를 열지 않은 경우와 추적 불가능한 경우를 구별한다. evaluation 창 경계와 지연 응답을 검증한다. fixture에서 trace별 typed 선택 합과 평가 모집단의 차이를 이유별로 설명할 수 있다.

### R4 · P1 · 도구 기록에서 검증된 근거를 추출

**문제:** 76.8%가 도구 기록이지만 신규 정확 중복은 0.61%다. 중복 삭제만으로 해결할 문제는 아니다.

- 기존 원본 event를 보존하면서 반복 가능한 결정·검증된 수정·사용자 선호를 작은 파생 후보로 만든다. `sourceRefs`, 적용 조건, 근거, 유효기간/재검토 조건, 확신도, 생성 버전을 필수로 둔다.
- 환경 의존 설치 실패·자격증명 누락·실패만 한 시도·일회성 PR 서사·AGENTS/docs 복사본은 durable lesson으로 승격하지 않는다. 재시도로 해결됐으면 유효한 재시도 조건만 후보로 남긴다.
- 도구 타입만으로 전부 제외하거나 저장 비율 목표를 강제하지 않는다. 원문 길이·검색 후보 비중·채택 평가를 함께 보고 실험한다.
- 기존 lesson 검색과 슬롯 예약을 유지한다. 후보 승격을 처음에는 shadow 모드로 평가하고 검증된 후보만 회상에 사용한다.
- 저장 시각 `ingestedAt`와 원본 시각 `occurredAt`을 구분하고 importer cursor/lag를 출처별 표시한다. 이번 관측에 backlog 증거는 없으므로 backfill 속도 개선은 우선하지 않는다.

**수용 기준:** 민감정보·해결되지 않은 실패·저장소 문서 복제 fixture는 승격되지 않는다. 재사용 가능한 해결 후보는 sourceRefs로 검증 가능하다. 대표 질의 평가에서 근거 관련도를 유지하면서 주입 토큰 중앙값 20% 감소를 실험 목표로 삼는다. 이 수치는 예상 효과가 아니라 채택 여부를 판단할 목표다.

### R5 · P1 · 프로젝트별 read-only 건강 보고서

**문제:** 두 저장소의 과다 대표와 테스트성 저장소 혼입으로 머신 합계가 편향된다.

- 향후 CLI 계약: `memory audit --since <ISO> --until <ISO> --all-projects --read-only --format json|markdown`.
- 저장소별 schema capability, canonical project, alias 경로 개수, source/client, 최근 24/48시간, typed selection, 평가 분모, unknown 비중을 표시한다.
- 프로젝트는 `production | test | unknown`으로 명시적으로 분류한다. basename 휴리스틱은 진단 힌트만 제공한다. 머신 총계와 분류별 총계를 함께 보존한다.
- 기존 `project-path.ts`의 git common-dir/marker 수렴을 재사용한다. 불명확한 worktree store는 병합 제안만 만들고 자동 이동·병합하지 않는다.
- 현재 CML 이름을 포함한 과거 저장소 하나의 마지막 이벤트는 08-31이었다. alias/marker/활성 저장소를 확인하기 전 이를 동기화 실패로 표시하지 않는다.
- 읽기 보고서가 초기화·스키마 migration·임포트·임베딩·checkpoint를 유발하지 않아야 한다. 저장소 오류와 미지원 스키마는 누락하지 않고 coverage에 포함한다.

**수용 기준:** 빈 저장소, 구스키마, WAL 사용 중인 DB, 테스트 저장소, worktree alias, 읽기 실패 fixture에서 분모가 정확하다. 격리된 저장소의 전후 논리 데이터 및 파일 변경 검증으로 불필요한 쓰기가 없음을 확인한다.

## 5. 변경 지점과 기존 spec 관계

| 영역 | 현재 근거 / 변경 후보 |
|---|---|
| typed telemetry, unknown reason | `src/core/retrieval-telemetry.ts` |
| 원장·v2 평가·구자료 호환 | `src/core/sqlite-event-store.ts`, 특히 recordRetrievalTrace / measureHelpfulness 경로 |
| 요청별 trace 전달 | `src/core/engine/retrieval-orchestrator.ts` |
| 최종 선택과 lesson 혼합 | `src/adapters/claude/hooks/user-prompt-submit.ts`, `session-start.ts` |
| task outcome 해석 | `src/core/usefulness-outcome-v2.ts`, `usefulness-evidence.ts` |
| 수집 시각·출처 | `src/core/engine/memory-ingest-service.ts`, `src/services/codex-session-history-importer.ts`, `hermes-session-history-importer.ts` |
| 프로젝트 alias 해석 | `src/core/registry/project-path.ts` |
| 품질·lesson 회상 | `src/core/retrieval-quality.ts`, `src/adapters/claude/hooks/prompt-injection-policy.ts` |
| 대시보드 | `src/apps/dashboard/assets/js/usefulness.js` |

- [lesson-recall-hooks](../lesson-recall-hooks/spec.md)의 검색 확대·예약 슬롯·단건 조회를 유지하고 R1/R3의 타입·평가 연결만 보완한다.
- [memory-operational-quality-roadmap](../memory-operational-quality-roadmap/spec.md)의 read-only diagnostics / retrieval telemetry 작업과 합친다. 별도 경쟁 CLI를 만들지 않는다.
- [memory-grounding-remediation](../memory-grounding-remediation/spec.md)의 grounding 관측 취지는 유지하되, 전체 주입 분모를 하나로 합치거나 텍스트 overlap만을 실제 효용으로 해석하는 기준은 본 문서의 차원별 지표로 보완한다.

## 6. 구현 순서와 검증

1. **계측 계약:** R1 타입과 R2 unknown 이유를 추가하고 SQLite additive migration, 구 reader 호환 테스트를 통과시킨다.
2. **실제 경로 연결:** 훅/MCP를 R1~R3에 연결한다. 임시 저장소에서 출력 성공·실패·지연 평가를 확인한다. 설치/uninstall이나 사용자 설정 변경을 테스트 수단으로 사용하지 않는다.
3. **보고서 정규화:** R5에 집계 정의를 넣고 production/test/unknown 및 프로젝트별 분모를 검증한다.
4. **품질 실험:** R4를 shadow로 실행한다. 활동 상위 2개 저장소 외 최소 2개 프로젝트를 포함하고, 프로젝트별 최소 20개의 평가 가능한 질의를 확보한다. 이 기준을 못 채우면 `insufficient_sample`로 남긴다.

품질 실험은 동일 질의 집합과 격리된 스냅샷에서 baseline/후보를 비교한다. 개인정보를 제거한 표본을 사람이 또는 별도 평가 절차로 검증하여 heuristic의 오탐을 확인한다. 현재 회상 precision·토큰량·p95 지연은 측정하지 않았으므로 구현 전 새 baseline을 만든다.

배포 판단 기준: 신규 trace 타입 누락 0, 비예외 runtime_error 0, 암묵적 delivered=true 0, 프로젝트별 관련 근거 precision 감소 2%p 이내, shadow 주입 토큰 중앙값 20% 감소 목표, 로컬 warm 조회 p95 증가 10% 이내. 품질·성능 수치는 이번 자료에서 입증된 효과가 아닌 제안된 실험 기준이다. 최소 표본 미달에서는 자동 승격하지 않는다.

R1~R3은 기능 플래그로 신규 기록과 신규 UI를 단계적으로 켠다. 기존 원장 읽기를 유지하고 롤백 시 신규 테이블을 삭제하지 않는다. R4는 파생 후보 활성화만 끄면 원래 검색 정책으로 돌아가야 한다. 사용자 메모리 일괄 삭제·강제 병합·재임포트는 이 spec의 구현 완료 조건이 아니다.

## 7. 이번 산출물 검증

실제 기본 저장소 187개를 읽어 집계했고 오류는 없었다. event 외 선택 ID 465회의 lesson 해석, v2 presentation/trigger별 분모, originalTimestamp 지연을 추가 SQL로 대조했다. 보조 스크립트와 JSON을 함께 제공한다. 최초 분석 단계에서는 제품 코드를 변경하지 않았다. 이후 개발과 부모 리뷰를 마쳤으며, 전체 240개 파일/1,622개 테스트·typecheck·빌드·아키텍처·공개 출력 개인정보 검사를 통과했다. 새 감사 CLI에서도 동일한 고정 표본을 재현했다.

부가 표 재현 SQL은 아래와 같다. 테이블이 있는 각 프로젝트 DB에 읽기 전용으로 실행하고 동일 차원끼리 합산한다. `since`와 `until`은 §2 UTC 경계를 사용한다. 평가 관측은 이후 갱신될 수 있다.

```sql
SELECT o.presentation_mode, o.trigger_type, o.adoption, COUNT(*) AS n
FROM memory_usefulness_observations_v2 o
JOIN retrieval_traces t ON t.trace_id = o.trace_id
WHERE julianday(t.created_at) >= julianday(:since)
  AND julianday(t.created_at) < julianday(:until)
GROUP BY 1, 2, 3;

SELECT COUNT(*) AS original_timestamp_present,
  SUM(julianday(timestamp) -
      julianday(json_extract(metadata, '$.originalTimestamp')) > 1) AS lag_over_1d
FROM events
WHERE julianday(timestamp) >= julianday(:since)
  AND julianday(timestamp) < julianday(:until)
  AND json_extract(metadata, '$.originalTimestamp') IS NOT NULL;
```
