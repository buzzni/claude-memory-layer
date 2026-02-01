# PostToolUse Hook Specification

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-01
> **Reference**: claude-mem (thedotmack/claude-mem)

## 1. 개요

### 1.1 문제 정의

현재 시스템에서 도구 사용 결과가 메모리에 저장되지 않음:

1. **도구 실행 컨텍스트 손실**: 파일 읽기/쓰기 결과가 별도로 기록되지 않음
2. **작업 패턴 학습 불가**: 어떤 도구를 어떤 상황에서 사용했는지 추적 불가
3. **세션 재구성 어려움**: 과거 세션의 실제 작업 내용 파악 어려움

### 1.2 해결 방향

**PostToolUse 훅 추가**:
- 도구 실행 직후 호출되는 훅
- 도구 이름, 입력 파라미터, 출력 결과를 캡처
- EventStore에 `tool_observation` 이벤트로 저장

## 2. 핵심 개념

### 2.1 훅 라이프사이클

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code Session                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  session-start ────────────────────────────────────────────▶│
│       │                                                      │
│       ▼                                                      │
│  user-prompt-submit ◀──────────────────────────────────────┐│
│       │                                                     ││
│       ▼                                                     ││
│  [Agent Processing]                                         ││
│       │                                                     ││
│       ├── Tool Execution ─────┐                            ││
│       │                       ▼                            ││
│       │              post-tool-use (NEW)                   ││
│       │                       │                            ││
│       │◀──────────────────────┘                            ││
│       │                                                     ││
│       ▼                                                     ││
│    stop ───────────────────────────────────────────────────┘│
│       │                                                      │
│       ▼                                                      │
│  session-end                                                 │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 캡처할 데이터

| 필드 | 타입 | 설명 |
|------|------|------|
| tool_name | string | 실행된 도구 이름 (Read, Write, Bash 등) |
| tool_input | object | 도구에 전달된 파라미터 |
| tool_output | string | 도구 실행 결과 (truncated) |
| duration_ms | number | 실행 시간 |
| success | boolean | 성공/실패 여부 |
| error_message | string? | 실패 시 에러 메시지 |

### 2.3 지원 도구 목록

```typescript
type SupportedTool =
  | 'Read'           // 파일 읽기
  | 'Write'          // 파일 쓰기
  | 'Edit'           // 파일 편집
  | 'Bash'           // 명령 실행
  | 'Glob'           // 파일 검색
  | 'Grep'           // 내용 검색
  | 'WebFetch'       // 웹 요청
  | 'WebSearch'      // 웹 검색
  | 'Task'           // 서브에이전트
  | 'NotebookEdit';  // 노트북 편집
```

## 3. 이벤트 스키마

### 3.1 ToolObservation 이벤트

```typescript
const ToolObservationEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.literal('tool_observation'),
  sessionId: z.string(),
  timestamp: z.date(),
  payload: z.object({
    toolName: z.string(),
    toolInput: z.record(z.unknown()),
    toolOutput: z.string().max(10000),  // 10KB 제한
    durationMs: z.number(),
    success: z.boolean(),
    errorMessage: z.string().optional(),

    // 컨텍스트
    promptIndex: z.number(),        // 몇 번째 프롬프트에서 실행됐는지
    toolIndex: z.number(),          // 해당 프롬프트 내 몇 번째 도구인지

    // 메타데이터 (도구별 특화)
    metadata: z.object({
      // Read/Write/Edit
      filePath: z.string().optional(),
      fileType: z.string().optional(),
      lineCount: z.number().optional(),

      // Bash
      command: z.string().optional(),
      exitCode: z.number().optional(),

      // Grep/Glob
      pattern: z.string().optional(),
      matchCount: z.number().optional(),

      // WebFetch
      url: z.string().optional(),
      statusCode: z.number().optional()
    }).optional()
  })
});
```

### 3.2 도구별 메타데이터 예시

```typescript
// Read 도구
{
  toolName: 'Read',
  toolInput: { file_path: '/src/core/types.ts' },
  toolOutput: '// Type definitions...',  // truncated
  metadata: {
    filePath: '/src/core/types.ts',
    fileType: 'typescript',
    lineCount: 547
  }
}

// Bash 도구
{
  toolName: 'Bash',
  toolInput: { command: 'npm test' },
  toolOutput: 'All 42 tests passed',
  metadata: {
    command: 'npm test',
    exitCode: 0
  }
}

// Grep 도구
{
  toolName: 'Grep',
  toolInput: { pattern: 'async function', path: '/src' },
  toolOutput: 'Found 15 matches in 8 files',
  metadata: {
    pattern: 'async function',
    matchCount: 15
  }
}
```

## 4. 훅 인터페이스

### 4.1 훅 입력

```typescript
interface PostToolUseHookInput {
  // Claude Code에서 전달하는 데이터
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output: string;
  tool_error?: string;

  // 세션 컨텍스트
  session_id: string;
  conversation_id: string;

  // 타이밍 정보
  started_at: string;
  ended_at: string;
}
```

### 4.2 훅 출력

```typescript
interface PostToolUseHookOutput {
  // 저장 결과
  stored: boolean;
  event_id?: string;

  // 선택적 피드백 (Claude에게 전달)
  feedback?: string;

  // 에러
  error?: string;
}
```

## 5. 프라이버시 필터링

### 5.1 민감 정보 마스킹

```typescript
const SENSITIVE_PATTERNS = [
  /password\s*[:=]\s*['"]?[^\s'"]+/gi,
  /api[_-]?key\s*[:=]\s*['"]?[^\s'"]+/gi,
  /secret\s*[:=]\s*['"]?[^\s'"]+/gi,
  /token\s*[:=]\s*['"]?[^\s'"]+/gi,
  /bearer\s+[a-zA-Z0-9\-_.]+/gi,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi
];

function maskSensitiveData(content: string): string {
  let masked = content;
  for (const pattern of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, '[REDACTED]');
  }
  return masked;
}
```

### 5.2 제외할 도구

```typescript
const EXCLUDED_TOOLS = [
  'TodoWrite',      // 내부 상태 관리
  'TodoRead',
];

function shouldStore(toolName: string): boolean {
  return !EXCLUDED_TOOLS.includes(toolName);
}
```

## 6. 출력 압축

### 6.1 크기 제한

```typescript
const OUTPUT_LIMITS = {
  maxLength: 10000,           // 10KB
  maxLines: 100,              // 100줄
  truncationMarker: '\n...[TRUNCATED]...\n'
};

function truncateOutput(output: string): string {
  const lines = output.split('\n');

  if (lines.length > OUTPUT_LIMITS.maxLines) {
    const head = lines.slice(0, 50);
    const tail = lines.slice(-50);
    return head.join('\n') + OUTPUT_LIMITS.truncationMarker + tail.join('\n');
  }

  if (output.length > OUTPUT_LIMITS.maxLength) {
    return output.slice(0, OUTPUT_LIMITS.maxLength / 2) +
           OUTPUT_LIMITS.truncationMarker +
           output.slice(-OUTPUT_LIMITS.maxLength / 2);
  }

  return output;
}
```

### 6.2 도구별 압축 전략

| 도구 | 압축 전략 |
|------|----------|
| Read | 첫 50줄 + 마지막 50줄, 파일 타입 보존 |
| Bash | 전체 출력, exitCode 보존 |
| Grep | 매칭된 파일 목록만, 전체 내용 제외 |
| Glob | 파일 경로 목록만 |
| WebFetch | 첫 500자 요약 |

## 7. 벡터 임베딩 연동

### 7.1 임베딩 대상

```typescript
function createEmbeddingContent(observation: ToolObservation): string {
  const parts: string[] = [];

  // 도구 이름
  parts.push(`Tool: ${observation.toolName}`);

  // 주요 입력
  if (observation.metadata?.filePath) {
    parts.push(`File: ${observation.metadata.filePath}`);
  }
  if (observation.metadata?.command) {
    parts.push(`Command: ${observation.metadata.command}`);
  }
  if (observation.metadata?.pattern) {
    parts.push(`Pattern: ${observation.metadata.pattern}`);
  }

  // 결과 요약
  parts.push(`Result: ${observation.success ? 'Success' : 'Failed'}`);

  return parts.join('\n');
}
```

### 7.2 Outbox 연동

```typescript
// tool_observation도 Outbox에 추가하여 벡터화
await eventStore.append({
  eventType: 'tool_observation',
  payload: observation
});

// VectorWorker가 배치 처리
// embedding content: "Tool: Read\nFile: /src/types.ts\nResult: Success"
```

## 8. 검색 활용

### 8.1 도구 사용 이력 검색

```sql
-- 특정 파일 관련 도구 사용 이력
SELECT * FROM events
WHERE event_type = 'tool_observation'
  AND JSON_EXTRACT(payload_json, '$.metadata.filePath') LIKE '%types.ts%'
ORDER BY timestamp DESC
LIMIT 10;

-- 실패한 도구 실행 조회
SELECT * FROM events
WHERE event_type = 'tool_observation'
  AND JSON_EXTRACT(payload_json, '$.success') = false
ORDER BY timestamp DESC;
```

### 8.2 컨텍스트 주입 활용

```typescript
// user-prompt-submit에서 활용
async function getRelevantToolHistory(query: string): Promise<ToolObservation[]> {
  // 벡터 검색으로 관련 도구 사용 이력 조회
  const results = await vectorStore.search(query, {
    filter: { eventType: 'tool_observation' },
    topK: 5
  });

  return results.map(r => r.payload as ToolObservation);
}
```

## 9. 성공 기준

- [ ] PostToolUse 훅이 모든 도구 실행 후 호출됨
- [ ] tool_observation 이벤트가 EventStore에 저장됨
- [ ] 민감 정보가 마스킹됨
- [ ] 출력이 크기 제한 내로 압축됨
- [ ] 벡터 임베딩이 생성됨
- [ ] 도구 사용 이력 검색이 가능함
