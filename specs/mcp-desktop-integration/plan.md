# MCP Desktop Integration Implementation Plan

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-01

## Phase 1: MCP 서버 기본 구조 (P0)

### 1.1 프로젝트 설정

**파일**: `packages/mcp-server/package.json` (신규)

```json
{
  "name": "code-memory-mcp",
  "version": "1.0.0",
  "description": "MCP server for code-memory",
  "main": "dist/index.js",
  "bin": {
    "code-memory-mcp": "./dist/index.js"
  },
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=node --outfile=dist/index.js",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "code-memory-core": "workspace:*"
  }
}
```

**작업 항목**:
- [ ] MCP 서버 패키지 생성
- [ ] dependencies 설정
- [ ] 빌드 스크립트 설정

### 1.2 서버 진입점

**파일**: `packages/mcp-server/src/index.ts` (신규)

```typescript
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types';

import { tools } from './tools';
import { handleToolCall } from './handlers';

const server = new Server(
  {
    name: 'code-memory-mcp',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// 도구 목록 핸들러
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// 도구 호출 핸들러
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleToolCall(name, args || {});
});

// stdio 연결 및 시작
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('code-memory MCP server started');
}

main().catch(console.error);
```

**작업 항목**:
- [ ] 서버 초기화
- [ ] 핸들러 등록
- [ ] stdio 연결

### 1.3 도구 정의

**파일**: `packages/mcp-server/src/tools.ts` (신규)

```typescript
import { Tool } from '@modelcontextprotocol/sdk/types';

export const tools: Tool[] = [
  {
    name: 'mem-search',
    description: 'Search code-memory for relevant past conversations and insights. Returns a compact index of results - use mem-details to get full content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query'
        },
        topK: {
          type: 'number',
          description: 'Maximum number of results (default: 5, max: 20)'
        },
        sessionId: {
          type: 'string',
          description: 'Optional: filter by specific session ID'
        },
        eventType: {
          type: 'string',
          enum: ['prompt', 'response', 'tool', 'insight'],
          description: 'Optional: filter by event type'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'mem-timeline',
    description: 'Get chronological context around specific memories. Useful for understanding the conversation flow.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Memory IDs (from mem-search) to get timeline for'
        },
        windowSize: {
          type: 'number',
          description: 'Number of items before/after each ID (default: 3)'
        }
      },
      required: ['ids']
    }
  },
  {
    name: 'mem-details',
    description: 'Get full content of specific memories. Use after mem-search to get complete information.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Memory IDs to fetch full details for'
        }
      },
      required: ['ids']
    }
  },
  {
    name: 'mem-stats',
    description: 'Get statistics about the memory storage (total events, sessions, etc.)',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];
```

**작업 항목**:
- [ ] mem-search 도구 정의
- [ ] mem-timeline 도구 정의
- [ ] mem-details 도구 정의
- [ ] mem-stats 도구 정의

## Phase 2: 핸들러 구현 (P0)

### 2.1 도구 핸들러

**파일**: `packages/mcp-server/src/handlers.ts` (신규)

```typescript
import { ToolResult } from '@modelcontextprotocol/sdk/types';
import { MemoryService } from 'code-memory-core';
import { formatSearchResults, formatTimeline, formatDetails, formatStats } from './formatters';

let memoryService: MemoryService | null = null;

async function getMemoryService(): Promise<MemoryService> {
  if (!memoryService) {
    memoryService = await MemoryService.getInstance({
      storagePath: process.env.MEMORY_PATH || '~/.claude-code/memory'
    });
  }
  return memoryService;
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const service = await getMemoryService();

    switch (name) {
      case 'mem-search':
        return await handleMemSearch(service, args);

      case 'mem-timeline':
        return await handleMemTimeline(service, args);

      case 'mem-details':
        return await handleMemDetails(service, args);

      case 'mem-stats':
        return await handleMemStats(service);

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true
        };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${(error as Error).message}` }],
      isError: true
    };
  }
}

async function handleMemSearch(
  service: MemoryService,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const query = args.query as string;
  const topK = Math.min((args.topK as number) || 5, 20);

  const results = await service.progressiveSearch(query, {
    topK,
    filter: {
      sessionId: args.sessionId as string,
      eventType: args.eventType as string
    }
  });

  return {
    content: [{
      type: 'text',
      text: formatSearchResults(results)
    }]
  };
}

// 다른 핸들러들도 유사하게 구현
```

**작업 항목**:
- [ ] handleMemSearch 구현
- [ ] handleMemTimeline 구현
- [ ] handleMemDetails 구현
- [ ] handleMemStats 구현
- [ ] 에러 처리

### 2.2 포맷터

**파일**: `packages/mcp-server/src/formatters.ts` (신규)

```typescript
import { ProgressiveSearchResult, TimelineItem, FullDetail, Stats } from 'code-memory-core';

export function formatSearchResults(results: ProgressiveSearchResult): string {
  const lines: string[] = [
    '## Memory Search Results',
    '',
    `Found ${results.index.length} relevant memories:`,
    ''
  ];

  for (let i = 0; i < results.index.length; i++) {
    const item = results.index[i];
    const score = item.score.toFixed(2);
    const date = new Date(item.timestamp).toLocaleDateString();

    lines.push(`### ${i + 1}. [mem:${item.id}] (${score})`);
    lines.push(`**Session**: ${item.sessionId.slice(0, 8)} | **Date**: ${date}`);
    lines.push(`> ${item.summary}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('*Use `mem-details` with IDs for full content.*');
  lines.push('*Use `mem-timeline` for context around these memories.*');

  return lines.join('\n');
}

export function formatTimeline(items: TimelineItem[]): string {
  const lines: string[] = [
    '## Timeline Context',
    '',
    '| Time | Type | Preview |',
    '|------|------|---------|'
  ];

  for (const item of items) {
    const time = new Date(item.timestamp).toLocaleTimeString();
    const marker = item.isTarget ? '**' : '';
    const preview = item.preview.slice(0, 50) + (item.preview.length > 50 ? '...' : '');

    lines.push(`| ${marker}${time}${marker} | ${item.type} | ${marker}${preview}${marker} |`);
  }

  return lines.join('\n');
}

export function formatDetails(details: FullDetail[]): string {
  return details.map(detail => {
    const date = new Date(detail.timestamp).toLocaleString();

    return [
      `## Memory Details: [mem:${detail.id}]`,
      '',
      `**Session**: ${detail.sessionId}`,
      `**Date**: ${date}`,
      `**Type**: ${detail.type}`,
      '',
      '**Content**:',
      '```',
      detail.content,
      '```',
      ''
    ].join('\n');
  }).join('\n---\n\n');
}

export function formatStats(stats: Stats): string {
  return [
    '## Memory Statistics',
    '',
    `- **Total Events**: ${stats.eventCount}`,
    `- **Total Vectors**: ${stats.vectorCount}`,
    `- **Sessions**: ${stats.sessionCount}`,
    `- **Storage Size**: ${(stats.storageSize / 1024 / 1024).toFixed(2)} MB`,
    ''
  ].join('\n');
}
```

**작업 항목**:
- [ ] formatSearchResults 구현
- [ ] formatTimeline 구현
- [ ] formatDetails 구현
- [ ] formatStats 구현

## Phase 3: 설치 CLI (P0)

### 3.1 MCP 설치 명령

**파일**: `src/cli/commands/mcp.ts` (신규)

```typescript
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const mcpCommand = new Command('mcp')
  .description('Manage MCP server for Claude Desktop');

mcpCommand
  .command('install')
  .description('Install MCP server for Claude Desktop')
  .action(async () => {
    const configPath = getClaudeDesktopConfigPath();
    const config = loadOrCreateConfig(configPath);

    // MCP 서버 설정 추가
    config.mcpServers = config.mcpServers || {};
    config.mcpServers['code-memory'] = {
      command: 'npx',
      args: ['code-memory-mcp'],
      env: {
        MEMORY_PATH: path.join(os.homedir(), '.claude-code', 'memory')
      }
    };

    // 설정 저장
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    console.log('✓ MCP server configuration added');
    console.log('');
    console.log('Restart Claude Desktop to use memory search.');
    console.log('');
    console.log('Available tools:');
    console.log('  - mem-search: Search past conversations');
    console.log('  - mem-timeline: Get context around memories');
    console.log('  - mem-details: Get full memory content');
    console.log('  - mem-stats: View storage statistics');
  });

mcpCommand
  .command('uninstall')
  .description('Remove MCP server from Claude Desktop')
  .action(async () => {
    const configPath = getClaudeDesktopConfigPath();
    const config = loadOrCreateConfig(configPath);

    if (config.mcpServers?.['code-memory']) {
      delete config.mcpServers['code-memory'];
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('✓ MCP server configuration removed');
    } else {
      console.log('MCP server was not installed');
    }
  });

mcpCommand
  .command('status')
  .description('Check MCP server installation status')
  .action(async () => {
    const configPath = getClaudeDesktopConfigPath();

    if (!fs.existsSync(configPath)) {
      console.log('Claude Desktop config not found');
      return;
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    if (config.mcpServers?.['code-memory']) {
      console.log('✓ MCP server is installed');
      console.log('');
      console.log('Configuration:');
      console.log(JSON.stringify(config.mcpServers['code-memory'], null, 2));
    } else {
      console.log('✗ MCP server is not installed');
      console.log('');
      console.log('Run "code-memory mcp install" to install');
    }
  });

function getClaudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  } else if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
  } else {
    return path.join(os.homedir(), '.config', 'claude', 'claude_desktop_config.json');
  }
}

function loadOrCreateConfig(configPath: string): any {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  return {};
}
```

**작업 항목**:
- [ ] install 명령 구현
- [ ] uninstall 명령 구현
- [ ] status 명령 구현
- [ ] 플랫폼별 경로 처리

## Phase 4: 테스트 및 문서 (P1)

### 4.1 통합 테스트

**파일**: `packages/mcp-server/tests/integration.test.ts` (신규)

```typescript
import { handleToolCall } from '../src/handlers';

describe('MCP Server', () => {
  test('mem-search returns results', async () => {
    const result = await handleToolCall('mem-search', {
      query: 'test query'
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe('text');
  });

  test('mem-details returns full content', async () => {
    const result = await handleToolCall('mem-details', {
      ids: ['test-id']
    });

    expect(result.isError).toBeFalsy();
  });

  test('invalid tool returns error', async () => {
    const result = await handleToolCall('invalid-tool', {});

    expect(result.isError).toBe(true);
  });
});
```

**작업 항목**:
- [ ] 도구별 테스트
- [ ] 에러 케이스 테스트
- [ ] E2E 테스트 (실제 Claude Desktop)

## 파일 목록

### 신규 파일
```
packages/mcp-server/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # 서버 진입점
│   ├── tools.ts           # 도구 정의
│   ├── handlers.ts        # 도구 핸들러
│   └── formatters.ts      # 출력 포맷터
└── tests/
    └── integration.test.ts

src/cli/commands/mcp.ts    # CLI 명령
```

### 수정 파일
```
package.json               # 워크스페이스 설정
src/cli/index.ts           # mcp 명령 등록
```

## Phase 5: Agent Context Tools 실데이터 Hardening (P0)

### 5.1 Vector schema mismatch fallback

**문제**: 2026-05-10 실제 `claude-memory-layer` project data에서 MCP `mem-context-pack`/`mem-search`가 LanceDB vector dimension mismatch(`No vector column found to match with the query vector dimension: 384`)로 실패했다. CLI `search`는 같은 프로젝트에서 fallback/keyword 기반으로 성공했다.

**작업 항목**:
- [x] `ProgressiveRetriever.smartSearch()` 또는 MCP handler 경계에서 vector query 예외를 잡고 keyword/recent timeline fallback을 수행한다.
- [x] fallback 응답에 `warning: semantic vector search unavailable; using keyword/timeline fallback`을 포함한다.
- [ ] embedder 모델/차원 변경 시 오래된 LanceDB table을 detect하고 rebuild/reopen 안내를 제공한다.
- [x] 회귀 테스트: vector table dimension mismatch fixture에서도 `mem-context-pack`은 `isError=false`와 recent timeline을 반환한다.

### 5.2 Project isolation 보강

**문제**: direct handler smoke에서 `projectPath=/Users/namsangboy/workspace/claude-memory-layer`인데 `predictor`, Streamlit 등 다른 workspace signal이 context pack에 섞인 사례가 있었다. Hermes validation도 project context가 없는 66개 session을 경고했다.

**작업 항목**:
- [x] Hermes imported session metadata에 canonical `projectPath`를 저장하고 retrieval/timeline 쿼리에서 필수 필터로 사용한다. Codex metadata parity는 기존 importer 경로와 함께 별도 parity 검증을 이어간다.
- [x] project context가 없는 Hermes session은 explicit session import가 아닌 한 project-scoped auto-refresh 대상에서 제외한다.
- [x] `mem-project-timeline`/`mem-context-pack`에 `containsOtherProject` 회귀 테스트를 추가한다.
- [x] Generic continuation query는 semantic relevance보다 same-project recent timeline을 우선한다.

### 5.3 CLI/MCP parity 및 long-lived service freshness

**문제**: 같은 `projectPath`에 대해 CLI stats는 `Vector Count: 0`, MCP stats는 `Total Vectors: 23`으로 관측되었다. Long-lived MCP server가 오래된 index/schema/service instance를 유지할 수 있다.

**작업 항목**:
- [x] CLI와 MCP가 동일한 project registry/storage path를 사용하는지 parity test를 추가한다.
- [x] `mem-stats`에 embedder model, vector table dimension 상태, pending embeddings, storage path label을 safe metadata로 표시한다.
- [x] MCP `mem-stats`에 CLI/MCP count mismatch 시 long-lived MCP/Hermes gateway restart 안내를 표시한다.
- [ ] Follow-up: LanceDB table schema/vector dimension을 실제 vector metadata에서 introspect하고 mismatch 시 service reopen 또는 deterministic repair guidance를 반환한다.

### 5.4 Real-data smoke script

**검증 명령 묶음**:
```bash
npm run typecheck
npm run build
npm test -- --run
npm run eval:retrieval-replay
node dist/cli/index.js codex validate -p "$PWD" -l 50 --format json --anonymize-projects
node dist/cli/index.js hermes validate -p "$PWD" -l 50 --format json
node dist/cli/index.js codex import -p "$PWD" --session-limit 2 -l 120 --no-process-embeddings
node dist/cli/index.js hermes import -p "$PWD" --session-limit 2 -l 120 --no-process-embeddings
node dist/cli/index.js search "claude-memory-layer MCP context pack refreshLatest" -p "$PWD" -k 5 -s 0.1
# MCP native: mem-stats, mem-context-pack(query=continue), mem-search(query=...)
```

**완료 조건**:
- [x] CLI smoke 명령이 모두 exit 0.
- [x] MCP native `mem-context-pack`와 `mem-search`가 실제 project data에서 fallback/safe output을 반환.
- [x] Smoke report가 `/tmp/cml-mcp-realdata-smoke-final.json`로 남고 raw vector error 및 cross-project signal 검사를 통과.
- [ ] Follow-up: ad-hoc `tsx` direct handler smoke는 결과 파일 생성 후에도 LanceDB/native shutdown 경로에서 `libc++abi: mutex lock failed` / exit 134가 발생할 수 있다. 정식 smoke runner는 MCP server lifecycle 또는 controlled `process.exit(0)` 방식으로 native shutdown을 안정화한다.

## 마일스톤

| 단계 | 완료 기준 |
|------|----------|
| M1 | MCP 서버 패키지 구조 |
| M2 | 도구 정의 |
| M3 | 핸들러 구현 |
| M4 | 포맷터 구현 |
| M5 | CLI 설치 명령 |
| M6 | 테스트 |
| M7 | 문서화 |
| M8 | npm 배포 |
| M9 | Agent context tools real-data hardening |
