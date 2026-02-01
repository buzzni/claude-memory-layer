# PostToolUse Hook Context

> **Version**: 1.0.0
> **Created**: 2026-02-01

## 1. 배경

### 1.1 claude-mem의 접근 방식

claude-mem 프로젝트는 5개의 라이프사이클 훅을 사용:

```
SessionStart → UserPromptSubmit → PostToolUse → Stop → SessionEnd
```

**PostToolUse 훅의 역할** (claude-mem):
- 모든 도구 실행 결과를 "observation"으로 캡처
- SQLite + Chroma에 저장하여 검색 가능하게 함
- 세션 간 도구 사용 패턴 학습

**주요 특징**:
- 웹 뷰어에서 실시간 observation 스트림 표시
- 도구별로 다른 압축 전략 적용
- `<private>` 태그로 민감 정보 제외

### 1.2 현재 code-memory의 상황

현재 4개 훅만 구현:

```
SessionStart → UserPromptSubmit → Stop → SessionEnd
```

**부족한 점**:
1. 도구 실행 결과가 Stop 훅에서 응답 전체로만 저장됨
2. 개별 도구 실행의 입력/출력 분리 불가
3. "어떤 도구를 어떻게 사용했는지" 패턴 학습 불가

### 1.3 도입 필요성

| 현재 상황 | PostToolUse 도입 후 |
|----------|-------------------|
| 응답 전체만 저장 | 도구별 개별 저장 |
| 파일 경로 추출 어려움 | 메타데이터로 즉시 조회 |
| 성공/실패 구분 없음 | success 플래그로 분리 |
| 검색 시 노이즈 많음 | 도구 타입별 필터링 가능 |

## 2. Claude Code 훅 시스템

### 2.1 지원되는 훅 이벤트

Claude Code가 지원하는 훅 이벤트 목록:

```typescript
type HookEvent =
  | 'session-start'       // 세션 시작
  | 'user-prompt-submit'  // 사용자 프롬프트 제출
  | 'post-tool-use'       // 도구 사용 후 (NEW)
  | 'stop'                // 에이전트 응답 완료
  | 'session-end';        // 세션 종료
```

### 2.2 post-tool-use 훅 입력 형식

Claude Code가 전달하는 데이터:

```typescript
interface PostToolUseHookInput {
  // 도구 정보
  tool_name: string;           // "Read", "Write", "Bash" 등
  tool_input: object;          // 도구에 전달된 파라미터
  tool_output: string;         // 도구 실행 결과
  tool_error?: string;         // 에러 발생 시 메시지

  // 세션 정보
  session_id: string;
  conversation_id: string;

  // 타이밍
  started_at: string;          // ISO 8601 형식
  ended_at: string;
}
```

### 2.3 훅 등록 방법

`.claude-plugin/hooks.json`:

```json
{
  "hooks": [
    {
      "event": "post-tool-use",
      "script": "node dist/hooks/post-tool-use.js",
      "timeout": 5000
    }
  ]
}
```

## 3. 참고 구현

### 3.1 claude-mem의 observation 저장

```typescript
// claude-mem의 접근 방식 (추정)
interface Observation {
  id: string;
  session_id: string;
  tool_name: string;
  input: object;
  output: string;
  timestamp: Date;

  // 검색을 위한 필드
  summary: string;        // LLM으로 생성한 요약
  embedding: number[];    // 벡터 임베딩
}
```

### 3.2 도구별 처리 차이

| 도구 | 저장 내용 | 요약 생성 |
|------|----------|----------|
| Read | 파일 경로, 첫 N줄 | "Read {path}: {first_line}..." |
| Write | 파일 경로, 변경 내용 요약 | "Wrote {lines} lines to {path}" |
| Bash | 명령어, exit code | "Ran `{cmd}`: {status}" |
| Grep | 패턴, 매칭 파일 수 | "Found {n} matches for {pattern}" |

### 3.3 Progressive Disclosure 활용

```typescript
// 검색 시 observation을 3단계로 반환
interface ObservationSearchResult {
  // Layer 1: ID + 요약 (최소 토큰)
  layer1: { id: string; summary: string }[];

  // Layer 2: 타임라인 컨텍스트
  layer2: (ids: string[]) => {
    id: string;
    tool_name: string;
    timestamp: Date;
  }[];

  // Layer 3: 전체 내용
  layer3: (ids: string[]) => Observation[];
}
```

## 4. 기존 코드와의 관계

### 4.1 event-store.ts

현재 EventStore 스키마:

```sql
CREATE TABLE events (
  event_id VARCHAR PRIMARY KEY,
  event_type VARCHAR NOT NULL,
  session_id VARCHAR NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  payload_json JSON NOT NULL
);
```

**확장 필요 없음** - `event_type = 'tool_observation'`으로 저장 가능

### 4.2 types.ts

추가해야 할 타입:

```typescript
// 기존 EventType
export const EventTypeSchema = z.enum([
  'user_prompt',
  'assistant_response',
  'session_start',
  'session_end',
  'tool_observation'  // 추가
]);

// ToolObservationPayload 추가
export const ToolObservationPayloadSchema = z.object({
  toolName: z.string(),
  toolInput: z.record(z.unknown()),
  toolOutput: z.string(),
  // ...
});
```

### 4.3 embedder.ts

현재 임베딩 대상:

```typescript
function getEmbeddingContent(event: Event): string {
  switch (event.eventType) {
    case 'user_prompt':
      return event.payload.content;
    case 'assistant_response':
      return event.payload.content;
    // tool_observation 추가 필요
  }
}
```

### 4.4 retriever.ts

검색 인터페이스 확장:

```typescript
// 기존
async search(query: string): Promise<SearchResult[]>;

// 추가
async searchToolHistory(query: string): Promise<ToolObservation[]>;
async getToolsForFile(filePath: string): Promise<ToolObservation[]>;
```

## 5. 설계 결정 사항

### 5.1 왜 별도 이벤트 타입인가?

**대안 1: assistant_response에 포함**
```json
{
  "eventType": "assistant_response",
  "payload": {
    "content": "...",
    "tools_used": [{ "name": "Read", "output": "..." }]
  }
}
```
- 단점: 도구별 검색 어려움, 출력이 커짐

**대안 2: 별도 테이블**
```sql
CREATE TABLE tool_observations (...);
```
- 단점: 스키마 변경 필요, 일관성 관리 복잡

**선택: 기존 events 테이블에 새 event_type**
- 장점: 스키마 변경 없음
- 장점: 기존 쿼리 패턴 재사용
- 장점: 벡터 임베딩 파이프라인 공유

### 5.2 출력 압축 전략

**문제**: 도구 출력이 매우 클 수 있음 (대용량 파일 읽기)

**해결**:
1. 크기 제한 (10KB)
2. 줄 수 제한 (100줄)
3. Head + Tail 방식 (앞 50줄 + 뒤 50줄)
4. 도구별 특화 압축 (Grep은 파일 목록만)

### 5.3 민감 정보 처리

**현재 privacy.excludePatterns 활용**:
```typescript
const patterns = config.privacy.excludePatterns;
// ['password', 'secret', 'api_key']
```

**추가 필요**:
- 정규식 기반 마스킹
- 환경 변수 값 감지
- Bearer 토큰 패턴

### 5.4 임베딩 vs 저장만

**질문**: 모든 tool_observation을 임베딩해야 하나?

**결론**: 선택적 임베딩
- Read/Write: 파일 경로 + 첫 줄만 임베딩
- Bash: 명령어만 임베딩
- 전체 출력은 검색되지 않음 (너무 노이즈가 많음)

## 6. 성능 고려사항

### 6.1 훅 실행 시간

**제약**: 훅은 빨리 반환되어야 함 (Claude 응답 지연 방지)

**해결**:
```typescript
// 비동기 저장 (fire-and-forget)
async function handlePostToolUse(input: PostToolUseInput): Promise<void> {
  // 바로 반환, 저장은 백그라운드
  setImmediate(async () => {
    await storeObservation(input);
  });
}
```

### 6.2 저장 빈도

**문제**: 대화 중 수십 개의 도구가 실행될 수 있음

**해결**:
1. 배치 저장 (10개씩 모아서)
2. 중복 제거 (같은 파일 연속 Read)
3. 샘플링 (Glob 결과는 요약만)

### 6.3 벡터 저장소 크기

**문제**: tool_observation이 많아지면 벡터 DB 비대

**해결**:
1. TTL 적용 (30일 후 삭제)
2. 자주 사용되는 것만 임베딩 유지
3. graduation 적용 (L0에서 L4로 승급하는 것만 유지)

## 7. 참고 자료

- **claude-mem README**: 5 lifecycle hooks, observation storage
- **Claude Code Hooks**: 공식 훅 이벤트 문서
- **AXIOMMIND**: Principle 2 (Append-Only)
- **기존 specs**: entity-edge-model, vector-outbox-v2
