# Memory Hub Actionable Dashboard Context

> 상태: 완료 / 다음 시작점: PR 리뷰 후 배포 버전 반영 여부 결정

## 확인된 현상

- 설치 버전 1.2.3과 저장소 정적 자산의 검색 disclosure 코드는 동일하다.
- 실제 프로젝트 저장소(17,377 events, 986 retrieval queries)에서 disclosure 검색은 8건을
  반환했고 expand/source API도 200으로 정상 동작했다.
- 결과 클릭은 넓은 Chrome 화면에서는 우측 `#disclosure-drilldown`을 갱신한다.
- `style.css`의 `@media (max-width: 1100px)`가 `.disclosure-layout`을 column으로 바꿔 상세를
  결과 8건 전체 아래로 보낸다. 자동 스크롤·포커스·오버레이가 없어 무반응처럼 보인다.
- Overview `#search-input`은 `handleSearch()`로 연결되지만 함수 본문은 console.log뿐이다.
- `/api/stats/usefulness-history`가 이미 질문, 선택 메모리, 답변 근거, helpfulness/grounding을 제공한다.
  `/api/events?type=user_prompt`와 `/api/stats/helpfulness`도 Overview 요구 데이터를 충족한다.

## 결정

- 검색 상세는 기존 disclosure API를 재사용하고 UI만 드로어로 승격한다.
- 좁은 화면은 고정 드로어, 넓은 화면은 기존 병렬 레이아웃을 유지한다.
- Overview는 저장량보다 최근 질문과 메모리 효용을 먼저 보여준다.
- 새 API·스키마 없이 시작한다.

## 완료 결과

- Overview 상단 검색이 Playground의 disclosure 검색을 실행하고 결과를 즉시 표시한다.
- 결과 클릭 시 상세 드로어에 안전한 미리보기, 메타데이터, 확장 맥락, 관련 원본과 세션 이동을 표시한다.
- 1100px 이하에서는 상세가 고정 오버레이로 열리고 닫기·ESC·포커스 이동을 지원한다.
- Overview에 최근 질문, 최근 메모리 활용, 유용한 메모리를 추가했다. 질문은 세션으로, 활용/유용성 항목은 메모리 상세로 이동한다.
- 각 활동 카드의 API 실패는 빈 상태로 격리되며 모든 요청은 기존 `apiUrl()`을 통해 현재 프로젝트 범위를 따른다.

## 최종 리뷰에서 수정한 문제

- 새 검색을 실행할 때 이전 상세 드로어 상태가 남아 좁은 화면을 가릴 수 있어 검색 시작 시 드로어를 닫도록 수정했다.
- 메모리를 선택하지 않은 질문을 `evaluation pending`으로 표시하던 의미 오류를 `no memory selected`로 수정했다.
- 정의되지 않은 CSS 토큰 두 개를 기존 테마 토큰으로 교체하고 드로어 포커스 표시를 복구했다.
- 최신 `origin/main`의 v1.2.3 통계 신뢰성 변경을 먼저 반영하고 충돌 테스트는 양쪽 회귀 케이스를 모두 보존했다.

## 검증

- TDD 재현: 상단 검색과 상세 드로어 테스트가 구현 전 각각 실패함을 확인한 뒤 통과시켰다.
- 관련 회귀: 3개 파일, 33개 테스트 통과.
- 전체 회귀: 172개 파일, 1,096개 테스트 통과.
- `npm run typecheck`, `npm run build`, `npm run smoke:dashboard` 통과.
- `npm run lint` 오류 0개. 기존 `no-explicit-any` 경고 44개는 변경 범위 밖이라 유지했다.
- 빌드된 서버에서 실제 프로젝트 `6ab6d837`로 최근 질문·활용·유용한 메모리를 확인했다.
- 상단 검색 `vendor happy-cli`가 8건을 반환하고 첫 결과 상세의 expand/source가 열리는 것을 확인했다.
- 900×800 뷰포트에서 상세 오버레이·backdrop·닫기를 확인하고 테스트 후 뷰포트를 복원했다.

## 주의

- 원본 transcript와 metadata는 기본 상세에 그대로 노출하지 않는다. 기존 safe preview 경계를 유지한다.
- 저장소의 기존 미추적 `.aplus/` 디렉터리는 사용자 데이터이므로 그대로 보존하고 변경에 포함하지 않았다.
