# PostToolUse Hook Implementation Plan

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-01

## Phase 1: 타입 정의 (P0)

### 1.1 이벤트 스키마 추가

**파일**: `src/core/types.ts` 수정

```typescript
// 추가할 타입들
export const ToolObservationPayloadSchema = z.object({
  toolName: z.string(),
  toolInput: z.record(z.unknown()),
  toolOutput: z.string(),
  durationMs: z.number(),
  success: z.boolean(),
  errorMessage: z.string().optional(),
  promptIndex: z.number(),
  toolIndex: z.number(),
  metadata: z.object({
    filePath: z.string().optional(),
    fileType: z.string().optional(),
    lineCount: z.number().optional(),
    command: z.string().optional(),
    exitCode: z.number().optional(),
    pattern: z.string().optional(),
    matchCount: z.number().optional(),
    url: z.string().optional(),
    statusCode: z.number().optional()
  }).optional()
});

export type ToolObservationPayload = z.infer<typeof ToolObservationPayloadSchema>;
```

**작업 항목**:
- [ ] ToolObservationPayloadSchema 추가
- [ ] EventType에 'tool_observation' 추가
- [ ] EventPayload union에 ToolObservationPayload 추가

### 1.2 설정 스키마 확장

**파일**: `src/core/types.ts` 수정

```typescript
// 설정에 tool observation 옵션 추가
export const ConfigSchema = z.object({
  // ... 기존 설정
  toolObservation: z.object({
    enabled: z.boolean().default(true),
    excludedTools: z.array(z.string()).default(['TodoWrite', 'TodoRead']),
    maxOutputLength: z.number().default(10000),
    maxOutputLines: z.number().default(100),
    storeOnlyOnSuccess: z.boolean().default(false)
  }).optional()
});
```

**작업 항목**:
- [ ] toolObservation 설정 스키마 추가
- [ ] 기본값 정의

## Phase 2: 훅 구현 (P0)

### 2.1 PostToolUse 훅 파일 생성

**파일**: `src/hooks/post-tool-use.ts` (신규)

```typescript
import { MemoryService } from '../services/memory-service';
import { maskSensitiveData, truncateOutput } from '../core/privacy';

interface PostToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output: string;
  tool_error?: string;
  session_id: string;
  started_at: string;
  ended_at: string;
}

export async function handlePostToolUse(input: PostToolUseInput): Promise<void> {
  const memoryService = await MemoryService.getInstance();
  const config = await memoryService.getConfig();

  // 1. 제외 도구 체크
  if (config.toolObservation?.excludedTools?.includes(input.tool_name)) {
    return;
  }

  // 2. 실패 시 저장 스킵 옵션
  const success = !input.tool_error;
  if (!success && config.toolObservation?.storeOnlyOnSuccess) {
    return;
  }

  // 3. 민감 정보 마스킹
  const maskedOutput = maskSensitiveData(input.tool_output);
  const maskedInput = maskSensitiveInput(input.tool_input);

  // 4. 출력 압축
  const truncatedOutput = truncateOutput(maskedOutput, {
    maxLength: config.toolObservation?.maxOutputLength,
    maxLines: config.toolObservation?.maxOutputLines
  });

  // 5. 메타데이터 추출
  const metadata = extractMetadata(input.tool_name, maskedInput, success);

  // 6. 이벤트 저장
  await memoryService.storeToolObservation({
    toolName: input.tool_name,
    toolInput: maskedInput,
    toolOutput: truncatedOutput,
    durationMs: calculateDuration(input.started_at, input.ended_at),
    success,
    errorMessage: input.tool_error,
    metadata
  });
}
```

**작업 항목**:
- [ ] handlePostToolUse 함수 구현
- [ ] 제외 도구 체크 로직
- [ ] 성공/실패 필터링 로직
- [ ] 메타데이터 추출 함수

### 2.2 프라이버시 유틸리티

**파일**: `src/core/privacy.ts` (신규 또는 확장)

```typescript
const SENSITIVE_PATTERNS = [
  /password\s*[:=]\s*['"]?[^\s'"]+/gi,
  /api[_-]?key\s*[:=]\s*['"]?[^\s'"]+/gi,
  /secret\s*[:=]\s*['"]?[^\s'"]+/gi,
  /token\s*[:=]\s*['"]?[^\s'"]+/gi,
  /bearer\s+[a-zA-Z0-9\-_.]+/gi,
];

export function maskSensitiveData(content: string): string {
  let masked = content;
  for (const pattern of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, '[REDACTED]');
  }
  return masked;
}

export function truncateOutput(
  output: string,
  options: { maxLength?: number; maxLines?: number }
): string {
  const { maxLength = 10000, maxLines = 100 } = options;
  // ... 구현
}
```

**작업 항목**:
- [ ] maskSensitiveData 함수
- [ ] maskSensitiveInput 함수 (JSON 재귀 마스킹)
- [ ] truncateOutput 함수
- [ ] 도구별 압축 전략 구현

### 2.3 메타데이터 추출기

**파일**: `src/core/metadata-extractor.ts` (신규)

```typescript
export function extractMetadata(
  toolName: string,
  input: Record<string, unknown>,
  success: boolean
): ToolMetadata {
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return {
        filePath: input.file_path as string,
        fileType: getFileType(input.file_path as string)
      };

    case 'Bash':
      return {
        command: input.command as string
      };

    case 'Grep':
      return {
        pattern: input.pattern as string
      };

    // ... 기타 도구

    default:
      return {};
  }
}
```

**작업 항목**:
- [ ] extractMetadata 함수
- [ ] 도구별 메타데이터 추출 로직
- [ ] getFileType 유틸리티

## Phase 3: 서비스 연동 (P0)

### 3.1 MemoryService 확장

**파일**: `src/services/memory-service.ts` 수정

```typescript
export class MemoryService {
  // 기존 메서드들...

  async storeToolObservation(observation: ToolObservationPayload): Promise<string> {
    const eventId = await this.eventStore.append({
      eventType: 'tool_observation',
      sessionId: this.currentSessionId,
      payload: observation
    });

    // 임베딩을 위한 outbox 추가
    await this.eventStore.addToOutbox(eventId);

    return eventId;
  }
}
```

**작업 항목**:
- [ ] storeToolObservation 메서드 추가
- [ ] Outbox 연동

### 3.2 임베딩 콘텐츠 생성

**파일**: `src/core/embedder.ts` 수정

```typescript
export function createEmbeddingContent(event: Event): string {
  if (event.eventType === 'tool_observation') {
    return createToolObservationEmbedding(event.payload);
  }
  // 기존 로직...
}

function createToolObservationEmbedding(payload: ToolObservationPayload): string {
  const parts: string[] = [];

  parts.push(`Tool: ${payload.toolName}`);

  if (payload.metadata?.filePath) {
    parts.push(`File: ${payload.metadata.filePath}`);
  }
  if (payload.metadata?.command) {
    parts.push(`Command: ${payload.metadata.command}`);
  }
  if (payload.metadata?.pattern) {
    parts.push(`Pattern: ${payload.metadata.pattern}`);
  }

  parts.push(`Result: ${payload.success ? 'Success' : 'Failed'}`);

  return parts.join('\n');
}
```

**작업 항목**:
- [ ] tool_observation 이벤트용 임베딩 콘텐츠 생성
- [ ] VectorWorker에서 tool_observation 처리

## Phase 4: 훅 등록 (P0)

### 4.1 hooks.json 수정

**파일**: `.claude-plugin/hooks.json` 수정

```json
{
  "hooks": [
    {
      "event": "session-start",
      "script": "node dist/hooks/session-start.js"
    },
    {
      "event": "user-prompt-submit",
      "script": "node dist/hooks/user-prompt-submit.js"
    },
    {
      "event": "post-tool-use",
      "script": "node dist/hooks/post-tool-use.js"
    },
    {
      "event": "stop",
      "script": "node dist/hooks/stop.js"
    },
    {
      "event": "session-end",
      "script": "node dist/hooks/session-end.js"
    }
  ]
}
```

**작업 항목**:
- [ ] post-tool-use 훅 등록
- [ ] 스크립트 경로 확인

### 4.2 빌드 스크립트 수정

**파일**: `package.json` 또는 빌드 설정

```json
{
  "scripts": {
    "build:hooks": "esbuild src/hooks/*.ts --bundle --platform=node --outdir=dist/hooks"
  }
}
```

**작업 항목**:
- [ ] post-tool-use.ts 빌드 포함
- [ ] 번들 테스트

## Phase 5: 검색 연동 (P1)

### 5.1 Retriever 확장

**파일**: `src/core/retriever.ts` 수정

```typescript
export class Retriever {
  async searchToolHistory(query: string, options?: SearchOptions): Promise<ToolObservation[]> {
    const vectorResults = await this.vectorStore.search(query, {
      filter: { eventType: 'tool_observation' },
      topK: options?.topK ?? 5
    });

    return vectorResults.map(r => r.payload as ToolObservation);
  }

  async getRecentToolsForFile(filePath: string): Promise<ToolObservation[]> {
    // 특정 파일 관련 최근 도구 사용 조회
    return this.eventStore.query({
      eventType: 'tool_observation',
      filter: { 'payload.metadata.filePath': filePath },
      orderBy: 'timestamp DESC',
      limit: 10
    });
  }
}
```

**작업 항목**:
- [ ] searchToolHistory 메서드
- [ ] getRecentToolsForFile 메서드
- [ ] 필터링 옵션

### 5.2 user-prompt-submit 확장

**파일**: `src/hooks/user-prompt-submit.ts` 수정

```typescript
async function handleUserPromptSubmit(input: UserPromptInput): Promise<HookOutput> {
  // 기존 메모리 검색
  const memories = await retriever.search(input.prompt);

  // 관련 도구 사용 이력 추가
  const toolHistory = await retriever.searchToolHistory(input.prompt, { topK: 3 });

  // 컨텍스트 조합
  return {
    context: formatContext(memories, toolHistory)
  };
}
```

**작업 항목**:
- [ ] 도구 이력을 컨텍스트에 포함
- [ ] 포맷팅 함수 확장

## 파일 목록

### 신규 파일
```
src/hooks/post-tool-use.ts       # 메인 훅 구현
src/core/privacy.ts              # 프라이버시 유틸리티
src/core/metadata-extractor.ts   # 메타데이터 추출
```

### 수정 파일
```
src/core/types.ts                # ToolObservationPayload 추가
src/services/memory-service.ts   # storeToolObservation 메서드
src/core/embedder.ts             # 임베딩 콘텐츠 생성
src/core/retriever.ts            # 도구 이력 검색
src/hooks/user-prompt-submit.ts  # 컨텍스트 포함
.claude-plugin/hooks.json        # 훅 등록
```

## 테스트

### 필수 테스트 케이스

1. **훅 호출 테스트**
   ```typescript
   test('should store tool observation after Read', async () => {
     await handlePostToolUse({
       tool_name: 'Read',
       tool_input: { file_path: '/test.ts' },
       tool_output: 'file content...',
       session_id: 'session_1',
       started_at: '2026-02-01T10:00:00Z',
       ended_at: '2026-02-01T10:00:01Z'
     });

     const events = await eventStore.query({ eventType: 'tool_observation' });
     expect(events.length).toBe(1);
   });
   ```

2. **민감 정보 마스킹**
   ```typescript
   test('should mask sensitive data', () => {
     const input = 'password=secret123';
     const masked = maskSensitiveData(input);
     expect(masked).toBe('[REDACTED]');
   });
   ```

3. **제외 도구 스킵**
   ```typescript
   test('should skip excluded tools', async () => {
     await handlePostToolUse({
       tool_name: 'TodoWrite',
       // ...
     });

     const events = await eventStore.query({ eventType: 'tool_observation' });
     expect(events.length).toBe(0);
   });
   ```

4. **출력 압축**
   ```typescript
   test('should truncate long output', () => {
     const longOutput = 'x'.repeat(20000);
     const truncated = truncateOutput(longOutput, { maxLength: 10000 });
     expect(truncated.length).toBeLessThanOrEqual(10100);  // marker 포함
   });
   ```

## 마일스톤

| 단계 | 완료 기준 |
|------|----------|
| M1 | 타입 정의 완료 |
| M2 | 훅 기본 구현 (저장만) |
| M3 | 프라이버시 필터링 |
| M4 | 출력 압축 |
| M5 | 임베딩 연동 |
| M6 | 검색 연동 |
| M7 | 테스트 통과 |
