# MemPalace 벤치마킹 후보 (2026-10-31)

> 기준: MemPalace `84582fb0` (2026-10-25), claude-memory-layer v2.4.17 (`1faa18a`)
> 선행 문서: [mempalace-targeted-improvement-plan.md](mempalace-targeted-improvement-plan.md) (2026-06-07)

## 범위와 방법

2026-06-07 비교 이후 MemPalace에 비병합 커밋이 약 830개 쌓였다. 이 문서는 그 이후 변화를 네 영역(검색·주입, 훅·수집, 운영, 평가)으로 나눠 다시 조사한 결과다.

선행 문서에서 다룬 항목은 다시 다루지 않는다. 대상은 source adapter 계약, 레이어 매니페스트, import 경계 가드, MCP 핸들러 분할, `mem-source-ref` 이웃 확장이다.

판단 기준은 CML의 핵심 지표인 grounding, 즉 주입한 기억과 이후 에이전트 출력 사이의 `content_overlap_score`다. 생성률이나 저장률 같은 프록시 지표를 올리는 제안은 제외했다.

- ✅ 표시는 코드를 직접 열어 확인한 근거다.
- 표시가 없는 항목은 조사 보고를 옮긴 것이다.
- 어느 항목도 실행해 측정하지는 않았다.

## 1순위: 검색과 주입 (grounding에 직접 영향)

### 1. FTS 점수 정규화와 하이브리드 결합 (M)

- **REF**
  - `mempalace/searcher/ranking.py:170-235` `_hybrid_rank` ✅
    - 벡터 유사도는 절대값을 쓴다.
    - BM25는 후보 집합 안에서 IDF로 다시 계산하고 `s/max`로 정규화한 뒤 0.6/0.4로 섞는다.
  - 가중치는 설정으로 바꿀 수 있다(`:85-104`).
  - `candidate_strategy="union"`은 벡터 검색이 놓친 BM25 후보를 후보 풀에 합친다.
- **CML**
  - `src/core/engine/memory-query-service.ts:238-246` ✅
    - FTS rank를 결과 목록 안에서 `1-(rank-best)/range`로 정규화한다.
    - 그래서 매칭 품질과 상관없이 1등은 항상 1.0이 되고, 훅 임계값(`minScore` 0.65)을 그대로 통과한다.
  - `src/core/retriever.ts:263-320`
    - FTS 결과가 부실할 때만 벡터로 넘어가는 순차 폴백이다. 두 결과를 합치지 않는다.
  - 키워드 재정렬은 `keywordOverlap`(쿼리 토큰 포함 비율)이라 IDF가 없다.
    - 경로나 PR 번호 같은 희소 토큰에 가중이 붙지 않는다.
  - 훅의 레인 병합(`src/adapters/claude/hooks/user-prompt-submit.ts:626-632, 730-745`)은 max나 덮어쓰기로 처리한다.
    - 레인별 점수 척도가 서로 다르다.
- **할 일**
  - FTS 점수를 절대 척도로 바꾼다.
  - 후보 합집합 안에서 BM25를 다시 채점한다.
  - 레인들을 공통 척도로 가중 합산한다.
- **리스크**
  - 주입 임계값이 현재 점수 분포에 맞춰져 있으므로 replay로 다시 보정해야 한다.

### 2. 검색 쿼리 정리 (S)

- **REF**
  - `mempalace/query_sanitizer.py` ✅는 4단계로 처리한다.
    1. 200자 이하는 그대로 쓴다.
    2. 그보다 길면 물음표로 끝나는 문장을 뽑는다.
    3. 그것도 없으면 마지막 문장을 쓴다.
    4. 최후에는 꼬리를 잘라 쓴다.
  - REF 자체 주장으로는 오염된 쿼리에서 R@10이 89.8%에서 1.0%로 떨어지는 것을 막는다. 재현하지는 않았다.
- **CML**
  - `src/adapters/claude/hooks/user-prompt-submit.ts:417-428` `buildRetrievalQuery`가 현재 프롬프트 전체를 길이 제한 없이 쓴다.
  - 길이 상한은 이전 턴 컨텍스트(500자)에만 있다.
  - `src/core/prompt-normalizer.ts`는 이미 알려진 scaffold 블록만 제거한다.
- **선행 확인**
  - 실제 프롬프트 길이 분포를 먼저 본다.
  - 임베더가 입력을 잘라내는지 확인한다.
    - 앞쪽만 남기고 잘라낸다면, 질문이 있는 꼬리 부분이 사라진다.

### 3. 식별자 중심 발췌 (S)

- **REF**
  - `mempalace/palace/closets.py:101-186` `build_closet_lines`는 LLM 없이 정규식으로 원문에서 토픽과 엔티티를 뽑는다.
  - 뽑은 결과는 원문 drawer를 가리키는 포인터로만 쓴다.
  - 주의: REF의 wake-up L1(`layers.py`)도 앞부분을 자르는 방식이다. 이 항목은 REF를 복제하는 것이 아니라 응용이다.
- **CML**
  - `src/core/memory-reference-context.ts:33-37` `safeText`가 코드 블록을 `[code]`로 바꾼다 ✅.
    - 경로, SHA, PR 번호가 코드 블록 안에 있으면 지워진다.
  - `src/adapters/claude/hooks/session-start.ts:179-189` `sessionStartExcerpt`는 앞부분을 자른다 ✅.
- **근거**
  - 실측상 agent_response 원문의 overlap은 0.53~0.94이고 요약은 약 0이다.
  - grounding을 만드는 것은 구체적인 식별자 토큰이다.
- **할 일**
  - 이벤트 안에서 식별자가 몰린 구간을 우선 발췌한다. 원문 자체는 유지한다.
  - `queryTermPriority`(`memory-reference-context.ts:56-61`)를 재사용할 수 있다.
- **리스크**
  - 식별자 개수만 늘리면 지표 자체를 최적화하는 꼴이 된다.
  - 발췌한 식별자가 다음 행동에 실제로 쓰이는지 함께 평가해야 한다.

### 4. 동일 본문 접기 (S, 효과 불명)

- **REF**
  - `searcher/candidates.py` `_fold_copies_across_sources`는 동일한 텍스트를 하나로 접고 `also_in`에 출처를 표기한다.
  - `query.py:177-186, 488-508`은 접은 결과 수가 부족하면 후보 풀을 확장해 다시 조회한다.
- **CML**
  - 중복 제거는 session-start에만 있다(`session-start.ts:117-119`, 앞 200자 키).
  - 프롬프트 레인에는 없다.
- **선행 확인**
  - resume이나 compact로 생긴 중복이 `maxMemories` 슬롯을 실제로 얼마나 차지하는지 먼저 측정한다.

## 2순위: 수집 정확도

### 5. Stop 훅의 200KB tail 읽기를 커서 방식으로 (M)

- **REF**
  - `mempalace/hooks_cli.py:1482-1560`은 세션별 `_last_save` 마커를 둔다.
  - 결정적 ID로 mine하므로 다시 읽어도 중복이 생기지 않는다.
- **CML**
  - `src/adapters/claude/hooks/stop.ts:54`는 `src/adapters/claude/transcript/transcript-reader.ts:18`의 기본값(200KB)으로 전사 끝부분만 읽는다 ✅.
  - 큰 tool_result가 있는 긴 턴에서는 그 앞의 assistant 텍스트가 조용히 빠질 수 있다.
- **리스크**
  - 전사가 잘리거나 compact된 뒤 커서를 리셋하는 동작을 설계해야 한다.

### 6. 전사 원본 시각 보존 (authored_at) (S)

- **REF**
  - `mempalace/convo_miner.py:598-629`, `docs/authored-at.md`.
  - 작성 시각(authored_at)과 저장 시각(filed_at)을 구분해 기록한다.
- **CML**
  - `src/adapters/claude/transcript/turn-reconstructor.ts`가 `entry.timestamp`를 버린다 ✅.
  - `src/core/engine/memory-ingest-service.ts:170` `storeAgentResponse`는 `new Date()`를 쓴다 ✅.
  - 결과적으로 한 턴의 중간 응답이 모두 Stop 시각으로 찍힌다.
    - PostToolUse 이벤트보다 뒤로 정렬된다.
    - `ingest-source-clocks.ts`에서는 출처 시각을 알 수 없는 이벤트(unknownSourceClock)가 된다.
  - importer 경로는 이미 `originalTimestamp`를 채운다(`src/services/session-history-importer.ts`).
- **리스크**
  - 낮다. dedupeKey가 content, session, type 기반이라 timestamp 변경의 영향을 받지 않는다.

### 7. Claude SessionEnd에서 전사 재반영 (M)

- **REF**
  - `mempalace/hooks_cli.py:1652-1748`은 SessionEnd에서 백그라운드로 최종 flush를 한다.
  - 이미 캡처한 내용을 다시 처리해도 사실상 no-op이다.
- **CML**
  - Codex에는 같은 패턴이 이미 있다(`src/hooks/codex-session-import-worker.ts`).
  - Claude `session-end.ts`는 세션 종료와 helpfulness 평가만 한다.
  - 중단되거나 크래시 난 세션을 복구할 경로가 없다.
- **리스크**
  - Stop(5000자 절단, privacy filter 적용)과 importer(`truncateAgentResponse`)의 절단 방식이 다르다.
  - dedupeKey가 달라져 중복이 생길 수 있다. 미검증이다.

### 8. 하네스 boilerplate 판별 규칙 단일화 (S)

- **REF**
  - `mempalace/hooks_cli.py:871-908`은 마커 목록 하나를 `startswith`로만 검사한다.
- **CML**
  - 같은 판별 규칙이 세 곳에 서로 다르게 있다 ✅.
    - `src/services/session-history-importer.ts:72`
    - `src/core/session-qrels.ts:348`
    - `src/core/retrieval-quality.ts:193`
  - 마지막 것은 비앵커 `includes('command-name')`라서 이 단어를 언급한 정상 쿼리도 걸러낸다.

### 9. Hermes system-generated 세션 제외 (S, 미검증)

- **REF**
  - `integrations/hermes/__init__.py:679-690`은 `agent_context`가 cron이나 flush인 세션을 제외한다.
- **CML**
  - `hermes-session-history-importer.ts:295-314`는 `sessions.source`를 SELECT하지만 필터는 없다.
  - 실제 데이터에 `cron` 값이 있는지는 확인하지 않았다.

## 3순위: 운영

### 10. MCP 바이너리 절대경로와 매니페스트 버전 가드 (S)

- **REF**
  - `scripts/check_versions.py`, `tests/test_version_guard.py`가 매니페스트 11개의 버전 일치를 검사한다.
  - `mcp_proxy.py` `_annotate_forwarded_update_status`는 클라이언트 버전과 서버 버전을 함께 노출한다.
- **CML**
  - `src/apps/cli/mcp-install.ts:97`이 MCP command를 PATH 이름(`claude-memory-layer-mcp`)으로 기록한다 ✅.
    - 이중 설치 사고의 근본 원인이다.
  - `.claude-plugin/plugin.json`의 version은 `1.0.0`이고 `package.json`은 `2.4.17`이다 ✅.
  - `scripts/guard-release-artifact.cjs`는 매니페스트 버전을 검사하지 않는다.
- **할 일**
  - 설치 시 실행 파일의 realpath를 기록한다.
  - doctor가 실제 MCP 클라이언트 설정의 command와 실행 중인 바이너리를 비교한다.
  - 릴리스 가드에 버전 일치 검사를 추가한다.

### 11. Mongo pull을 origin별 커서로 (M)

- **REF**
  - `mempalace/logsync.py:48-110`은 origin별 `after=local_vector[origin]`로 빠짐없이 당겨 온다.
  - `mempalace/hlc.py` docstring은 "배달은 로컬 도착 순서 커서, HLC는 표시와 병합 순서"라고 둘을 분리한다 ✅.
- **CML**
  - `src/core/mongo-sync-worker.ts:117, 389-394`는 30분 창 안에서 두 시계를 비교한다 ✅.
    - 당겨 오는 머신의 시계(`previousPullAt`)와 밀어 넣은 머신의 시계(`insertedAt`)다.
  - 밀어 넣는 머신이 seq를 예약한 뒤 30분 넘게 멈추거나, 머신 간 시계가 30분 넘게 어긋나면 v2.4.17에서 고친 누락이 재발한다.
  - `source.instanceId`는 이미 저장되어 있다.
- **대안**
  - 근본 수정은 기존 문서 백필이 필요하다.
  - 더 싼 대안은 doctor에서 로컬과 Mongo의 `instanceId`별 건수를 대조하는 것이다.

### 12. doctor `--fix` (S~M)

- **REF**
  - `mempalace/repair.py:1353` `maybe_autoheal_fts5_index`는 안전할 때만 자동 복구한다.
  - 안전하지 않으면 거절 사유를 출력한다(`:1305`).
  - `backups.py:229` `prune_backups`는 백업 보관 개수를 제한한다.
- **CML**
  - `checkEmbeddingBackend`는 문제를 보고만 한다.
  - `scripts/postinstall-embedding-backend.cjs`가 `runPostinstall`을 export하므로 멱등 재설치에 바로 연결할 수 있다.

## 4순위: 평가 방법론

CML에 이미 있는 장치는 다음과 같다.

- Wilson 구간: `scripts/evaluate-host-lesson-matching.ts`
- 미래 교훈 제외: 같은 파일
- 종료 코드 게이트: `scripts/replay-retrieval-benchmark.ts`
- held-out 게이트 테스트: `tests/scripts/lesson-hybrid-heldout-gate.test.ts`

부족한 부분은 다음과 같다.

| 항목 | REF 참고 | CML 현황 | 규모 |
| --- | --- | --- | --- |
| dev/test 분리 강제 | `benchmarks/search_benchmark.py:920-924`가 태그가 없거나 겹치면 실행을 거부한다. 테스트는 `tests/test_search_benchmark.py:510, 534`. | `benchmarks/lesson-recall/` fixture와 라벨 240개에 split 태그와 겹침 검사가 없다. | S |
| 라벨링 블라인드 풀 | `search_benchmark.py:812` `build_blind_pool`은 후보의 알고리즘 출처를 제거하고 순서를 섞는다. | 후보가 임베딩 top6와 lexical top3의 합집합이다. 라벨러에게 출처를 숨기는지는 미확인. 교훈 매칭 정밀도 5%/칸이 pooling bias 때문인지 점검할 근거가 된다. | M |
| 결과 출처 기록 | `search_benchmark.py:172-190` `snapshot_metadata`, `corpus_changed`. | 결과 JSON에 git SHA, fixture 해시, 행 수가 없다. | S |
| 부하 민감 테스트 격리 | `pyproject.toml:256`의 마커 제외 설정, `tests/benchmarks/test_performance_budgets.py:30`의 CI 예산 3배. | `vitest.config.ts`에 분리 설정이 없다. 전체 스위트에서만 실패하는 flaky 테스트 2건이 이 분리의 대상이다. | S~M |
| 문서 주장 테스트 | `tests/test_readme_claims.py`는 README의 도구 수와 버전 표기를 코드와 대조한다. | README와 docs의 주장을 검증하는 테스트가 없다. | S |

## 따라 하지 말 것

- **AAAK, dialect, closet_llm 압축 요약과 LLM rerank**
  - 요약의 overlap이 약 0이라는 CML 실측과 정면으로 어긋난다.
  - LLM rerank는 훅 지연 예산에도 맞지 않는다.
  - REF 자신도 closet을 게이트가 아닌 부스트로만 쓴다.
- **`dynamics.py` 기억 강도(Hebbian/Ebbinghaus)**
  - 파일 docstring에 랭킹과 연결되어 있지 않다고 적혀 있다.
  - 접근 횟수는 grounding과 무관한 프록시 지표다.
- **PQL, `mcp_light_server.py`**
  - 도구 수를 줄이는 DSL 래퍼일 뿐이고 랭킹과 무관하다.
- **RFC 004 다중 마스터 복제 전체**
  - REF 자신도 step 2a를 미구현이라고 밝힌다.
  - CML에는 중앙 Mongo가 있으므로 origin별 커서 아이디어만 가져오면 충분하다.
- **Chroma 전용 `repair.py` 복구, fsio 비정규 파일 가드**
  - REF의 저장소 구조와 임의 디렉터리 mining 방식에서 나온 장치다.
- **write-routing 3단계 정책, PID-slot mine 가드**
  - Chroma 단일 writer 문제를 풀기 위한 장치다.
  - CML에는 이미 detached worker와 host bridge가 있다.
- **Stop 훅의 `systemMessage`와 `decision: block`으로 모델에게 저장을 요청하는 방식**
  - 채팅창 노이즈가 늘어난다.
  - CML의 "캡처는 자동" 원칙과 충돌한다.
- **백엔드 conformance 스위트, 공개 리더보드식 R@k 진행표**
  - CML은 SQLite 단일 저장소이고, 핵심 지표가 R@k가 아니라 grounding이다.

## 추천 착수 순서

1. 1번(점수 정규화)과 2번(쿼리 정리)을 grounding replay로 비교하며 적용한다. 레인 결합보다 FTS 절대 척도를 먼저 한다.
2. 6번(authored_at)과 8번(boilerplate 단일화)을 적용한다. 둘 다 작고, 동작 변경 범위가 좁다.
3. 10번(절대경로와 버전 가드)을 적용한다.
4. 5번(Stop 커서), 11번(origin별 커서), 라벨링 블라인드 풀을 진행한다.

## 조사 중 바로잡은 사실

- REF의 BM25 정규화는 min-max가 아니라 `s/max`다(`ranking.py:_hybrid_rank`).
- `update_awareness.py`는 설치 경로(uv/pipx/pip)를 자동 감지하지 않는다.
  - 사용자가 `--installer`로 지정한 값에 맞춰 upgrade 명령을 만들 뿐이다.
