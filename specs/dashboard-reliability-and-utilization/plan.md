# Implementation Plan

## Phase 1 — Measurement correctness

- [x] SQLite helpfulness 통계에 upper bound 추가
- [x] service/interface 시그니처 전파
- [x] KPI current/previous/daily 기간별 helpfulness 계산
- [x] 기간 계산 API 테스트 추가

## Phase 2 — Honest status and scope

- [x] 결과 평가가 없는 usefulness를 insufficient-data로 반환
- [x] Overview/Usefulness UI의 insufficient-data 렌더링
- [x] Global Store 라벨과 설명 정정
- [x] Stored Sessions 라벨 정정

## Phase 3 — Project hygiene and mobile UX

- [x] 유효 hash + non-empty DB 프로젝트만 노출
- [x] 동일 hash registry 대표 경로 선택 개선
- [x] 390px 모바일 가로 overflow 제거
- [x] API/UI/CSS 회귀 테스트 추가

## Phase 4 — Verification

- [x] targeted tests
- [x] full tests / typecheck / build
- [x] dashboard smoke
- [x] desktop/mobile browser QA 및 console 확인
