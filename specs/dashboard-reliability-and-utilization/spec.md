# Dashboard Reliability & Memory Utilization Spec

## Overview

현재 대시보드는 프로젝트 메모리의 저장·검색 활동을 보여주지만, 일부 라벨과 계산이 실제 데이터 범위와 일치하지 않는다. 특히 Global 선택은 전체 프로젝트 합계처럼 보이나 실제로는 global store만 읽고, Useful Recall KPI는 기간과 무관한 누적 값을 재사용하며, 평가 근거가 없는 복합 점수도 `good`으로 표시될 수 있다.

이 개선은 대시보드를 "상태를 보는 화면"에서 "측정 결과를 신뢰하고 다음 행동을 고르는 화면"으로 만드는 첫 단계다.

## Goals

1. 화면에 표시되는 scope와 실제 조회 storage scope를 일치시킨다.
2. KPI의 현재 기간, 이전 기간, 일별 추세가 각각 동일 기간의 helpfulness 자료를 사용하게 한다.
3. 결과 평가가 없는 경우 복합 점수를 수치/등급으로 단정하지 않는다.
4. 프로젝트 선택기에 유효하고 읽을 데이터가 있는 프로젝트만 노출한다.
5. 모바일 화면에서 가로 스크롤 없이 핵심 카드와 검색/새로고침을 사용할 수 있게 한다.
6. sessions 지표가 활성 세션이 아니라 저장된 고유 세션 수임을 명확히 한다.

## Non-goals

- Global store와 모든 project-local store를 합산하는 새 집계 저장소 구현
- L2~L4 graduation, lesson/action/graph projector 활성화 정책 변경
- 사용자 Claude 설치를 재시작하거나 전역 플러그인을 재설치하는 작업
- 기존 메모리 데이터 삭제 또는 마이그레이션

## User Stories

### US-1 정확한 범위 이해

사용자는 Global Store와 프로젝트별 store가 다른 데이터 소스임을 선택기와 scope 안내에서 즉시 이해할 수 있다.

### US-2 기간에 맞는 KPI

사용자는 24h/7d/30d를 바꿀 때 Useful Recall Rate의 현재값, 이전 기간 대비 변화, 일별 추세가 실제 해당 기간 평가만 반영한다고 신뢰할 수 있다.

### US-3 근거 부족 상태

사용자는 평가 데이터가 없으면 `good/low` 점수 대신 `Insufficient data` 상태를 보고, 더 많은 평가가 필요함을 이해할 수 있다.

### US-4 정돈된 프로젝트 선택

사용자는 백업 폴더, 잘못된 hash, 비어 있는 DB 없이 실제 조회 가능한 프로젝트만 선택할 수 있다. 같은 저장소의 main checkout/worktree 별칭은 대표 경로 하나로 표시된다.

### US-5 모바일 사용

사용자는 390px 폭에서도 페이지 전체가 가로로 밀리지 않고 헤더, 검색, 카드, usefulness strip을 사용할 수 있다.

## Acceptance Criteria

### Scope

- 빈 project query는 기존 global store를 계속 읽는다.
- UI 기본 옵션은 `Global Store`로 표시한다.
- `All projects`, `Global aggregate`처럼 합산을 암시하는 문구가 남지 않는다.
- Global Store가 비어 있으면 프로젝트 선택 안내를 유지한다.

### KPI windowing

- helpfulness 통계 API 내부 조회는 `since`와 선택적 `until`을 지원한다.
- KPI current/previous/day bucket은 각기 다른 `[since, until)` 범위를 사용한다.
- Useful Recall delta와 trend는 all-time 상수를 재사용하지 않는다.
- 평가가 없는 current/previous/day bucket은 측정된 0으로 취급하지 않고 unavailable로 표시한다.
- 기존 `since` 단독 호출은 호환된다.

### Usefulness evidence

- `totalEvaluated === 0`이고 `contentEvaluated === 0`이면 `score.value`는 `null`, `label`은 `unknown`, `status`는 `insufficient-data`다.
- Overview와 Usefulness UI는 이 상태에서 숫자 `0` 또는 높은 복합 점수를 표시하지 않는다.
- 평가 자료가 있는 기존 score 계산과 등급은 유지한다.

### Project list

- `/api/projects`는 8자리 소문자 hex 디렉터리만 고려한다.
- `events.sqlite`가 존재하고 크기가 0보다 큰 프로젝트만 반환한다.
- 동일 hash의 registry 경로는 main checkout을 우선하고, 그다음 최근 등록 경로를 선택한다.
- API 응답은 기존처럼 원시 DB 경로나 세션 ID를 노출하지 않는다.

### Mobile and labels

- 600px 이하에서 main content와 header children이 viewport 너비를 넘지 않는다.
- header actions와 usefulness strip은 세로/줄바꿈 레이아웃을 사용한다.
- `Active Sessions`는 `Stored Sessions`로 변경한다.

## Technical Constraints

- SQLite WAL/read-only dashboard 동작을 유지한다.
- dashboard API는 lightweight service를 계속 사용한다.
- 기존 REST 응답 필드는 가능한 한 유지하고, 새 상태 필드는 추가형으로 제공한다.
- 사용자 전역 설정과 `~/.claude/settings.json`은 수정하지 않는다.

## Verification

- 관련 Vitest 단위/API/UI 테스트
- 전체 테스트와 TypeScript/build 검증
- dashboard smoke test
- 실제 브라우저 desktop/mobile 레이아웃 및 console 검증
