# 후보 합집합 + 후보 풀 BM25 재채점 + 레인 공통 척도 (T4) — 설계

> **Status**: §8(#119 해결, 측정 기반)만 구현. §2~§7(합집합, 재채점, 공통 척도, 임계값, 데몬 프로토콜)은 **보류 — 측정 결과를 보고 다시 결정**
> **Created**: 2026-10-31
> **근거**: `docs/architecture/mempalace-benchmarking-2026-10-31.md` 1번 항목
> **선행**: #121 (`CLAUDE_MEMORY_FTS_ABSOLUTE_SCORE_EXPERIMENT`), #125 (`CLAUDE_MEMORY_RETRIEVAL_QUERY_SANITIZER_EXPERIMENT`), 이슈 #119
> **참고 구현**: `mempalace/searcher/ranking.py:_hybrid_rank` (170-235), `:85-104`, `searcher/sqlite_bm25.py:_merge_bm25_union_candidates` (`candidate_strategy="union"`)

## 결정 (2026-11-01)

사용자 결정으로 이번 작업은 **측정 기반만 먼저** 만든다.

- **진행 (승인됨).** §12-5, 즉 #119 해결이다.
  - `selectHookInjection` 추출 (동작 바이트 동일, golden 테스트로 고정)
  - store 사본 반사실 replay 도구와 CI fixture 모드
  - store 사본 3개에서 현재 동작, #121, #125, 둘 다 켬을 비교한 집계
- **보류 — 측정 결과를 보고 다시 결정.**
  - 후보 합집합 (§2)
  - 후보 풀 BM25 재채점 (§3.1)
  - 레인 공통 척도와 가중치 (§3.2, §3.3)
  - 임계값 통일 (§4)
  - 데몬 프로토콜 확장 (§2.2, §6)
- **보류 근거.** §1.3의 Spearman 표다. 어휘(풀 BM25)와 벡터 중 어느 쪽이 grounding을 더 잘 구분하는지가 store마다 뒤집힌다(A·C 대 B). 그래서 결합 방식과 가중치를 정할 근거가 아직 없다. 훅 경로 replay로 먼저 측정한 뒤 다시 결정한다.

아래 §2~§7은 보류된 원안을 기록으로 남긴 것이다.

목표 지표는 `content_overlap_score`(grounding) 하나다. 주입 건수나 후보 수는 보조 관측값으로만 쓰고, 목표로 삼지 않는다.

## 0. 요약

- **문제.** 프롬프트 레인 점수 네 가지는 척도가 서로 다르다. 그런데 훅은 이 점수들을 `max`로 고르거나 덮어써서 합친다. 실측해 보니 세 store에서 일관되게 grounding을 구분하는 점수가 하나도 없다.
  - 현재 점수: FTS 상대 점수는 1등이 언제나 1.0이다.
  - 벡터 점수: `(1+cos)/2`가 0.92~1.0에 몰려 있다.
  - graduated 점수: 어휘 커버리지에 사전 가중치를 더한 값이다.
- **실측 근거.** 과거에 주입된 기억과 그 `content_overlap_score` 사이의 Spearman 상관을 store 3개에서 쟀다 (§1.3).
  - 현재 점수: 0.03 / 0.21 / 0.10
  - 벡터: 0.01 / 0.25 / 0.00
  - 후보 풀 BM25 (`s/ideal`): 0.27 / 0.08 / 0.27
  - hybrid (wv=0.6): 0.07 / 0.23 / 0.05
  - **어느 신호도 세 store에서 일관되게 앞서지 않는다.** 그래서 이 설계는 가중치를 오프라인 표본으로 정하지 않는다. 결합 구조와 측정 경로를 먼저 만들고, 가중치는 훅 경로 replay(§8)로 정한다.
- **제안 1: 후보 합집합.** 순차 폴백(FTS 먼저, 부실할 때만 벡터)을 걷어 내고, 같은 단계에서 FTS 후보와 벡터 후보를 합친다.
- **제안 2: 후보 풀 BM25 재채점.** 합친 후보 집합 안에서 IDF로 BM25를 다시 계산한다. 정규화는 REF의 `s/max`가 아니라 쿼리 기준 이상값(`s/ideal`)으로 한다. `s/max`는 #121이 지적한 "1등은 항상 1.0" 문제를 그대로 가진다.
- **제안 3: 공통 척도.** 벡터 점수를 절대 구간으로 보정하고, 어휘 점수와 가중 합산해 한 척도로 만든다. 훅은 이 척도 하나와 임계값 하나로 판정한다.
- **플래그.** 모두 `CLAUDE_MEMORY_HYBRID_LANE_SCORING_EXPERIMENT=true` 뒤에 둔다. 꺼져 있으면 훅 stdout, trace 행, 데몬 응답이 바이트 단위로 기존과 같아야 하고, 테스트로 고정한다.
- **효과 측정.** 훅 경로를 그대로 재생하는 store 사본 replay를 만들어 #119를 해결한다. 그 위에서 반사실(counterfactual) `content_overlap_score`로 판정한다 (§8).

## 1. 현재 레인별 점수 분포 (store 사본, 집계만)

### 1.1 측정 방법

- **대상.** 프로젝트 store 3개의 `events.sqlite`를 `.backup`으로 복사했고, `vectors/`도 함께 복사했다.
  - A = 이 저장소 (N=5,314)
  - B (N=13,917)
  - C (N=14,368)
  - 사본은 측정 직후 삭제했다. 원문은 남기지 않았다.
- **쿼리.** `retrieval_traces`에서 `trigger_type='user_prompt' AND delivery_client='claude-hook'`인 `query_text`를 시간순으로 균등 표본 추출했다. A는 120개, B와 C는 각 80개다.
- **미래 누출 방지.** 매 쿼리마다 trace 시각 이전의 이벤트만 쓴다. 벡터 결과도 시각으로 사후 필터한다.
- **레인 재현.**
  - keyword: 훅과 같은 SQL이다. `includeToolObservations`, LIMIT 50을 쓴다. 상대 점수(현재)와 절대 점수(#121, `x/(x+15)`)를 둘 다 계산했다.
  - vector: 실제 `Xenova/multilingual-e5-small`로 쿼리를 임베딩하고, 복사한 LanceDB에서 top 15를 검색했다. 점수는 `VectorStore.search`와 같은 `1-d/2`이고, 이는 `(1+cos)/2`와 같다.
  - graduated: 훅과 같은 SQL에 실제 `scoreGraduatedEvidence`를 적용했다.
- **합집합 시뮬레이션.**
  - 후보 풀은 vector top 15와 FTS 답변형 top 15를 합친 것이다. `tool_observation`은 지금처럼 seed 전용으로 남겨 풀에서 뺐다.
  - FTS에만 있는 후보는 LanceDB `eventId IN (...)` 필터 검색으로 벡터 점수를 구했다.
- **grounding 대조.** `memory_helpfulness`에서 `content_overlap_score`가 있는 주입 기억을 해당 trace의 후보 풀에 넣고 같은 척도로 채점했다. 이 표본은 이미 주입된 것만 있으므로 선택 편향이 있다 (§1.4).

### 1.2 분포

| 레인 / 점수 | A p10 / p50 / p90 | B p10 / p50 / p90 | C p10 / p50 / p90 |
|---|---|---|---|
| keyword 상대(현재), 전체 | 0.007 / 0.096 / 0.561 | 0.004 / 0.107 / 0.855 | 0.007 / 0.114 / 0.876 |
| keyword 상대(현재), **top1** | **1.000 / 1.000 / 1.000** | 1.000 / 1.000 / 1.000 | 1.000 / 1.000 / 1.000 |
| keyword 절대(#121), top1 | 0.495 / 0.899 / 0.983 | 0.553 / 0.950 / 0.987 | 0.692 / 0.965 / 0.986 |
| vector `(1+cos)/2`, 전체 top15 | 0.939 / 0.959 / 0.984 | 0.935 / 0.966 / 1.000 | 0.952 / 0.973 / 1.000 |
| vector, top1 | 0.948 / 0.973 / 1.000 | 0.944 / 0.974 / 1.000 | 0.960 / 0.981 / 1.000 |
| vector, FTS에만 있는 후보 | 0.921 / 0.938 / 0.957 | 0.917 / 0.945 / 0.979 | 0.927 / 0.956 / 0.972 |
| graduated (`scoreGraduatedEvidence`) | 0.568 / 0.672 / 0.879 | 0.596 / 0.765 / 0.926 | 0.602 / 0.687 / 0.980 |
| 후보 풀 BM25 `s/max`(REF), top1 | 1.000 / 1.000 / 1.000 | 1.000 / 1.000 / 1.000 | 1.000 / 1.000 / 1.000 |
| 후보 풀 BM25 `s/ideal`(제안), top1 | 0.050 / 0.333 / 0.675 | 0.082 / 0.373 / 0.712 | 0.048 / 0.293 / 0.637 |
| 후보 풀 BM25 `s/ideal`(제안), 전체 | 0.000 / 0.010 / 0.247 | 0.000 / 0.049 / 0.634 | 0.000 / 0.000 / 0.268 |
| 합집합 크기 | 15 / 23 / 29 | 16 / 21 / 29 | 15 / 22 / 28 |
| 합집합 중 FTS에만 있는 비율 | 0.11 / 0.41 / 0.50 | 0.14 / 0.48 / 0.81 | 0.10 / 0.36 / 0.72 |

trace에 기록된 최종 점수(`retrieval_trace_items.score`)도 따로 집계했다. 선택된 항목의 평균은 A 0.90, B 0.94, C 0.94이고, 최솟값은 세 store 모두 0.65다. 즉 선택된 항목이 주입 임계값 바로 위에 몰려 있지 않고 꼭대기에 붙어 있다.

### 1.3 grounding과의 관계 (주입된 기억, Spearman)

| 신호 | A (n=266, grounded 43) | B (n=709, grounded 254) | C (n=704, grounded 159) |
|---|---|---|---|
| 현재 기록 점수 (`retrieval_score`) | 0.030 | 0.205 | 0.096 |
| vector `(1+cos)/2` | 0.013 | **0.249** | 0.004 |
| BM25 `s/max` (REF) | 0.057 | -0.042 | 0.113 |
| BM25 `s/ideal`, 상위 12 term (제안) | **0.272** | 0.078 | **0.265** |
| IDF 가중 커버리지 (tf 미반영) | 0.261 | 0.077 | 0.259 |
| hybrid 0.4·vcal + 0.6·lex | 0.077 | 0.188 | 0.048 |
| hybrid 0.6·vcal + 0.4·lex (REF 가중) | 0.068 | 0.225 | 0.046 |

`memory_helpfulness.retrieval_score` 구간별 평균 overlap도 store마다 다르다.

| 구간 | A | B | C |
|---|---|---|---|
| 0.65~0.8 | 0.127 | 0.165 | 0.089 |
| 0.8~0.9 | 0.159 | 0.139 | 0.080 |
| ≥ 0.9 | 0.093 | 0.226 | 0.156 |

A에서는 점수와 overlap의 관계가 거꾸로이고, B와 C에서는 약하게 정방향이다. 주입 건의 80~87%가 0.9 이상 구간에 몰려 있어, 이 구간 안에서는 점수로 구분하기 어렵다.

### 1.4 해석과 한계

1. **벡터 점수의 범위는 좁고, store마다 위치가 다르다.**
   - 범위가 0.92~1.0으로 좁아서, 훅의 `semanticMinScore` 0.65와 데몬에 넘기는 `minScore` 0.4는 사실상 필터 역할을 하지 못한다.
   - FTS에만 있는 후보의 p50도 store마다 다르다(A 0.938, B 0.945, C 0.956). 고정 구간으로 보정하면 store마다 효과가 달라진다 (§3.2 리스크).
   - 판별력도 store마다 다르다. B에서는 0.25로 가장 강한 신호였고, A와 C에서는 0에 가까웠다.
2. **"1등 = 1.0" 문제는 세 곳에 있다.** keyword 상대 점수, REF 방식의 `s/max`, 그리고 retriever `searchByKeyword`의 순위 점수(`1-idx*0.04`)다. 정규화는 반드시 쿼리 기준 절대값이어야 한다.
3. **#121 절대 점수도 top1 p50이 0.90이다.** 훅 쿼리는 이전 턴으로 보강되고 p50이 500자나 되어, 흔한 term의 기여가 쌓이기 때문이다. 이 부분은 #121의 한계로 이미 기록되어 있다.
4. **선택 편향과 store 간 불일치.**
   - 상관은 이미 주입된 기억 안에서만 잰 것이라 순위 전체의 품질을 보여 주지 못한다.
   - 어휘 신호와 벡터 신호의 우열이 store마다 뒤집힌다 (A, C 대 B).
   - 그래서 가중치를 이 표로 정하지 않고 §8 replay로 정한다.
   - 이 표에서 확실히 말할 수 있는 것은 두 가지뿐이다.
     - REF식 `s/max`와 현재 FTS 상대 점수는 top1이 항상 1.0이라 주입 판정 신호로 쓸 수 없다.
     - 쿼리 기준 정규화(`s/ideal`)는 top1 p50이 0.29~0.37로 퍼져 있어 임계값을 둘 수 있는 척도다.
5. **어휘 혼입.** `content_overlap_score`는 스니펫 토큰 겹침이다. 그래서 쿼리 term을 그대로 되풀이하는 응답에서는 쿼리와 어휘가 겹치는 기억이 유리하다. §8에서 쿼리 term을 제거한 보조 지표로 이 효과를 분리한다.

## 2. 후보 합집합 — 보류

### 2.1 retriever (데몬, MCP, 서버 공통)

`RetrievalOptions.candidateStrategy?: 'sequential' | 'union'`을 추가한다. 기본값은 `'sequential'`이고 현재 동작 그대로다. retriever는 env를 읽지 않고, 호출자가 옵션을 정한다.

`strategy: 'auto'`이면서 `candidateStrategy: 'union'`일 때 Stage 1과 Stage 2를 다음과 같이 바꾼다. Stage 3(scope 확장)과 Stage 4(summary)는 지금처럼 폴백으로 남긴다.

1. FTS와 쿼리 임베딩을 병렬로 시작한다.
   - FTS는 `keywordSearch(query, topK*3)`이고, 답변형만 받는다. 여기서 FTS rank는 쓰지 않는다. 순위는 재채점이 정한다.
   - 쿼리 임베딩이 끝나면 `vectorStore.search(limit topK*3, minScore 0)`을 실행한다.
2. FTS에만 있는 후보의 벡터 점수를 구한다. 새 메서드 `VectorStore.scoreEventIds(vector, ids)`를 쓴다. 이 메서드는 `\`eventId\` IN (...)` 필터를 건 cosine 검색이다.
   - 임베딩이 아직 대기 중이라 결과가 없는 후보는 "벡터 미상"으로 표시한다 (§3.3).
3. 후보를 `eventId` 기준으로 중복 제거해 합친다. 출처 레인은 `lanes` 디버그에 `hybrid_union`과 `fts` / `vector`로 남긴다.
4. 합집합 전체를 §3의 공통 척도로 채점한다. 이 결과가 `rerankByKeywordOverlap`을 대체한다. 어휘 신호를 두 번 반영하지 않기 위해서다.
   - recency 가중과 decay penalty는 지금 식을 그대로 둔다: `(hybrid·(sw+lw) + recency·rw)/total`.
5. 이후 graph, session 확장, scope 필터, 품질 필터는 지금 그대로 지나간다. 확장 결과는 seed 점수를 상속하므로 같은 척도에 머문다.
6. 결과 객체에는 다음 값을 싣는다.
   - `score`: hybrid
   - `semanticScore`: 보정된 벡터 점수
   - `lexicalScore`: 풀 BM25 점수
   - `vectorKnown`: 벡터 점수 유무
   - 저신뢰 선택 게이트(`>= 0.62`/`0.5`)는 `semanticScore ?? score`가 아니라 `score`(hybrid)에만 적용한다.
   - Stage 2(deep 폴백)는 합집합에 이미 포함되어 있으므로 건너뛴다.
7. **열화 처리.** 임베더나 벡터 스토어가 실패하면 그 쿼리는 기존 sequential 경로로 처리한다. `fallbackTrace`에는 `hybrid:degraded`를 남긴다.

### 2.2 훅 (`user-prompt-submit.ts`)

플래그가 켜졌을 때만 다음 순서로 동작한다. 꺼져 있으면 지금 코드 경로 그대로다.

1. 프로세스 내 레인을 먼저 실행한다.
   - keyword: 지금과 같이 LIMIT 50이고 `tool_observation`을 포함한다. `minScore` 필터는 적용하지 않는다.
   - graduated: FTS로 L1 이상만 뽑는다.
   - lesson: 기존 순서와 동작 그대로다.
   - 지금도 데몬 호출 → 프로세스 내 레인 순서의 순차 실행이므로, 순서를 바꿔도 지연은 늘지 않는다.
2. 데몬 `retrieve` 요청에 두 필드를 추가한다.
   - `candidateStrategy: 'union'`
   - `scoreEventIds`: keyword 답변형 후보와 graduated 후보의 id. 최대 64개다.
3. 데몬은 retriever 합집합 결과와 `vectorScores: Record<id, number>`를 돌려준다.
   - 원시 `(1+cos)/2` 값을 돌려준다. 요청한 id와 자신이 돌려준 기억이 모두 포함된다.
   - 플래그 판단은 요청 필드로 한다. 데몬은 오래 사는 프로세스라 기동 시점의 env가 훅 env와 다를 수 있기 때문이다.
4. 훅 풀은 semantic, keyword, graduated 후보의 합집합이다. id로 중복 제거하고 `source`는 처음 들어온 레인으로 유지한다.
   - 이 풀 전체를 §3 함수로 한 번 더 채점한다. 이 IDF 풀이 주입 판정의 기준이다.
   - 데몬이 자기 풀에서 계산한 hybrid 점수는 데몬 안의 순위 결정에만 쓴다.
5. episode seed 선정, `expandEpisodeEvidence`의 점수 상속, `rankHookCandidates`의 가산 보너스, cliff, answerability gate는 로직을 바꾸지 않는다. 입력 점수만 hybrid로 바뀐다.
6. **lesson 레인은 범위 밖이다.** lesson은 이벤트가 아니어서 임베딩이 없고, 자체 어휘 점수(0.5~0.98)와 `reserveLessonSlot`이 있다. 따라서 그대로 둔다. lesson과 이벤트 사이의 척도 차이는 남는 문제로 기록한다 (§11).
7. **열화 처리.** 아래 경우에는 그 프롬프트만 기존 병합으로 처리하고, trace diagnostics에 `scoringMode: 'legacy-degraded'`를 남긴다.
   - 데몬이 타임아웃되거나 실패했다.
   - 응답에 `vectorScores`가 없다. 이는 구버전 데몬이라는 뜻이다.

## 3. 후보 풀 BM25 재채점과 공통 척도 — 보류

순수 함수 모듈 `src/core/hybrid-lane-scoring.ts`를 새로 만든다. retriever와 훅이 같은 함수를 쓴다. 어댑터에서 import하지 않으므로 core 경계를 지킨다.

### 3.1 어휘 점수 `lexicalPoolScores(query, docs)`

- **토크나이저.** 소문자화와 camelCase 분리를 한다. 식별자는 전체 토큰과 함께 `_ . / # -`로 나눈 부분 토큰도 쓴다. 2자 미만은 버리고, 한국어 조사를 제거한다(`prompt-injection-policy.ts`의 `KOREAN_PARTICLE_SUFFIX`와 같은 규칙).
  - 조사 규칙은 core로 옮기고 정책 모듈은 그것을 import한다. 정책 모듈이 core를 import하는 방향이므로 경계를 지킨다. 이 이동은 구조 변경 커밋으로 분리한다.
- **BM25.** Okapi BM25로 k1=1.2, b=0.75다. IDF는 후보 풀 안에서 `ln((N-df+0.5)/(df+0.5)+1)`로 계산한다. 이 식은 음수가 되지 않으며 REF와 같다.
- **상위 M개 term만 쓴다 (M=12).** 풀에 한 번이라도 나온 쿼리 term 중 IDF가 높은 순으로 12개만 채점과 정규화에 쓴다. M=12는 `selectHookEpisodeSeeds`의 `min(queryTerms, 12)`와 맞춘 값이다.
  - 이렇게 하면 긴 쿼리(#125가 꺼진 경우 43%)에서 흔한 term 기여가 쌓이는 문제와 커버리지 희석 문제를 함께 막는다.
- **정규화는 `s/ideal`이다.** `ideal = Σ_{top-M} idf(t) · (k1+1)`이고, 결과는 [0,1]로 자른다.
  - 쿼리 기준이라 1등이라는 이유만으로 1.0이 되지 않는다. 실측에서 top1 p50은 0.33이다.
  - 후보 풀이 바뀌면 IDF가 바뀌므로 완전히 독립적이지는 않다. 그래도 다른 후보의 점수에 정규화되지는 않는다.
- **REF와 다르게 한 점.** REF는 `s/max`로 정규화한다. 실측에서 top1이 언제나 1.0이었고 grounding 상관은 0.057이었다. 그래서 따르지 않았다.

### 3.2 벡터 보정 `calibrateVectorScore(s)`

- 식은 `clamp((s - L) / (H - L), 0, 1)`이고, 입력 `s`는 `(1+cos)/2`다.
- **L.** FTS에만 있는 후보 벡터 점수 p50의 세 store 중앙값인 **0.945**로 잡는다(A 0.938, B 0.945, C 0.956). "어휘로는 걸렸지만 의미상 먼 후보"를 0에 놓는다는 뜻이다.
- **H.** 정확히 같은 텍스트(1.0)를 뺀 top1 p90 근처로 잡는다. 초기값은 **0.995**다.
- 절대 구간 보정이므로 후보가 추가되거나 빠져도 다른 후보의 벡터 점수는 변하지 않는다. 이 성질은 REF와 같다.
- **리스크.** 분포 위치가 store마다 0.02가량 다르다. 구간 폭이 0.05이므로 이 차이는 보정값으로 약 0.4나 된다.
  - replay에서 L을 {0.935, 0.945, 0.955}로 바꿔 민감도를 본다.
  - 민감도가 크면 store별 보정값이 필요하다. 예를 들어 store의 FTS 전용 후보 p50을 주기적으로 측정해 저장하는 방식이다. 이 경우 별도 설계로 넘기고, 이번 범위에는 넣지 않는다.

### 3.3 결합 `hybridScore`

- 식은 `hybrid = wv · v + wl · lex`이고, `wv + wl = 1`이다.
- **가중치는 replay로 정한다. 구현에는 자리표시 값 wv=0.5를 넣는다.**
  - §1.3에서 어휘와 벡터의 우열이 store마다 뒤집혀서, REF 기본값(0.6/0.4)도 그 반대도 근거가 없다.
  - replay에서 `wv ∈ {0, 0.2, 0.4, 0.6, 0.8}`를 store별로 비교한다.
    - wv=0(어휘만)은 대조군이다. 이때 벡터는 후보를 공급하는 역할만 하고, 어휘 점수가 0인 벡터 전용 후보는 통과하지 못한다. 의미가 비슷한 다른 표현을 찾는 recall이 그만큼 줄어든다.
  - **결정 규칙.** 세 store 모두에서 baseline 대비 1차 지표가 나빠지지 않는 값 중, 개선 폭의 최솟값이 가장 큰 값을 고른다. 평균이 가장 큰 값이 아니라 최악의 store 기준으로 고른다.
  - store마다 결과가 갈려서 이 규칙을 만족하는 값이 없으면, 기본값을 켜는 후보에서 탈락한다. 그때는 결합 대신 다른 접근(store별 보정 등)을 별도로 설계한다.
- **벡터 미상 후보.** 해당하는 경우는 두 가지다.
  - `tool_observation`: 임베딩 정책상 처음부터 제외된다.
  - 임베딩 outbox 대기 중인 최신 이벤트.
  - 이런 후보는 `hybrid = lex`로 가중치를 재정규화한다. REF는 `distance=None`일 때 벡터 기여를 0으로 둔다. 그러면 위의 두 부류가 구조적으로 불이익을 받는다. 최신 이벤트는 continuation 질문의 핵심 근거라서 그 불이익을 피했다.
  - 이 선택의 리스크는 어휘 점수만으로 상위에 오르는 경우다. replay에서 `vectorKnown=false` 비율과 그 후보들의 overlap을 따로 보고한다.

## 4. 기존 임계값 재보정 — 보류

| 임계값 | 현재 | 플래그 켜짐 |
|---|---|---|
| 훅 레인 입장 `minScore` (동적 0.35/0.4/0.5), `FALLBACK_MIN_SCORE` 0.3 | keyword 레인 FTS 점수에 적용 | **적용 안 함.** 합집합은 FTS top-N을 점수와 무관하게 받고 재채점이 판정한다. |
| 데몬에 넘기는 `minScore` → `vectorStore.search` | 0.4 (실측상 전부 통과) | 0. 판정은 hybrid로 한다. |
| `semanticMinScore` / `keywordMinScore` / `fallbackKeywordMinScore` (0.65/0.7/0.8) | 출처별로 다름 | **이벤트 후보에 단일 임계값** `CLAUDE_MEMORY_HOOK_HYBRID_MIN_SCORE`를 적용한다. lesson은 기존 `semanticMinScore`를 유지한다. |
| retriever 품질 cliff (`top ≥ 0.8`이면 `top-0.25` 미만 제거), 저신뢰 게이트 0.62 | blended 척도 | hybrid 척도. 같은 수치로 시작하고 replay에서 확인한다. |
| 훅 score cliff gap 0.08, 가산 보너스 (type, level, episode +0.42/+0.12) | 0.65~1.0대 척도에 맞춰 조정됨 | 값을 바꾸지 않는다. 단일 임계값을 분위수 정합으로 잡으면 상위 구간 척도가 비슷해진다. 그래도 replay에서 cliff 발동률을 비교한다. |
| `summarizeHookInjectionConfidence` 0.8/0.65 | trace 라벨 | 같은 분위수 정합으로 변환한 컷을 쓴다. 텔레메트리 전용이다. |

**단일 임계값의 초기값은 분위수 정합(quantile matching)으로 정한다.**

1. store 사본 replay(§8)에서, 플래그를 끈 상태로 훅 후보 중 주입 임계값을 통과하는 비율 p를 구한다.
2. hybrid 점수 분포에서 같은 비율 p가 통과하는 값을 초기 임계값으로 정한다.
3. 이렇게 하면 첫 비교에서는 "주입 양"을 고정한 채 "무엇을 주입하는가"만 바뀐다. 두 변수를 한 번에 바꾸지 않기 위해서다.
4. 그다음 임계값 grid(초기값 ±0.05, ±0.1)를 grounding으로 비교한다. 주입 건수는 목표가 아니라 보고값이다.

## 5. 훅 지연 예산 — 보류

### 5.1 실측 (A store 사본, 로컬, 쿼리 181개, 데몬 상주 가정)

B와 C는 두 측정을 동시에 돌려 CPU 경합이 있었다. 그래서 아래 표는 단독으로 측정한 A 기준이다. B와 C는 상한 참고값으로만 적는다.
- 벡터 검색 p50: B 135 ms, C 75 ms
- id 점수 p50: B 133 ms, C 69 ms
- FTS p90: B 3.0 s, C 2.9 s

| 단계 | p50 | p90 | 비고 |
|---|---|---|---|
| FTS (훅 SQL) | 50 ms | 605 ms | 이미 지금 비용이다. 최대 36 s는 긴 OR 쿼리 때문이다 (#136). |
| 쿼리 임베딩 (상주 모델) | 39 ms | 133 ms | 첫 호출(모델 로드)은 0.7~1.4 s. 데몬이 상주하면 흡수된다. |
| 벡터 top 15 검색 | 36 ms | 63 ms | |
| id 필터 벡터 점수 (`scoreEventIds`) | 31 ms | 46 ms | |
| 풀 BM25 재채점 (후보 ~23개) | 2.4 ms | 11.7 ms | |

### 5.2 예산

- **추가 비용.** 지금 데몬의 `auto` 경로는 FTS가 충분하면 임베딩하지 않는다. 합집합은 매번 임베딩하고 벡터 검색을 한다.
- **병렬화.** FTS와 임베딩을 병렬로 시작한다. 벡터 top-K 검색과 id 점수 검색도 `Promise.all`로 묶는다.
- **id 점수 구현 방식.** 실측에서 `eventId IN (...)` 필터를 건 벡터 검색은 일반 검색과 비용이 비슷했다(A 31 ms 대 36 ms). 필터를 걸어도 결국 전체를 훑는 검색이기 때문이다.
  - 그래서 `scoreEventIds`는 벡터 검색을 하지 않는다. `query().where(...).select(['eventId','vector'])`로 저장된 벡터를 직접 읽고, cosine은 프로세스 안에서 계산한다. REF의 `_lexical_hit_vector_distances`와 같은 방식이다.
  - 2단계에서 이 방식의 비용을 측정해 PR에 적는다.
  - 예상 추가분은 p50 약 75 ms(임베딩과 검색의 임계 경로), p90 약 200 ms다.
- **예산.** 플래그를 켰을 때 UserPromptSubmit 벽시계 시간이 꺼졌을 때보다 **p50 +150 ms, p90 +300 ms**를 넘지 않아야 한다. replay와 실사용 trace로 확인한다.
  - 넘으면 기본값을 켜는 후보에서 탈락한다.
- **상한.** `SEMANTIC_TIMEOUT_MS`(2,000 ms)는 바꾸지 않는다. 초과하면 §2.2-7 열화로 그 프롬프트만 기존 병합으로 처리한다.
- **텔레메트리.** 플래그가 켜졌을 때만 `retrieval_diagnostics_json`에 `hybridTimings: { fts, embed, vector, scoreIds, rescore }`(ms)를 남긴다. 꺼져 있을 때 trace 바이트가 바뀌지 않게 하려는 것이다.

## 6. 플래그 설계와 조합 — 보류

- **이름.** `CLAUDE_MEMORY_HYBRID_LANE_SCORING_EXPERIMENT`. `=== 'true'`일 때만 켜지고, 호출 시점에 읽는다. 기존 `_EXPERIMENT` 관례(#121, #125, `CLAUDE_MEMORY_LESSON_HYBRID_EXPERIMENT`)와 같다.
- **env를 읽는 곳.** 어댑터 두 곳뿐이다.
  - 훅: 데몬 요청에 `candidateStrategy: 'union'`을 실을지 결정한다.
  - MCP/서버의 retriever 호출부: `candidateStrategy`를 정한다.
  - core는 옵션만 받는다.
- **함께 추가하는 env.** `CLAUDE_MEMORY_HOOK_HYBRID_MIN_SCORE` 하나다. 기존 `CLAUDE_MEMORY_HOOK_*_MIN_SCORE`와 같은 형식이다.
  - 가중치(wv)와 보정 구간(L, H)은 env로 노출하지 않는다. replay 하네스가 옵션으로 직접 주입한다. 요청되지 않은 설정 가능성은 넣지 않는다는 원칙에 따른 것이다.

| hybrid | #121 abs | #125 sanitizer | 동작 |
|---|---|---|---|
| off | off | off | 현재 동작 (바이트 동일) |
| off | on | * | #121 그대로. keyword 레인 FTS 점수만 절대 척도가 된다. |
| off | * | on | #125 그대로. 쿼리만 정리된다. |
| **on** | off/on | off | 훅 주입 판정은 hybrid가 정한다. keyword 레인 FTS 점수는 입장 필터에도 판정에도 쓰이지 않으므로 **#121은 훅 경로에서 효과가 없다.** `keywordSearch`를 직접 쓰는 MCP `mem-search` fast 경로와 chat API에는 #121이 그대로 적용된다. 긴 쿼리는 상위 12 term 제한으로만 방어한다. |
| **on** | * | **on** | **권장 조합.** 정리된 쿼리가 FTS term, 임베딩 입력(앞 2,000자 절단 회피), 풀 BM25에 공통으로 쓰인다. 두 플래그는 직교하며 서로의 코드 경로를 바꾸지 않는다. |

- **데몬과 훅 버전이 어긋날 때.**
  - 구 데몬: 새 요청 필드를 무시하므로 응답에 `vectorScores`가 없고, 훅이 열화 경로로 처리한다.
  - 새 데몬: 필드가 없는 구 요청에는 기존 응답을 그대로 돌려준다. 이 경우도 응답 바이트가 같음을 테스트로 고정한다.

## 7. 플래그 꺼짐 = 바이트 동일 (2단계 테스트 계획) — 보류

- **훅.** 다음 세 경우에 대해, 플래그 미설정·`'1'`·`'false'`일 때 stdout과 `recordQueryTrace`/`recordRetrieval` 호출 인자가 기존과 **Buffer 단위로 같아야** 한다. #125의 `claude-hook-adherence` 테스트와 같은 방식이다.
  - 레인 셋(semantic, keyword, graduated)이 겹치는 fixture
  - 데몬이 없는 경우
  - 짧은 프롬프트와 긴 프롬프트
- **데몬.** `candidateStrategy`가 없는 요청의 응답 JSON이 바이트 단위로 같아야 한다.
- **retriever.** `candidateStrategy`가 미지정이거나 `'sequential'`일 때 `retrieve()` 결과(`memories`, `fallbackTrace`, `selectedDebug`, `candidateDebug`)의 직렬화 값이 같아야 한다. fake embedder와 vector store로 확인한다.
- **구조 변경 커밋(§9-1, 9-2)** 전후로 위 golden 테스트가 원본 코드에서도 통과하는지 확인한다. #121과 같은 절차다.

## 8. 효과 측정: #119 해결

### 8.1 훅 경로 replay (#119의 핵심) — 구현됨

1. **구조 변경.** `main()`에서 "레인 수집 → 병합 → episode → 선택"을 `selectHookInjection(deps, input)`으로 추출했다.
   - `deps`는 `memoryService`(5개 메서드)와 `retrieveSemantic`이다. `main()`은 데몬을, replay는 프로세스 내 retriever를 넘긴다.
   - stdin 읽기, 쿼리 생성, 저장, 텔레메트리 기록은 `main()`에 남겼다.
   - 추출 전에 golden 테스트(`tests/adapters/claude-hook-injection-selection-golden.test.ts`)로 stdout과 레인·텔레메트리 호출 인자를 고정했다. 추출 후에도 바이트 단위로 같다.
2. **`src/adapters/claude/hooks/hook-grounding-replay.ts`와 `scripts/replay-hook-grounding.ts`.**
   - **입력.** store 사본 디렉터리(`events.sqlite`, semantic 레인용 `vectors/`)다. 읽기 전용으로 연다.
   - **turn 재구성.** `delivery_client='claude-hook'`, `presentation_mode='evidence'`인 user_prompt trace를 읽는다.
     - 프롬프트: trace의 `raw_query_text`(저장된 redact 본문)
     - adherence turn과 reason: 훅이 검색 직후 저장한 user_prompt 이벤트의 `metadata.adherence`.
       - 너무 짧아 저장되지 않은 프롬프트는 직전에 저장된 프롬프트의 turn+1로 추정하고, reason은 `shouldRunAdherenceCheck`로 재구성한다.
       - 추정한 turn 수를 보고서에 적는다.
     - 이전 프롬프트와 직전 응답 500자(2시간 이내)
       - 자동 알림에 대한 응답(`turnTrigger`가 `user`가 아님)은 제외한다. Stop이 그 응답으로는 발췌를 갱신하지 않기 때문이다.
     - 이것으로 훅의 `buildRetrievalQuery`를 다시 실행한다. #125도 이 경로에서 재현된다.
   - **시각 경계.** 각 trace 시각 이후의 이벤트는 레인에서 보이지 않는다.
     - FTS 레인(keyword, graduated): 원시 rank 행을 "그 시각 이후 이벤트 수"만큼 더 받아 거른다. 그러면 처음 `limit`개가 당시 훅이 받은 목록과 정확히 같다. 정규화는 실제 `MemoryQueryService`가 한다. #121 경로도 그대로 재현된다. 프로덕션 SQL은 고치지 않았다.
     - episode 확장(`getEventsByTurn`, `expandDisclosure`)도 같은 시각으로 거른다.
     - lesson: trace 시각 이후에 만들어진 lesson은 제외한다.
     - semantic: 데몬과 같은 옵션으로 프로세스 안에서 retriever를 돌린다. 호출하는 동안 retriever의 이벤트 store와 벡터 store를 같은 시각 경계 래퍼로 바꿔 끼운다. 그래서 폴백과 순위 결정도 미래 이벤트를 보지 못한다. 최종 결과를 한 번 더 거르는 검사는 남겨 두고 그 건수를 보고한다(0이어야 한다).
   - **채점.** 선택된 기억의 주입 발췌(`memoryEvidencePreview`)를 그 세션의 이후 agent_response 전체와 `computeMemoryUsageEvidence`로 비교한다. 운영 평가기(`evaluateRetrievalRows`)와 같은 함수다.
     - 기준 시각은 검색 직후 저장된 프롬프트 이벤트의 시각이다. 평가기의 `delivered_at` 바로 전 시점이다.
     - 프롬프트가 저장되지 않았으면 trace 시각 +1초를 쓴다. trace 시각은 초 단위라, 같은 초 안의 이전 응답이 섞이지 않게 하려는 것이다.
   - **arm.** current, #121 켬, #125 켬, 둘 다 켬이다. 플래그는 호출 시점에 읽히므로 같은 프로세스에서 env를 바꿔 가며 돌리고, 끝나면 원래 값으로 되돌린다.
   - **출력.** 집계값만 낸다. 원문, 쿼리, id, 프로젝트 hash는 출력하지 않는다(`--label`로 이름을 붙인다). markdown과 JSON 모두 반사실 편향과 근사 항목을 포함한다.
   - **충실도 지표.** current arm이 당시 기록된 쿼리와 선택을 얼마나 재현하는지 함께 보고한다.
3. **fixture 모드.** `benchmarks/replay/hook-grounding-fixture-v1.json`을 실제 `SQLiteEventStore`(FTS5)에 적재한 뒤, store 모드와 같은 경로로 돌린다. 임베더는 쓰지 않는다(semantic off).
   - 다음 7개 turn이 들어 있다. 정상 회수, 긴 프롬프트 3종(로그 뒤 질문, 요청 뒤 로그, 스펙형), trace 이후에 쓰인 답변 함정, 그 답변을 이후에 회수하는 turn, 당시 주입이 없던 turn.
   - 테스트(`tests/adapters/hook-grounding-replay.test.ts`)가 확인하는 것:
     - 쿼리 재구성 100%
     - 미래 이벤트와 미래 lesson 차단 (대조군 포함)
     - arm별 플래그 효과
     - 플래그 원복
     - store 무변경
     - 보고서에 원문과 id가 없음
     - 보고서 snapshot
   - 실행: `npm run eval:hook-replay`

### 8.1.1 실측 (2026-11-01, store 사본 3개, 각 120 turn, semantic=retriever, 집계만)

교차 리뷰 반영 후의 도구로 측정했다. semantic 레인에도 시각 경계를 적용했고, 시각 경계 검사는 세 store 모두 0건이었다. 사본은 측정 직후 삭제했다.

**충실도.** current arm이 당시 기록을 얼마나 재현했는지다.

| | A | B | C |
|---|---|---|---|
| 쿼리 재현 | 100.0% | 98.3% | 97.5% |
| 선택 재현 | 86.7% | 78.3% | 80.8% |
| adherence를 추정한 turn | 8 | 7 | 7 |

**기억당 평균 overlap, 전체 turn.** current에 유리하게 편향되어 있다. 괄호는 bootstrap 95% CI다.

| arm | A | B | C |
|---|---|---|---|
| current | 0.179 (0.129–0.231) | 0.224 (0.172–0.281) | 0.188 (0.148–0.232) |
| #121 | 0.135 (0.098–0.174) | 0.210 (0.164–0.257) | 0.191 (0.158–0.223) |
| #125 | 0.160 (0.120–0.210) | 0.214 (0.161–0.272) | 0.128 (0.096–0.166) |
| #121+#125 | 0.157 (0.109–0.204) | 0.180 (0.133–0.231) | 0.144 (0.110–0.180) |

**주입된 기억 수 / grounded 기억이 있는 turn 비율.**

| arm | A | B | C |
|---|---|---|---|
| current | 215 / 43.3% | 227 / 51.5% | 266 / 45.8% |
| #121 | 396 / 44.7% | 330 / 60.0% | 422 / 57.7% |
| #125 | 198 / 44.2% | 163 / 44.6% | 240 / 41.8% |
| #121+#125 | 197 / 37.9% | 241 / 46.0% | 289 / 47.3% |

**당시 주입이 없던 turn.** 편향이 없는 부분집합이다. 수치는 기억당 평균 overlap이고, 괄호는 그 arm이 주입한 turn 수다.

| arm | A (21 turn) | B (13 turn) | C (13 turn) |
|---|---|---|---|
| current | 0.243 (2) | 0.640 (1) | 0.000 (2) |
| #121 | 0.042 (10) | 0.204 (4) | 0.124 (8) |
| #125 | 0.167 (8) | 0.320 (2) | 0.039 (7) |
| #121+#125 | 0.167 (8) | 0.107 (3) | 0.135 (9) |

**해석.**
- 어느 플래그도 세 store에서 기억당 overlap을 올리지 못했다. CI가 current를 넘어서는 경우는 한 번도 없었다.
- **#121.** 주입량을 1.5~1.8배로 늘린다. 기억당 overlap은 같거나(B, C) 낮다(A). 기회가 늘어나 grounded 기억이 있는 turn 비율은 B와 C에서 올랐다(52→60%, 46→58%). 하지만 이는 주입량이 늘어난 효과이며, 기억당 grounding이 좋아진 것은 아니다.
- **#125.** C에서 기억당 overlap이 낮다(0.188 → 0.128).
- **편향 없는 부분집합.** store당 13~21 turn뿐이다. current가 거기서 거의 주입하지 않아서 비교할 수 있는 표본이 너무 작다.
- 따라서 현재로서는 두 플래그 모두 기본값을 켤 근거가 없다.

### 8.2 지표와 판정

- **1차 지표.** 다음 두 값이다.
  - 주입된 기억당 평균 `content_overlap_score`
  - 주입이 1건 이상인 trace 중 grounded(≥0.3) 기억을 가진 trace의 비율
- **보조 지표 (판정에는 안 씀).**
  - 주입 건수와 기권률
  - `vectorKnown=false` 비율과 그 overlap
  - cliff 발동률
  - 지연 (§5)
- **편향 통제.**
  1. **baseline 유리 편향.** 실제 응답은 baseline 주입을 보고 쓰였으므로 baseline이 고른 기억이 유리하다. 그래서 baseline이 아무것도 주입하지 않은 trace만 따로 떼어 보고한다. 이 부분집합에는 이 편향이 없다.
  2. **어휘 혼입.** 쿼리 term을 스니펫에서 제거한 뒤 다시 계산한 overlap을 같이 보고한다. 이 값이 나빠지면 어휘 점수가 "쿼리 되풀이"만 고르고 있다는 뜻으로 본다. **(이번 범위에는 미구현. 보류 항목을 다시 결정할 때 추가한다.)**
  3. trace 단위 bootstrap으로 기억당 평균 overlap의 95% CI를 구한다 (1,000회, 고정 seed).
- **기본값 켜기를 제안할 수 있는 조건.** 아래를 모두 만족해야 한다.
  - store 3개 중 2개 이상에서 1차 지표 두 개가 모두 개선되고, CI가 0을 넘는다.
  - CI를 넘어 악화된 store가 없다.
  - 쿼리 term을 제거한 overlap이 악화되지 않았다.
  - §5 지연 예산을 지켰다.
  - 이 조건을 통과해도 바로 기본값으로 켜지 않는다. 다음 단계로 진행한다.
- **실사용 확인.** 플래그를 켠 기간의 trace에 `scoringMode`를 기록하고, `scripts/measure-injection-grounding.mjs`를 `scoringMode`별로 나눠 비교한다. 행이 30개 이상인 창만 판정한다.

## 9. 구현 순서 (원안) — 1·6만 이번에 구현, 나머지 보류

1. `refactor(hooks)`: `selectHookInjection` 추출 (§8.1-1). 훅 golden 테스트 선행.
2. `refactor(core)`: 한국어 조사 규칙을 core로 이동. 정책 모듈은 import로 교체.
3. `feat(core)`: `hybrid-lane-scoring.ts`와 단위 테스트.
   - `s/ideal`: 1등 1.0 금지, top-M 제한
   - 벡터 보정 경계
   - 벡터 미상 재정규화
4. `feat(core)`: `VectorStore.scoreEventIds`와 retriever `candidateStrategy: 'union'`. sequential golden 테스트 포함.
5. `feat(hooks)`: 데몬 요청/응답 필드, 훅 hybrid 병합과 열화 경로, diagnostics. 플래그 꺼짐 바이트 동일 테스트 포함.
6. `feat(eval)`: `scripts/replay-hook-grounding.ts`와 fixture 모드. `package.json`에 `eval:hook-replay` 스크립트 추가.
7. README 환경변수 목록 추가. replay 결과(집계)로 L, H, wv, 임계값 초기값을 확정하고 PR에 기록.

## 10. 롤백

- **런타임.** env를 해제하면 즉시 기존 경로로 돌아간다. 데몬은 요청 필드로 판단하므로 재시작이 필요 없다.
- **데이터.** 스키마 마이그레이션이 없다. 추가되는 것은 플래그가 켜졌을 때만 쓰는 선택적 JSON 키(`scoringMode`, `hybridTimings`, 응답의 `vectorScores`)뿐이다. 기존 독자는 모르는 키를 무시한다.
- **코드.** 9-3~9-6은 플래그 뒤에 있으므로 revert만으로 제거된다. 9-1, 9-2는 동작 변경이 없는 구조 변경이라 남겨 두어도 된다.

## 11. 범위 밖과 남는 문제

- **lesson 척도.** lesson(어휘 0.5~0.98)과 이벤트 hybrid 점수가 `rankHookCandidates`에서 직접 비교된다. `reserveLessonSlot`이 lesson 한 건을 보장하므로 당장은 문제가 없다. lesson 임베딩은 기존 결정에 따라 비목표다.
- **FTS 지연 꼬리.** p90 605 ms, 최대 36 s다. 긴 쿼리의 OR 접두 매칭 때문이며 플래그와 무관한 기존 문제다. #136으로 남겼다.
- **graduated 레인의 고유 점수.** `scoreGraduatedEvidence`의 앵커와 엔티티 거부 게이트(`null`)는 풀에 들어갈지 판단하는 입장 필터로만 유지한다. 점수는 hybrid로 바꾼다. 레벨 사전 가중치는 이미 `graduatedEvidenceBonus`로 가산되고 있어, `scoreGraduatedEvidence`의 `levelPrior`까지 쓰면 이중 반영이 되기 때문이다.

## 12. 승인 요청 사항 — 5만 승인, 나머지 보류

1. 가중치를 오프라인 표본으로 정하지 않는 방향. 구현에는 자리표시 값 wv=0.5를 두고, replay grid `{0, 0.2, 0.4, 0.6, 0.8}`에서 **최악의 store 기준 규칙**으로 확정한다. 규칙을 만족하는 값이 없으면 기본값을 켜는 후보에서 탈락한다.
2. 정규화를 REF의 `s/max`가 아닌 **쿼리 기준 `s/ideal`, 상위 12 term**으로 하는 것
3. 벡터 미상 후보를 **어휘 점수만으로 재정규화**하는 것 (REF는 0 기여)
4. 훅 순서 변경(프로세스 내 레인 → 데몬)과 데몬 프로토콜 확장(`candidateStrategy`, `scoreEventIds` → `vectorScores`)
5. #119 해결을 이 작업에 포함하는 범위: `selectHookInjection` 추출, store 사본 반사실 replay, fixture 모드
6. 단일 주입 임계값을 분위수 정합으로 초기화한 뒤 grounding으로 조정하는 절차
