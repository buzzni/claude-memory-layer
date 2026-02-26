# mcp-memory-service 코드 리뷰 기반 개선 제안서

작성일: 2026-02-26  
대상:
- 참고 레포: `~/workspace/mcp-memory-service` (commit `8d7e582`)
- 개선 대상: `~/workspace/claude-memory-layer`

---

## 0) 결론 요약

`claude-memory-layer`는 이미 구조가 매우 좋고(프로젝트 해시 격리, scoped retrieval, outbox, endless mode, shared store 실험), **핵심 기능은 충분히 경쟁력 있음**.

다만 `mcp-memory-service`를 기준으로 봤을 때 실제 운영 관점에서 보강하면 체감이 큰 포인트는 아래 5가지:

1. **멀티-repo 스코프 강제 정책**(기본 격리 + 명시적 cross-repo)
2. **태그 taxonomy 표준화**(`proj:`, `agent:`, `topic:`, `q:` 등) + 자동 주입
3. **HTTP/SSE API 레이어**(운영/관측/통합성 증가)
4. **하이브리드 검색(BM25+Vector) 공식화** 및 점수 퓨전 표준화
5. **운영 안정성 레이어**(헬스체크, 백업/복구, 보존정책, 인증)

즉, 지금은 “강한 코어 엔진” 단계고, 다음 단계는 “**운영형 메모리 플랫폼**”으로 가는 게 맞음.

---

## 1) 조사 방식

### 확인한 핵심 파일(참고 레포)
- `README.md`
- `docs/architecture.md`
- `docs/agents/README.md`
- `docs/mastery/configuration-guide.md`
- `src/mcp_memory_service/models/tag_taxonomy.py`
- `src/mcp_memory_service/web/api/memories.py`
- `src/mcp_memory_service/web/api/search.py`

### 확인한 핵심 파일(현재 레포)
- `README.md`
- `package.json`
- `src/services/memory-service.ts`
- `src/core/retriever.ts`
- `src/core/event-store.ts`
- `docs/OPERATIONS.md`
- `docs/MEMU_ADOPTION.md`

---

## 2) 현재 `claude-memory-layer` 강점 (유지해야 할 것)

1. **프로젝트 격리 설계가 이미 있음**
   - `hashProjectPath()` + `~/.claude-code/memory/projects/{hash}`
   - 세션 레지스트리로 session→project 매핑

2. **검색 전략 설계가 좋음**
   - `fast/deep/auto`, fallback chain, scope filter, rerank, graph-hop
   - 실전성 높은 토큰/정확도 트레이드오프

3. **쓰기 파이프라인 안정성 의식이 강함**
   - SQLite primary, outbox, background worker
   - hook 경량 모드(lightweightMode)

4. **고급 메모리 기능이 이미 구현/실험됨**
   - graduation, endless mode, shared store, markdown mirror

=> 요약: 엔진 레벨은 이미 상당히 앞서 있음.

---

## 3) `mcp-memory-service` 대비 갭 분석

### A. 멀티-repo 운영 규칙의 “정책 강제력”

- 현 상태: 프로젝트 해시 분리는 있으나, 교차 검색/주입 정책이 코드/문서에서 강하게 표준화되어 있지는 않음
- 참고 레포 포인트:
  - `agent:` 태그 자동 주입(`X-Agent-ID`)
  - 태그 namespace 체계 명시(`proj:`, `topic:`, `q:` ...)

**리스크**
- 여러 repo를 운용할수록 검색 누수(다른 repo 기억 주입) 가능성 증가

**개선안**
- 기본 policy: `same-project-only`
- cross-project는 explicit flag + 이유(required reason) 필요
- retrieval 요청 시 project_id 부재면 hard-fail(옵션)

---

### B. 태그 체계 표준화 부족

- 현 상태: metadata/scope가 강하지만 태그 네임스페이스 규약은 상대적으로 약함
- 참고 레포 포인트:
  - `TagTaxonomy`를 별도 모델로 정의하고 namespace 유효성 관리

**개선안**
- `src/core/tag-taxonomy.ts` 신설
- 표준 namespace:
  - `proj:` repository identifier
  - `agent:` 실행 주체
  - `topic:` 주제
  - `q:` 품질/신뢰 등급
  - `t:` 시간/스프린트
  - `sys:` 시스템 자동 태그
- ingest 시 최소 `proj:<hash>` 자동 부착

---

### C. HTTP/SSE 운용 계층 부재(또는 약함)

- 현 상태: CLI/hooks 중심 구조가 강점이지만, 외부 오케스트레이터/다중 클라이언트 연동은 제한적
- 참고 레포 포인트:
  - REST API + SSE + dashboard 연동

**개선안**
- 최소 API부터 시작:
  - `POST /api/memories`
  - `POST /api/memories/search`
  - `GET /api/memories?project=...`
  - `GET /api/health`
- SSE 이벤트:
  - memory_stored
  - memory_deleted
  - search_completed

---

### D. Hybrid search 점수 체계 공식화 필요

- 현 상태: fast/deep + rerank는 이미 훌륭함
- 부족한 점: “BM25 + Vector + Recency + Quality”를 운영상 조정 가능한 공식으로 고정 문서화한 수준은 약함
- 참고 레포 포인트:
  - hybrid 검색을 제품 기능으로 명시

**개선안**
- `score = w_semantic*S + w_lexical*L + w_recency*R + w_quality*Q`
- env/config에서 가중치 조정 가능하게
- quality 점수 부재 시 graceful fallback

---

### E. 운영/보안 레이어

- 현 상태: runbook/ops 스크립트 존재(좋음)
- 참고 레포 포인트:
  - 인증, 헬스/환경 점검, 상세 config 가이드

**개선안**
- 최소 추가:
  - `MEMORY_API_KEY` 인증(HTTP 도입 시)
  - `/api/health` + 저장소 상태 + outbox backlog 노출
  - 백업/복구 명령 표준화
  - 보존정책(TTL, 중요도 기반 정리) 명문화

---

## 4) 우선순위 로드맵 (실행 순서)

## P0 (당장 효과 큼, 1~3일)
1. 멀티-repo 스코프 기본 정책 강제
2. `proj:` 자동 태깅
3. 검색 기본값 same-project-only
4. 교차 검색은 명시적 옵션 필요

## P1 (1~2주)
1. tag taxonomy 모듈화
2. hybrid scoring 공식화 + 설정화
3. health endpoint/metrics 정리

## P2 (2~4주)
1. HTTP API + SSE 추가
2. 인증(OAuth까지는 아니어도 API key)
3. 팀/멀티클라이언트 운영 문서화

---

## 5) 구체 구현 제안 (코드 레벨)

### 5.1 Retrieval 옵션 확장
`src/core/retriever.ts`에 아래 정책 필드 추가 권장:

- `projectScopeMode: 'strict' | 'prefer' | 'global'`
- `allowedProjectHashes?: string[]`
- `crossProjectReason?: string`

`strict`일 때 현재 프로젝트 hash 불일치 결과는 필터링.

---

### 5.2 자동 태깅 훅
`MemoryService.storeUserPrompt/storeAgentResponse/storeToolObservation`에서 metadata 병합 시:

- `scope.project.hash`
- `scope.project.path`
- `tags` 개념을 도입하면 `proj:${projectHash}` 자동 주입

---

### 5.3 정책 파일 도입
`claude-memory-layer/policies/memory-scope-policy.json` 예:

```json
{
  "defaultMode": "strict",
  "allowCrossProject": false,
  "requireReasonForCrossProject": true,
  "alwaysIncludeTags": ["sys:auto", "proj:auto"]
}
```

---

### 5.4 운영 API 최소셋
향후 `src/server`에 라우트 추가:

- `GET /api/health`
  - db 연결 상태
  - vector worker backlog
  - failed outbox 개수
- `POST /api/memories/search`
  - projectHash 필수(운영 모드에서)

---

## 6) 여러 repository 관리 관점 평가

질문의 핵심(“여러 repo 관리 용이?”)에 대해:

- `claude-memory-layer` 현재 구조는 **잠재적으로 매우 유리**
  - 프로젝트 해시 분리 구조가 이미 있기 때문
- 하지만 운영 안정성은 “격리 정책 강제 + 표준 태깅 + API 관측”이 있어야 완성

즉, **아키텍처 방향은 맞고, 운영 레이어 보강이 필요**.

---

## 7) 추천 최종 전략

`/Users/namsangboy/workspace/claude-memory-layer`를 계속 중심으로 가져가되:

1. P0/P1 개선 먼저 적용해서 “멀티-repo 안 섞이는 안정성” 확보
2. 그 다음 HTTP/SSE/API key 붙여서 외부 자동화/다중 클라이언트 지원
3. 마지막에 공유 지식(shared store) 룰을 엄격히(검증된 것만 승격)

이 순서가 리스크/효율 밸런스가 가장 좋음.

---

## 8) 보너스: 바로 체크할 TODO

- [ ] `projectScopeMode` 옵션 추가
- [ ] 기본 검색 strict project filter 적용
- [ ] `proj:<hash>` 자동 태깅
- [ ] tag taxonomy 모듈 생성
- [ ] health command/API에 outbox failed/pending 수치 노출
- [ ] 문서에 cross-project 허용 조건 명시

---

원하면 다음 단계로, 위 P0 항목 3~4개를 실제 코드 PR 수준(diff 형태)로 바로 작성 가능.
