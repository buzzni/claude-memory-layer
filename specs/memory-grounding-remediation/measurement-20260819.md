# 측정 — 2026-08-19 (F1 + F2-a + F2-b + SessionStart 타입 필터 반영 후)

채취 시각: 2026-08-19. spec.md §2 쿼리 사용.
측정 창: **2026-08-09 이후** — 마지막 behavioral 변경(#57, SessionStart 요약 우선 랭킹 제거,
2026-08-08 배포) 이후의 깨끗한 창. 이 창에는 F1(7/31), F2-a, F2-b(LLM 요약, #42),
SessionStart 타입 필터(#55/#57)가 모두 반영되어 있다.

## 결과: 전체 실사용률 (grounded = content_overlap_score ≥ 0.3)

| 스토어 | 프로젝트 | evaluated | grounded | **pct** |
|---|---|---:|---:|---:|
| 6ab6d837 | aplus-dev-studio-desktop | 2,293 | 457 | **19.9%** |
| e9894ad9 | aplus-dev-studio | 1,957 | 489 | **25.0%** ✅ |
| 437bc9ea | aplus-dev-studio-app | 98 | 19 | 19.4% |
| 73c3b2b0 | claude-memory-layer | 61 | 33 | 54.1% |
| 44512761 | knoi-desktop | 83 | 14 | 16.9% |

baseline(2026-08-01, 6ab6d837) 8.4% → **19.9%** (2.4×). spec §2 목표 25%에는
e9894ad9만 도달. 단일 프로젝트 근거였던 spec이 5개 스토어에서 같은 방향으로 재현됨.

## 타입별 (6ab6d837 / e9894ad9)

| 타입 | evaluated | pct | evaluated | pct |
|---|---:|---:|---:|---:|
| agent_response | 2,161 | 20.5% | 1,849 | 26.2% |
| session_summary | 129 | 10.9% | 106 | 3.8% |
| tool_observation | 3 | 0.0% | 1 | 0.0% |
| user_prompt | 0 | — | 1 | 0.0% |

## 개별 목표 판정

| spec §2 목표 | 결과 |
|---|---|
| tool_observation 주입 < 20 | ✅ 창 전체 4건. user_prompt 레인은 F1이, session_start 레인은 #55/#57이 차단 — session_start 레인 누수는 8/01~8/07에만 253건(grounded 0) 있었고 8/08 이후 0건 |
| session_summary 실사용률 > 10% | ⚠️ 6ab6d837 10.9% 달성, e9894ad9 3.8%·나머지 0%. F2-b(LLM 요약)는 8/09 이후 생성분 전량에 적용 중 — 형식이 아니라 내용/재사용 맥락의 편차 |
| 전체 > 25% | ⚠️ 1/5 스토어 달성, 나머지 17~20% |

## D2 (F3 착수 여부) 판단 입력

- 현재 병목은 더 이상 "무엇을 주입하지 않을까"가 아니다 — 낭비 주입(tool_observation,
  목차형 요약)은 소멸했다. 남은 것은 **주입하는 것의 품질**: agent_response 20~26%,
  LLM 요약 4~11%.
- session_start 레인의 요약/응답 유용성 판정은 overlap만으로 불충분
  (roadmap `retrieval-telemetry` 참조). **v2.2.11(참조 내비게이션 텔레메트리)이
  2026-08-19 배포·전역 설치됨** — 이후 데이터로 session-start-experiment 게이트를 판단할 것.
- F3(지식 추출 레인)보다 먼저 볼 것: 스토어 파편화. 워크스페이스 인스턴스 스토어 9개가
  전 스토어 최저 grounding(0.059~0.073)이었다 — 매 인스턴스 cold start라 주입할 좋은
  메모리 자체가 없음. `.claude-memory-root` 마커 수렴(본 브랜치)이 그 대응이다.

## 다음 측정

- v2.2.11 텔레메트리 축적 후(≥1주) session_start 레인의 참조 열람/인용 시그널 확인
- 마커 활성화 후 워크스페이스 신규 세션의 grounding을 본 문서 수치와 비교
