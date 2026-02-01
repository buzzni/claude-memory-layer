# MCP Desktop Integration Context

> **Version**: 1.0.0
> **Created**: 2026-02-01

## 1. 배경

### 1.1 claude-mem의 접근 방식

claude-mem은 MCP (Model Context Protocol)를 통해 Claude Desktop 통합 제공:

```
Claude Desktop → MCP Client → claude-mem MCP Server → Memory Storage
```

**특징**:
- `mem-search` 도구로 자연어 검색
- Progressive disclosure 패턴 지원
- 동일한 메모리 저장소 공유

### 1.2 MCP란?

**Model Context Protocol (MCP)**:
- Anthropic이 개발한 표준 프로토콜
- AI 모델과 외부 도구/데이터 연결
- JSON-RPC 기반 통신
- stdio 또는 HTTP 전송

### 1.3 현재 code-memory의 상황

현재 Claude Code CLI 전용:

```
Claude Code CLI → Hooks → Memory Storage
                    ↓
              (Desktop 접근 불가)
```

**문제**:
1. Claude Desktop에서 메모리 활용 불가
2. CLI 없이는 검색 불가
3. 환경 간 메모리 분리

## 2. MCP 프로토콜 이해

### 2.1 핵심 개념

```
┌─────────────────┐       ┌─────────────────┐
│   MCP Client    │◀─────▶│   MCP Server    │
│ (Claude Desktop)│ JSON  │ (code-memory)   │
└─────────────────┘  RPC  └─────────────────┘
```

**Client**: Claude Desktop, Claude.ai
**Server**: 도구/데이터 제공자
**Transport**: stdio (로컬), HTTP (원격)

### 2.2 메시지 형식

```typescript
// 요청
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "mem-search",
    "arguments": { "query": "..." }
  }
}

// 응답
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "..." }]
  }
}
```

### 2.3 도구 정의

```typescript
interface Tool {
  name: string;           // 도구 이름
  description: string;    // Claude에게 보여질 설명
  inputSchema: JSONSchema; // 입력 스키마
}
```

## 3. 기존 코드와의 관계

### 3.1 MemoryService 재사용

MCP 서버는 동일한 MemoryService 사용:

```typescript
// CLI
const service = await MemoryService.getInstance();
await service.search(query);

// MCP Server
const service = await MemoryService.getInstance();
await service.search(query);  // 동일한 코드
```

### 3.2 Progressive Retriever 재사용

```typescript
// MCP mem-search → ProgressiveRetriever.smartSearch()
// MCP mem-timeline → ProgressiveRetriever.getTimeline()
// MCP mem-details → ProgressiveRetriever.getDetails()
```

### 3.3 저장소 공유

```
~/.claude-code/memory/
├── events.duckdb    ← CLI, MCP 모두 접근
└── vectors/         ← CLI, MCP 모두 접근
```

## 4. 설계 결정 사항

### 4.1 패키지 구조

**옵션 1: 단일 패키지**
```
code-memory/
├── src/
│   ├── cli/
│   ├── core/
│   └── mcp/
```

**옵션 2: 별도 패키지 (선택)**
```
code-memory/
├── packages/
│   ├── core/       # 공유 로직
│   ├── cli/        # CLI
│   └── mcp-server/ # MCP 서버
```

**선택 이유**:
- 독립적 버전 관리
- npm 별도 배포 가능
- 의존성 분리

### 4.2 전송 방식

**stdio (선택)**:
- Claude Desktop 기본 지원
- 로컬 실행, 보안 이점
- 설정 간단

**HTTP**:
- 원격 접근 가능
- 추가 보안 필요
- 포트 충돌 가능

### 4.3 도구 설계

**Progressive Disclosure 패턴**:
1. `mem-search`: Layer 1 (인덱스)
2. `mem-timeline`: Layer 2 (타임라인)
3. `mem-details`: Layer 3 (상세)

**이유**:
- 토큰 효율성
- 단계적 정보 제공
- 필요한 것만 조회

## 5. Claude Desktop 설정

### 5.1 설정 파일 위치

| OS | 경로 |
|------|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/claude/claude_desktop_config.json` |

### 5.2 설정 형식

```json
{
  "mcpServers": {
    "server-name": {
      "command": "실행 명령",
      "args": ["인자들"],
      "env": {
        "환경변수": "값"
      }
    }
  }
}
```

### 5.3 자동 설치의 이점

```bash
$ code-memory mcp install
```

**수동 설정 시 문제**:
- JSON 문법 오류 가능
- 경로 오타
- 플랫폼별 차이

**자동 설치 이점**:
- 오류 방지
- 플랫폼 자동 감지
- 설정 검증

## 6. 보안 고려사항

### 6.1 로컬 전용

```typescript
// stdio 전송만 사용 (네트워크 노출 없음)
const transport = new StdioServerTransport();
```

### 6.2 경로 제한

```typescript
// 홈 디렉토리 외부 접근 차단
const memoryPath = process.env.MEMORY_PATH;
if (!memoryPath.startsWith(os.homedir())) {
  throw new Error('Invalid memory path');
}
```

### 6.3 Privacy 필터 적용

```typescript
// MCP 응답에도 privacy 필터 적용
const filtered = applyPrivacyFilter(content, config.privacy);
```

## 7. 사용 시나리오

### 7.1 Claude Desktop에서 검색

```
User: "지난번에 DuckDB 스키마 어떻게 설계했었지?"

Claude: [mem-search 도구 호출]
        query: "DuckDB 스키마 설계"

        Found 2 relevant memories:

        1. [mem:a7Bc3x] (0.94)
           DuckDB를 사용하여 이벤트 소싱 패턴을...

        지난번에 이벤트 소싱 패턴으로 설계하셨네요.
        자세한 내용을 보시려면 말씀해주세요.
```

### 7.2 상세 조회

```
User: "첫 번째 결과 자세히 보여줘"

Claude: [mem-details 도구 호출]
        ids: ["a7Bc3x"]

        [전체 내용 표시]
```

## 8. 참고 자료

- **MCP 공식 문서**: https://modelcontextprotocol.io/
- **claude-mem MCP**: Desktop integration via MCP
- **Anthropic SDK**: @modelcontextprotocol/sdk
