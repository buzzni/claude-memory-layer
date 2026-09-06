# 부모 모델 코드 리뷰 및 수정 결과

2026-09-06 · 대상: Claude Opus 5 high 에이전트가 작성한 R1~R5 구현. 부모가 소스와 호출 경로를 직접 검토하고 수정했다.

## 발견점과 반영

| 발견점 | 반영한 수정과 검증 |
|---|---|
| 평가 PK가 프로젝트를 구분하지 않고 `lesson:x` 이벤트와 lesson `x`도 충돌 | 프로젝트·종류·ID JSON tuple 키로 변경하고 원본 ID는 별도 보존. 네 개 참조가 네 개 관측으로 남는 회귀 테스트 통과. |
| scope의 `-` sentinel과 실제 `-` 프로젝트 충돌 | JSON tuple 키를 사용하고 구 키 parser는 읽기 호환으로 유지. round-trip 테스트 통과. |
| 전달 결과와 탐색이 프로젝트 범위를 무시 | 프로젝트 범위를 helpfulness·v3 관측·navigation까지 전달. 다른 프로젝트 동일 ID를 갱신하거나 열람으로 계산하지 않는 테스트 통과. |
| 현대 스키마에서 전달 기록 자체가 없는데 참조 탐색을 귀속 | emitted/acknowledged 증거를 요구. 선택만 기록한 trace의 열람은 unattributed로 유지. |
| legacy trace와 typed item 기록이 별도 커밋 | 하나의 IMMEDIATE 트랜잭션으로 결합. typed INSERT를 강제로 실패시켰을 때 trace도 남지 않는 테스트 통과. |
| 동일 request의 선택이 빈 배열이 되면 이전 typed 항목 잔존 | 빈 결과 갱신도 stale 항목을 정리. 회귀 테스트 통과. |
| 동일 request 재기록에서 선택 상태가 true에서 false로 바뀌지 않고, typed 쓰기 플래그를 끄면 기존 typed 원장이 legacy 배열과 어긋남 | 재기록은 typed 항목 전체를 교체하고, 이미 typed 항목이 있는 trace는 플래그가 꺼져도 일관되게 갱신. 선택 해제·stale 제거 회귀 테스트 통과. |
| 호출자가 임의 `itemKey`를 주면 `(projectId, kind, id)` 정체성 계약을 우회 | item key를 항상 정규화된 tuple에서 계산하고 외부 입력 필드를 제거. typed identity 테스트 통과. |
| 실패한 전달 기록이 `delivered_at`을 채우고, 이후 acknowledge가 최초 전달 시각을 덮음 | emitted/acknowledged에만 전달 시각을 기록하고 최초 성공 시각을 보존. 실패·재확인 회귀 테스트 통과. |
| 같은 session의 resume/compact SessionStart가 같은 requestId를 재사용해 이전 trace를 덮음 | SessionStart 호출마다 UUID prefix를 만들고 core/lessons/recent lane만 suffix로 연결. 격리된 실제 훅 프로브 통과. |
| 민감정보 후보가 blocked 결과에 원문으로 포함 | 후보 본문·조건·근거와 MCP 반환 본문을 차단. reasons/pattern도 민감정보 검사에 포함. |
| 일부 sourceRef가 없어도 검증된 후보처럼 처리 | 하나라도 미해석된 참조가 있으면 승격 차단. zero lag는 null 대신 0으로 보존. |
| 이름 휴리스틱으로 production/test를 확정 | 명시적 `--classify` 지원, 기본 unknown, 별도 classificationHint. 명시값 유효성·집계 테스트 통과. |
| 감사의 rolling window가 until을 무시하고 미래 행을 포함 | until 기준 반개구간으로 24/48시간 집계. 종료 경계 및 UTC/SQLite 시각 회귀 테스트 통과. |
| 수집 지연 helper가 보고서에 연결되지 않음 | read-only 공통 clock reader를 감사 JSON/Markdown에 연결. 임의 source/client 문자열은 제한된 차원 값으로 정규화. |
| 빈 store 판정이 event 수만 보고 trace/lesson만 있는 저장소를 누락하고, 구 events schema에 metadata가 없으면 clock 조회가 실패 | 세 원장 전체를 확인해 empty를 판정하고 metadata 컬럼 유무를 introspection. 현재 빈 schema와 metadata 없는 legacy schema 테스트 통과. |
| 평가 cutoff 이후의 미래 응답으로 grounding 계산 | v3 응답·프롬프트·도구 평가를 cutoff에 제한. 미래 응답은 unknown으로 남기는 회귀 테스트 통과. 기존 미래 응답 fixture 3개는 이미 도착한 응답 시각으로 수정. |
| 신규 evaluator가 아닌 다른 버전을 현재 모집단에 섞음 | 현재 버전만 집계하고 v2를 따로 보고. legacy 수치도 같은 기간과 trigger 범위로 제한. |
| 단계적 롤백 경로 누락 | typed 원장, v3 쓰기, v3 UI에 독립 환경 플래그 추가. 비활성화·재활성화 테스트 통과. |
| 공개 spec·집계 JSON에 로컬 프로젝트 basename이 노출 | 원시 basename을 제거하고 익명 순위·store 번호·`test-looking`/`other` 범주로 교체. 공개 출력 개인정보 검사 통과. |

초기 회귀 테스트로 정체성 충돌·민감 후보 노출·불완전 출처·추정 분류 오류를 재현한 뒤 수정했다. 이후 재기록 일관성·전달 시각·legacy schema 회귀를 추가했고 최종 실행은 **1,622건 전부 통과**했다.

## 최종 증거

- 240개 테스트 파일 / 1,622개 테스트 통과, typecheck·build·architecture 통과, lint 오류 0개(기존 경고 45개).
- 공개 출력 개인정보 검사 10개 파일 통과(발견 0개), 격리된 Claude 두 훅의 실제 stdout 프로브 통과.
- 읽기 감사 fixture의 전후 파일 크기·mtime·schema 불변 검증 통과.
- 신규 CLI로 실제 187개 저장소에서 기존 고정 표본을 정확히 재현: event 6,704 / trace 957 / event 선택 1,959 / lesson 선택 465 / unknown 선택 0.
- 집계 JSON에는 원문 메모리·사용자 절대 경로를 포함하지 않는다.

품질·토큰·지연 실험은 구현 정확성 테스트와 별개다. 아직 baseline 대비 개선을 입증하지 않았고 importer의 durable cursor도 미계측이므로 최신 source timestamp를 backlog 증거로 제시하지 않는다. 구 v2 관측은 수정하지 않았으며 신규 v3와 평균을 섞지 않는다.
