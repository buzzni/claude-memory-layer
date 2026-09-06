# 구현 분할 및 통합 계획

기준: [spec.md](./spec.md)의 R1~R5. 요청 모델: Claude Opus 5 (`claude-opus-5`). 최종 사용자 지시에 따라 effort는 `high`로 지정한다. 실제 실행은 Claude Opus 5 high 작성 에이전트 1개가 순서대로 구현한 뒤 부모가 리뷰·수정하는 방식이다. 아래 병렬 가능 범위는 의존성 분석 기록이다. 최종 통합 리뷰와 수정은 부모 세션의 현재 모델이 수행한다.

## 의존성과 작업 배치

| 단계 | 작업 | 선행 조건 | 병렬 가능 범위 |
|---|---|---|---|
| A | R1 typed MemoryRef, SQLite additive migration, 호환 reader, typed key 계약 | 없음 | B/C 설계 및 기존 코드 읽기 검토 |
| B | R2 원인 진단, 클라이언트/request metadata, 중복 요청 처리 | A 공통 타입 확정 | C/D/E와 별도 worktree에서 구현 가능 |
| C | R3 전달 증거, typed navigation/helpfulness, bounded 재평가, UI | A 공통 타입 확정 | B/D/E와 별도 worktree에서 구현 가능 |
| D | R4 shadow 근거 후보, 승격 정책, 출처 시각 구분 | A source reference 계약 확정 | B/C/E와 별도 worktree에서 구현 가능 |
| E | R5 read-only CLI 보고서, canonical/alias, 분모·coverage | A 공통 타입 확정; B/C 지표 계약 확정 | D 및 B/C의 확정 계약 기반 구현 |
| F | 통합, 실제 호출 경로 검증, 기존 동작 회귀 수정 | A~E 구현 종료 | 읽기 전용 영역별 리뷰 |
| G | 부모 모델 최종 코드 리뷰, 발견점 수정, 재검증 | F | 수정 파일이 겹치는 작업은 순서대로 |

R1~R3은 `sqlite-event-store.ts`, telemetry 타입, 훅 경로를 공유한다. 서로 다른 worktree여도 공통 계약과 병합 순서를 고정해야 한다. R4도 ingestion/source-ref 연결 부분은 A와 조율한다. R5는 R2/R3의 최종 분모와 unknown 의미를 재사용한다.

## 실행 제약

Saycode의 동일 작업 트리 규칙에 따라 동시에 파일을 수정하는 자식은 한 명만 둔다. 같은 디렉터리에서 다른 자식은 읽기 전용 설계/검토를 수행한다. 실제 병렬 구현에는 Desktop managed-worktree 병렬 실행을 사용한다. 자식의 성공적인 종료를 wait/read로 확인한 뒤 다음 작성자를 활성화한다.

## 작업별 완료 증거

- A: 혼합 event/lesson, ID 충돌, 삭제 참조, 권한 경계, 구스키마 호환 테스트.
- B: 빈 프로젝트/후보 없음/정책 제외/임계값 미달/실제 예외 구분, 요청 중복 제거 및 unknown coverage 테스트.
- C: 출력 실패·지연·참조 탐색·모호한 귀속·평가 cutoff, 가정에 의한 delivered=true 제거 테스트 및 UI 계약 검증.
- D: 민감정보·환경 실패·문서 복사 승격 방지, provenance와 shadow 동작 검증. 사용자 데이터에서 강제 승격하지 않는다.
- E: read-only/WAL/구스키마/읽기 실패/테스트 분류/alias fixture, JSON과 Markdown 출력 검증.
- F/G: typecheck, lint, 관련 테스트와 전체 테스트, build 및 저장소 필수 검사. 기존 실패와 신규 회귀를 구분하고 수정 후 영향 검사를 반복한다.

## 리뷰 원칙

독립 helper만 추가하고 실제 훅·MCP·CLI에 연결하지 않은 구현은 완료로 보지 않는다. migration 시 기존 데이터 의미를 추측해 덮어쓰지 않는다. read-only 작업은 사용자 저장소 초기화·임포트·GC를 유발하지 않는다. 테스트를 위해 install/uninstall이나 사용자 설치 설정을 변경하지 않는다.

토큰 20% 감소·지연 10% 이내·프로젝트별 precision 조건은 spec의 실험 기준이며 코드 작성만으로 달성했다고 보고하지 않는다. 최소 표본이 부족하면 측정 미완료로 명시한다.
