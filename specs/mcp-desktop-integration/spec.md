# MCP Desktop Integration Specification

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-01
> **Reference**: claude-mem (thedotmack/claude-mem)

## 1. 개요

### 1.1 문제 정의

현재 code-memory는 Claude Code CLI 전용:

1. **Claude Desktop 미지원**: 데스크톱 앱에서 메모리 검색 불가
2. **환경 분리**: CLI와 Desktop 간 메모리 공유 안 됨
3. **접근성 제한**: 터미널 없이는 메모리 활용 불가

### 1.2 해결 방향

**MCP (Model Context Protocol) 서버**:
- Claude Desktop에서 메모리 검색 도구 제공
- CLI와 동일한 메모리 저장소 공유
- 표준 MCP 프로토콜 준수

## 2. 핵심 개념

### 2.1 MCP 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Desktop                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  MCP Client                                          │   │
│  │  - Tool Discovery                                    │   │
│  │  - Tool Invocation                                   │   │
│  └────────────────────────┬────────────────────────────┘   │
└───────────────────────────┼─────────────────────────────────┘
                            │ stdio / HTTP
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    MCP Server                                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  code-memory-mcp                                     │   │
│  │  - mem-search tool                                   │   │
│  │  - mem-timeline tool                                 │   │
│  │  - mem-details tool                                  │   │
│  └────────────────────────┬────────────────────────────┘   │
└───────────────────────────┼─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Memory Storage                            │
│  ┌──────────────┐    ┌──────────────┐                      │
│  │   DuckDB     │    │   LanceDB    │                      │
│  │   Events     │    │   Vectors    │                      │
│  └──────────────┘    └──────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 제공할 MCP 도구

| 도구 | 설명 | 입력 |
|------|------|------|
| `mem-search` | 메모리 검색 | query, filters |
| `mem-timeline` | 타임라인 조회 | ids, windowSize |
| `mem-details` | 상세 정보 조회 | ids |
| `mem-stats` | 통계 조회 | - |

### 2.3 MCP 프로토콜 버전

```typescript
const MCP_VERSION = '2024-11-05';  // 최신 MCP 사양
```

## 3. MCP 서버 구현

### 3.1 서버 메타데이터

```typescript
const serverInfo = {
  name: 'code-memory-mcp',
  version: '1.0.0',
  protocolVersion: MCP_VERSION,
  capabilities: {
    tools: {
      listChanged: false
    }
  }
};
```

### 3.2 도구 정의

```typescript
const tools = [
  {
    name: 'mem-search',
    description: 'Search code-memory for relevant past conversations and insights',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query'
        },
        topK: {
          type: 'number',
          description: 'Maximum results (default: 5)'
        },
        sessionId: {
          type: 'string',
          description: 'Filter by session ID'
        },
        eventType: {
          type: 'string',
          enum: ['prompt', 'response', 'tool', 'insight'],
          description: 'Filter by event type'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'mem-timeline',
    description: 'Get timeline context around specific memories',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Memory IDs to get timeline for'
        },
        windowSize: {
          type: 'number',
          description: 'Number of items before/after (default: 3)'
        }
      },
      required: ['ids']
    }
  },
  {
    name: 'mem-details',
    description: 'Get full details of specific memories',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Memory IDs to fetch'
        }
      },
      required: ['ids']
    }
  },
  {
    name: 'mem-stats',
    description: 'Get memory storage statistics',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];
```

### 3.3 도구 실행

```typescript
async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const memoryService = await MemoryService.getInstance();

  switch (name) {
    case 'mem-search': {
      const results = await memoryService.progressiveSearch(
        args.query as string,
        {
          topK: args.topK as number,
          filter: {
            sessionId: args.sessionId as string,
            eventType: args.eventType as string
          }
        }
      );

      return {
        content: [
          {
            type: 'text',
            text: formatSearchResults(results)
          }
        ]
      };
    }

    case 'mem-timeline': {
      const timeline = await memoryService.getTimeline(
        args.ids as string[],
        { windowSize: args.windowSize as number }
      );

      return {
        content: [
          {
            type: 'text',
            text: formatTimeline(timeline)
          }
        ]
      };
    }

    case 'mem-details': {
      const details = await memoryService.getDetails(args.ids as string[]);

      return {
        content: [
          {
            type: 'text',
            text: formatDetails(details)
          }
        ]
      };
    }

    case 'mem-stats': {
      const stats = await memoryService.getStats();

      return {
        content: [
          {
            type: 'text',
            text: formatStats(stats)
          }
        ]
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

## 4. 설치 및 설정

### 4.1 Claude Desktop 설정

**파일**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)

```json
{
  "mcpServers": {
    "code-memory": {
      "command": "npx",
      "args": ["code-memory-mcp"],
      "env": {
        "MEMORY_PATH": "~/.claude-code/memory"
      }
    }
  }
}
```

### 4.2 Windows 설정

**파일**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "code-memory": {
      "command": "npx.cmd",
      "args": ["code-memory-mcp"],
      "env": {
        "MEMORY_PATH": "%USERPROFILE%\\.claude-code\\memory"
      }
    }
  }
}
```

### 4.3 자동 설치 CLI

```bash
# 설치 명령
$ code-memory mcp install

Installing MCP server for Claude Desktop...
✓ Created MCP server configuration
✓ Updated Claude Desktop config

Restart Claude Desktop to use memory search.

# 제거 명령
$ code-memory mcp uninstall
```

## 5. 통신 프로토콜

### 5.1 stdio 기반 통신

```typescript
// MCP 서버 진입점
import { Server } from '@modelcontextprotocol/sdk/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';

const server = new Server(serverInfo, {
  capabilities: {
    tools: {}
  }
});

// 도구 핸들러 등록
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return handleToolCall(request.params.name, request.params.arguments);
});

// stdio 연결
const transport = new StdioServerTransport();
await server.connect(transport);
```

### 5.2 메시지 형식

```typescript
// 요청 예시
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "mem-search",
    "arguments": {
      "query": "DuckDB schema design"
    }
  }
}

// 응답 예시
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Found 3 relevant memories:\n\n1. [mem:a7Bc3x] ..."
      }
    ]
  }
}
```

## 6. 출력 포맷

### 6.1 검색 결과

```markdown
## Memory Search Results

Found 3 relevant memories for "DuckDB schema":

### 1. [mem:a7Bc3x] (0.94)
**Session**: abc123 | **Date**: 2026-01-30
> DuckDB를 사용하여 이벤트 소싱 패턴을 구현하는 것이 좋습니다...

### 2. [mem:b8Xc2y] (0.87)
**Session**: def456 | **Date**: 2026-01-29
> 스키마 설계 시 인덱싱 전략을 고려해야 합니다...

---
Use `mem-details` with IDs for full content.
Use `mem-timeline` for context around these memories.
```

### 6.2 타임라인

```markdown
## Timeline Context

### Around [mem:a7Bc3x]

| Time | Type | Preview |
|------|------|---------|
| 14:00 | prompt | DB 스키마를 어떻게 설계할까요? |
| **14:05** | **response** | **[mem:a7Bc3x] DuckDB를 사용하여...** |
| 14:10 | prompt | 인덱스는 어떻게? |
| 14:15 | response | 다음 인덱스들을 추천합니다... |
```

### 6.3 상세 정보

```markdown
## Memory Details

### [mem:a7Bc3x]

**Session**: abc123
**Date**: 2026-01-30 14:05
**Type**: assistant_response

**Content**:
```
DuckDB를 사용하여 이벤트 소싱 패턴을 구현하는 것이 좋습니다.

이벤트는 불변이어야 하며, append-only 방식으로 저장합니다.

스키마 예시:
CREATE TABLE events (
  event_id VARCHAR PRIMARY KEY,
  event_type VARCHAR NOT NULL,
  ...
);
```

**Related Files**: src/core/event-store.ts
**Tools Used**: Read, Write
```

## 7. 보안

### 7.1 로컬 전용

```typescript
// MCP 서버는 로컬에서만 실행
// 네트워크 노출 없음
const server = new Server(serverInfo);
const transport = new StdioServerTransport();  // stdio만 사용
```

### 7.2 경로 검증

```typescript
function validateMemoryPath(path: string): boolean {
  const resolved = path.resolve(path);

  // 홈 디렉토리 하위만 허용
  const home = os.homedir();
  if (!resolved.startsWith(home)) {
    throw new Error('Memory path must be under home directory');
  }

  return true;
}
```

### 7.3 민감 정보 필터링

```typescript
// MCP 응답에서도 privacy 필터 적용
function formatForMCP(content: string): string {
  return applyPrivacyFilter(content, config.privacy).content;
}
```

## 8. 에러 처리

```typescript
// MCP 에러 응답
function handleError(error: Error): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `Error: ${error.message}`
      }
    ],
    isError: true
  };
}

// 일반적인 에러 케이스
- Memory storage not found
- Invalid query parameters
- Permission denied
- Storage corrupted
```

## 9. 성공 기준

- [ ] `code-memory mcp install` 명령 동작
- [ ] Claude Desktop에서 `mem-search` 도구 사용 가능
- [ ] Progressive disclosure (search → timeline → details) 동작
- [ ] CLI와 동일한 메모리 저장소 공유
- [ ] Privacy 필터 적용
- [ ] 에러 시 적절한 메시지 반환
