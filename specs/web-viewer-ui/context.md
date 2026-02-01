# Web Viewer UI Context

> **Version**: 1.0.0
> **Created**: 2026-02-01

## 1. 배경

### 1.1 claude-mem의 접근 방식

claude-mem은 Web Viewer를 핵심 기능으로 제공:

```
http://localhost:37777
├── 실시간 메모리 스트림
├── 세션별 탐색
├── 검색 인터페이스
├── 설정 관리
└── Beta 기능 토글
```

**주요 특징**:
- Bun 기반 HTTP 서버
- 10개의 검색 엔드포인트
- 실시간 observation 스트림
- Settings 페이지에서 버전 전환

**장점**:
- CLI 한계 극복 (대량 데이터 시각화)
- 디버깅 용이
- 비개발자도 접근 가능

### 1.2 현재 code-memory의 상황

현재 CLI만 제공:

```bash
# 현재 지원 명령어
code-memory search "query"
code-memory history
code-memory stats
code-memory forget
```

**한계점**:
1. 대량 결과 탐색 불편
2. 실시간 모니터링 불가
3. 시각적 통계 없음
4. 복잡한 필터링 어려움

### 1.3 Web UI 도입 필요성

| CLI | Web UI |
|-----|--------|
| 텍스트만 | 시각화 가능 |
| 동기 실행 | 실시간 업데이트 |
| 단일 작업 | 여러 뷰 동시 |
| 복잡한 필터링 | 직관적 UI |

## 2. 기술 선택 이유

### 2.1 Bun 서버

**선택 이유**:
- Node.js 대비 3-4배 빠른 성능
- 내장 WebSocket 지원
- TypeScript 직접 실행
- 번들러 내장

**대안 비교**:

| 옵션 | 장점 | 단점 |
|------|------|------|
| Express | 생태계 | 느림, 설정 복잡 |
| Fastify | 빠름 | 설정 복잡 |
| **Bun.serve** | 최고 성능, 간단 | 생태계 작음 |

### 2.2 Hono 프레임워크

**선택 이유**:
- 초경량 (12KB)
- Bun 최적화
- Express 유사 API
- 미들웨어 생태계

```typescript
// Hono 사용 예시
import { Hono } from 'hono';

const app = new Hono();
app.get('/api/sessions', (c) => c.json(sessions));
```

### 2.3 Preact + HTM

**선택 이유**:
- React 호환 API
- 3KB (React 45KB)
- JSX 없이 사용 가능
- 빌드 선택적

```typescript
// HTM 사용 (빌드 불필요)
import { html } from 'htm/preact';

function App() {
  return html`<div class="container">Hello</div>`;
}
```

**대안 비교**:

| 옵션 | 번들 크기 | 빌드 필요 |
|------|----------|----------|
| React | 45KB | 필수 |
| Vue 3 | 33KB | 권장 |
| Svelte | 2KB | 필수 |
| **Preact** | 3KB | 선택 |

### 2.4 Tailwind CSS

**선택 이유**:
- 빠른 개발
- 번들 크기 최적화 (JIT)
- 다크 테마 기본 지원

```html
<!-- CDN으로 즉시 사용 가능 -->
<script src="https://cdn.tailwindcss.com"></script>
```

## 3. 기존 코드와의 관계

### 3.1 MemoryService

Web 서버가 사용할 서비스 메서드:

```typescript
// 현재 MemoryService
export class MemoryService {
  // 이미 있는 것
  async search(query: string): Promise<SearchResult[]>;
  async getStats(): Promise<Stats>;

  // 추가 필요
  async getSessions(options: PageOptions): Promise<PaginatedResult<Session>>;
  async getSessionById(id: string): Promise<Session | null>;
  async getEventsBySession(sessionId: string): Promise<Event[]>;
  async getEventById(id: string): Promise<Event | null>;
  async getActivityTimeline(days: number): Promise<DailyStats[]>;
}
```

### 3.2 EventStore

WebSocket 브로드캐스트를 위한 이벤트 훅:

```typescript
// 현재 EventStore.append()
async append(event: EventInput): Promise<string> {
  const eventId = await this.db.insert(event);
  // WebSocket 브로드캐스트 추가 필요
  return eventId;
}
```

### 3.3 VectorWorker

Outbox 상태 모니터링:

```typescript
// VectorWorker에 상태 노출
export class VectorWorker {
  getStatus(): OutboxStatus {
    return {
      pending: this.pendingCount,
      processing: this.processingIds,
      failed: this.failedIds,
      avgTime: this.avgProcessTime
    };
  }
}
```

## 4. 설계 결정 사항

### 4.1 포트 선택 (37777)

**claude-mem과 동일**: 충돌 가능성 낮은 포트
**설정 가능**: 환경 변수로 변경 가능

```typescript
const PORT = process.env.MEMORY_VIEWER_PORT || 37777;
```

### 4.2 localhost 전용

**보안 고려**:
- 외부 접근 차단
- 인증 불필요
- CORS 제한적 허용

```typescript
Bun.serve({
  hostname: '127.0.0.1',  // localhost만
  port: 37777
});
```

### 4.3 자동 시작 vs 수동 시작

**자동 시작 선택**:
- session-start 훅에서 서버 시작
- 이미 실행 중이면 스킵
- 사용자 개입 불필요

**대안 (수동)**:
```bash
code-memory serve  # 별도 명령어
```

### 4.4 SSR vs CSR

**CSR (Client-Side Rendering) 선택**:
- 서버 복잡도 낮음
- 정적 파일만 서빙
- 실시간 업데이트 용이

**대안 (SSR)**:
- 초기 로딩 빠름
- SEO (불필요)
- 서버 복잡도 증가

## 5. API 설계 원칙

### 5.1 RESTful 패턴

```
GET    /api/sessions          # 목록 조회
GET    /api/sessions/:id      # 단일 조회
GET    /api/events            # 목록 조회 (필터링)
GET    /api/events/:id        # 단일 조회
POST   /api/search            # 검색 (body에 쿼리)
GET    /api/stats             # 통계
GET    /api/config            # 설정 조회
PATCH  /api/config            # 설정 수정
```

### 5.2 응답 형식

```typescript
// 성공 응답
{
  data: T,
  meta?: {
    total: number,
    page: number,
    pageSize: number
  }
}

// 에러 응답
{
  error: {
    code: string,
    message: string
  }
}
```

### 5.3 페이지네이션

```typescript
// 쿼리 파라미터
GET /api/sessions?page=1&pageSize=20

// 응답
{
  sessions: [...],
  meta: {
    total: 100,
    page: 1,
    pageSize: 20,
    hasMore: true
  }
}
```

## 6. WebSocket 설계

### 6.1 연결 패턴

```
클라이언트                    서버
    │                          │
    │  Connect ws://...        │
    │─────────────────────────▶│
    │                          │
    │  { type: 'subscribe',    │
    │    channels: ['events'] }│
    │─────────────────────────▶│
    │                          │
    │  { channel: 'events',    │
    │    data: {...} }         │
    │◀─────────────────────────│
    │                          │
```

### 6.2 채널 설계

| 채널 | 용도 | 메시지 빈도 |
|------|------|------------|
| events | 새 이벤트 알림 | 높음 |
| outbox | 임베딩 상태 | 중간 |
| stats | 통계 업데이트 | 낮음 |

### 6.3 필터링

```typescript
// 특정 세션만 구독
{
  type: 'subscribe',
  channels: ['events'],
  filters: {
    sessionId: 'session_123'
  }
}
```

## 7. 성능 고려사항

### 7.1 정적 파일 캐싱

```typescript
app.use('/*', serveStatic({
  root: './dist/ui',
  maxAge: 86400  // 24시간
}));
```

### 7.2 API 응답 압축

```typescript
import { compress } from 'hono/compress';
app.use('/*', compress());
```

### 7.3 WebSocket 메시지 배치

```typescript
// 100ms 내 이벤트 모아서 전송
const eventBuffer: Event[] = [];
let flushTimeout: Timer | null = null;

function bufferEvent(event: Event) {
  eventBuffer.push(event);

  if (!flushTimeout) {
    flushTimeout = setTimeout(() => {
      broadcastEvents(eventBuffer);
      eventBuffer.length = 0;
      flushTimeout = null;
    }, 100);
  }
}
```

### 7.4 메모리 관리

```typescript
// WebSocket 클라이언트 제한
const MAX_CLIENTS = 10;

if (clients.size >= MAX_CLIENTS) {
  ws.close(1013, 'Too many connections');
  return;
}
```

## 8. 참고 자료

- **claude-mem README**: Web viewer at localhost:37777
- **Hono Documentation**: https://hono.dev/
- **Preact Documentation**: https://preactjs.com/
- **Bun Documentation**: https://bun.sh/
