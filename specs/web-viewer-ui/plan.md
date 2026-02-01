# Web Viewer UI Implementation Plan

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-01

## Phase 1: 서버 인프라 (P0)

### 1.1 HTTP 서버 설정

**파일**: `src/server/index.ts` (신규)

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';

const app = new Hono();

// CORS (개발용)
app.use('/*', cors());

// Static files
app.use('/*', serveStatic({ root: './dist/ui' }));

// API routes
app.route('/api', apiRouter);

export function startServer(port: number = 37777) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: app.fetch
  });
}
```

**작업 항목**:
- [ ] Hono 라우터 설정
- [ ] Static 파일 서빙
- [ ] CORS 설정
- [ ] 에러 핸들링 미들웨어

### 1.2 API 라우터

**파일**: `src/server/api/index.ts` (신규)

```typescript
import { Hono } from 'hono';
import { sessionsRouter } from './sessions';
import { eventsRouter } from './events';
import { searchRouter } from './search';
import { statsRouter } from './stats';
import { configRouter } from './config';

export const apiRouter = new Hono()
  .route('/sessions', sessionsRouter)
  .route('/events', eventsRouter)
  .route('/search', searchRouter)
  .route('/stats', statsRouter)
  .route('/config', configRouter);
```

**작업 항목**:
- [ ] API 라우터 분리 구조
- [ ] 공통 미들웨어 (로깅, 인증)

## Phase 2: REST API 구현 (P0)

### 2.1 Sessions API

**파일**: `src/server/api/sessions.ts` (신규)

```typescript
import { Hono } from 'hono';
import { MemoryService } from '../../services/memory-service';

export const sessionsRouter = new Hono();

// GET /api/sessions
sessionsRouter.get('/', async (c) => {
  const { page = 1, pageSize = 20 } = c.req.query();
  const memoryService = await MemoryService.getInstance();

  const sessions = await memoryService.getSessions({
    page: Number(page),
    pageSize: Number(pageSize)
  });

  return c.json({
    sessions: sessions.items,
    total: sessions.total,
    page: Number(page),
    pageSize: Number(pageSize)
  });
});

// GET /api/sessions/:id
sessionsRouter.get('/:id', async (c) => {
  const { id } = c.req.param();
  const memoryService = await MemoryService.getInstance();

  const session = await memoryService.getSessionById(id);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const events = await memoryService.getEventsBySession(id);
  const stats = await memoryService.getSessionStats(id);

  return c.json({ session, events, stats });
});
```

**작업 항목**:
- [ ] 세션 목록 조회
- [ ] 세션 상세 조회
- [ ] 페이지네이션 구현
- [ ] 정렬 옵션

### 2.2 Events API

**파일**: `src/server/api/events.ts` (신규)

```typescript
export const eventsRouter = new Hono();

// GET /api/events
eventsRouter.get('/', async (c) => {
  const { sessionId, type, limit = 100, offset = 0 } = c.req.query();
  const memoryService = await MemoryService.getInstance();

  const events = await memoryService.getEvents({
    sessionId,
    eventType: type,
    limit: Number(limit),
    offset: Number(offset)
  });

  return c.json({
    events: events.map(e => ({
      eventId: e.eventId,
      eventType: e.eventType,
      timestamp: e.timestamp,
      sessionId: e.sessionId,
      preview: generatePreview(e.payload, 100)
    })),
    total: events.total
  });
});

// GET /api/events/:id
eventsRouter.get('/:id', async (c) => {
  const { id } = c.req.param();
  const memoryService = await MemoryService.getInstance();

  const event = await memoryService.getEventById(id);
  if (!event) {
    return c.json({ error: 'Event not found' }, 404);
  }

  const related = await memoryService.getRelatedEvents(id);

  return c.json({ event, related });
});
```

**작업 항목**:
- [ ] 이벤트 목록 조회 (필터링)
- [ ] 이벤트 상세 조회
- [ ] 미리보기 생성
- [ ] 관련 이벤트 조회

### 2.3 Search API

**파일**: `src/server/api/search.ts` (신규)

```typescript
export const searchRouter = new Hono();

// POST /api/search
searchRouter.post('/', async (c) => {
  const body = await c.req.json<SearchRequest>();
  const memoryService = await MemoryService.getInstance();

  const startTime = Date.now();

  const results = await memoryService.search(body.query, {
    filters: body.filters,
    topK: body.options?.topK ?? 10,
    minScore: body.options?.minScore ?? 0.7,
    progressive: body.options?.progressive ?? true
  });

  return c.json({
    results: results.map(r => ({
      id: r.id,
      score: r.score,
      type: r.type,
      timestamp: r.timestamp,
      sessionId: r.sessionId,
      preview: r.preview,
      highlight: highlightMatches(r.content, body.query)
    })),
    meta: {
      totalMatches: results.length,
      searchTime: Date.now() - startTime,
      mode: 'hybrid'
    }
  });
});
```

**작업 항목**:
- [ ] 검색 API 구현
- [ ] 필터링 옵션
- [ ] 하이라이트 기능
- [ ] Progressive 모드 지원

### 2.4 Stats API

**파일**: `src/server/api/stats.ts` (신규)

```typescript
export const statsRouter = new Hono();

// GET /api/stats
statsRouter.get('/', async (c) => {
  const memoryService = await MemoryService.getInstance();
  const stats = await memoryService.getStats();

  return c.json({
    storage: {
      eventCount: stats.events.count,
      vectorCount: stats.vectors.count,
      dbSizeMB: stats.storage.duckdb / (1024 * 1024),
      vectorSizeMB: stats.storage.lancedb / (1024 * 1024)
    },
    sessions: {
      total: stats.sessions.total,
      active: stats.sessions.active,
      thisWeek: stats.sessions.thisWeek
    },
    embeddings: {
      pending: stats.outbox.pending,
      processed: stats.outbox.processed,
      failed: stats.outbox.failed,
      avgProcessTime: stats.outbox.avgTime
    },
    memory: {
      heapUsed: process.memoryUsage().heapUsed,
      heapTotal: process.memoryUsage().heapTotal
    }
  });
});

// GET /api/stats/timeline
statsRouter.get('/timeline', async (c) => {
  const { days = 7 } = c.req.query();
  const memoryService = await MemoryService.getInstance();

  const timeline = await memoryService.getActivityTimeline(Number(days));

  return c.json({ daily: timeline });
});
```

**작업 항목**:
- [ ] 전체 통계 조회
- [ ] 타임라인 통계
- [ ] 메모리 사용량

## Phase 3: WebSocket 구현 (P1)

### 3.1 WebSocket 서버

**파일**: `src/server/websocket.ts` (신규)

```typescript
import { EventEmitter } from 'events';

const eventBus = new EventEmitter();

interface WSClient {
  ws: WebSocket;
  subscriptions: Set<string>;
  filters: {
    sessionId?: string;
    eventType?: string[];
  };
}

const clients = new Map<string, WSClient>();

export function handleWebSocket(ws: WebSocket) {
  const clientId = crypto.randomUUID();

  clients.set(clientId, {
    ws,
    subscriptions: new Set(),
    filters: {}
  });

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'subscribe') {
      const client = clients.get(clientId);
      msg.channels.forEach((ch: string) => client?.subscriptions.add(ch));
      if (msg.filters) {
        client!.filters = msg.filters;
      }
    }

    if (msg.type === 'unsubscribe') {
      const client = clients.get(clientId);
      msg.channels.forEach((ch: string) => client?.subscriptions.delete(ch));
    }
  };

  ws.onclose = () => {
    clients.delete(clientId);
  };
}

// 이벤트 브로드캐스트
export function broadcastEvent(channel: string, data: unknown) {
  for (const client of clients.values()) {
    if (client.subscriptions.has(channel)) {
      // 필터 적용
      if (channel === 'events' && client.filters.sessionId) {
        if ((data as any).sessionId !== client.filters.sessionId) {
          continue;
        }
      }

      client.ws.send(JSON.stringify({ channel, data }));
    }
  }
}
```

**작업 항목**:
- [ ] WebSocket 연결 관리
- [ ] 구독/구독취소 처리
- [ ] 필터링 적용
- [ ] 브로드캐스트 함수

### 3.2 이벤트 연동

**파일**: `src/services/memory-service.ts` 수정

```typescript
import { broadcastEvent } from '../server/websocket';

export class MemoryService {
  async storeEvent(event: Event): Promise<string> {
    const eventId = await this.eventStore.append(event);

    // WebSocket 브로드캐스트
    broadcastEvent('events', {
      type: 'new_event',
      event: {
        eventId,
        eventType: event.eventType,
        timestamp: event.timestamp,
        sessionId: event.sessionId,
        preview: generatePreview(event.payload, 100)
      }
    });

    return eventId;
  }
}
```

**작업 항목**:
- [ ] 이벤트 저장 시 브로드캐스트
- [ ] Outbox 상태 브로드캐스트
- [ ] 통계 업데이트 브로드캐스트

## Phase 4: UI 구현 (P1)

### 4.1 HTML 템플릿

**파일**: `src/ui/index.html` (신규)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Code Memory Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script type="module" src="/app.js"></script>
</head>
<body class="bg-gray-900 text-gray-100">
  <div id="app"></div>
</body>
</html>
```

**작업 항목**:
- [ ] HTML 기본 템플릿
- [ ] Tailwind 설정
- [ ] 다크 테마

### 4.2 메인 앱

**파일**: `src/ui/app.ts` (신규)

```typescript
import { h, render } from 'preact';
import { signal } from '@preact/signals';
import { Router, Route } from 'preact-router';

import { Dashboard } from './pages/Dashboard';
import { Sessions } from './pages/Sessions';
import { Timeline } from './pages/Timeline';
import { Search } from './pages/Search';
import { Stats } from './pages/Stats';

const currentPath = signal(window.location.pathname);

function App() {
  return h('div', { class: 'min-h-screen' },
    h('nav', { class: 'bg-gray-800 p-4' },
      h('div', { class: 'flex items-center gap-4' },
        h('span', { class: 'text-xl font-bold' }, '🧠 Code Memory'),
        h('a', { href: '/', class: 'hover:text-blue-400' }, 'Dashboard'),
        h('a', { href: '/sessions', class: 'hover:text-blue-400' }, 'Sessions'),
        h('a', { href: '/timeline', class: 'hover:text-blue-400' }, 'Timeline'),
        h('a', { href: '/search', class: 'hover:text-blue-400' }, 'Search'),
        h('a', { href: '/stats', class: 'hover:text-blue-400' }, 'Stats')
      )
    ),
    h('main', { class: 'p-4' },
      h(Router, {},
        h(Route, { path: '/', component: Dashboard }),
        h(Route, { path: '/sessions', component: Sessions }),
        h(Route, { path: '/sessions/:id', component: SessionDetail }),
        h(Route, { path: '/timeline', component: Timeline }),
        h(Route, { path: '/search', component: Search }),
        h(Route, { path: '/stats', component: Stats })
      )
    )
  );
}

render(h(App), document.getElementById('app')!);
```

**작업 항목**:
- [ ] Preact 앱 설정
- [ ] 라우터 구성
- [ ] 네비게이션 바

### 4.3 API 클라이언트

**파일**: `src/ui/api.ts` (신규)

```typescript
const BASE_URL = '/api';

export async function fetchSessions(options?: { page?: number; pageSize?: number }) {
  const params = new URLSearchParams();
  if (options?.page) params.set('page', String(options.page));
  if (options?.pageSize) params.set('pageSize', String(options.pageSize));

  const res = await fetch(`${BASE_URL}/sessions?${params}`);
  return res.json();
}

export async function fetchEvents(options?: { sessionId?: string; type?: string; limit?: number }) {
  const params = new URLSearchParams();
  if (options?.sessionId) params.set('sessionId', options.sessionId);
  if (options?.type) params.set('type', options.type);
  if (options?.limit) params.set('limit', String(options.limit));

  const res = await fetch(`${BASE_URL}/events?${params}`);
  return res.json();
}

export async function search(query: string, options?: SearchOptions) {
  const res = await fetch(`${BASE_URL}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, options })
  });
  return res.json();
}

export async function fetchStats() {
  const res = await fetch(`${BASE_URL}/stats`);
  return res.json();
}
```

**작업 항목**:
- [ ] Sessions API 클라이언트
- [ ] Events API 클라이언트
- [ ] Search API 클라이언트
- [ ] Stats API 클라이언트

### 4.4 WebSocket 클라이언트

**파일**: `src/ui/websocket.ts` (신규)

```typescript
import { signal } from '@preact/signals';

export const wsConnected = signal(false);
export const liveEvents = signal<Event[]>([]);
export const outboxStatus = signal({ pending: 0, processing: [], failed: [] });

let ws: WebSocket | null = null;

export function connectWebSocket() {
  ws = new WebSocket(`ws://${window.location.host}/ws`);

  ws.onopen = () => {
    wsConnected.value = true;
    ws?.send(JSON.stringify({
      type: 'subscribe',
      channels: ['events', 'outbox']
    }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.channel === 'events') {
      liveEvents.value = [msg.data.event, ...liveEvents.value.slice(0, 99)];
    }

    if (msg.channel === 'outbox') {
      outboxStatus.value = msg.data;
    }
  };

  ws.onclose = () => {
    wsConnected.value = false;
    setTimeout(connectWebSocket, 3000);  // 재연결
  };
}

export function subscribeToSession(sessionId: string) {
  ws?.send(JSON.stringify({
    type: 'subscribe',
    channels: ['events'],
    filters: { sessionId }
  }));
}
```

**작업 항목**:
- [ ] WebSocket 연결 관리
- [ ] 자동 재연결
- [ ] 구독 관리
- [ ] 실시간 상태 시그널

## Phase 5: 페이지 컴포넌트 (P1)

### 5.1 Dashboard 페이지

**파일**: `src/ui/pages/Dashboard.ts` (신규)

```typescript
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchStats, fetchSessions } from '../api';

export function Dashboard() {
  const [stats, setStats] = useState(null);
  const [recentSessions, setRecentSessions] = useState([]);

  useEffect(() => {
    fetchStats().then(setStats);
    fetchSessions({ pageSize: 5 }).then(data => setRecentSessions(data.sessions));
  }, []);

  return h('div', { class: 'space-y-6' },
    // Stats cards
    h('div', { class: 'grid grid-cols-3 gap-4' },
      h(StatCard, { title: 'Events', value: stats?.storage.eventCount }),
      h(StatCard, { title: 'Vectors', value: stats?.storage.vectorCount }),
      h(StatCard, { title: 'Sessions', value: stats?.sessions.total })
    ),
    // Recent sessions
    h('div', { class: 'bg-gray-800 rounded p-4' },
      h('h2', { class: 'text-lg font-semibold mb-4' }, 'Recent Sessions'),
      recentSessions.map(s => h(SessionItem, { session: s }))
    )
  );
}
```

**작업 항목**:
- [ ] 통계 카드 컴포넌트
- [ ] 최근 세션 목록
- [ ] 실시간 업데이트

### 5.2 Timeline 페이지

**파일**: `src/ui/pages/Timeline.ts` (신규)

```typescript
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import { liveEvents, connectWebSocket } from '../websocket';

export function Timeline() {
  useEffect(() => {
    connectWebSocket();
  }, []);

  return h('div', { class: 'space-y-4' },
    h('div', { class: 'flex items-center justify-between' },
      h('h1', { class: 'text-xl font-bold' }, '📅 Timeline'),
      h('span', { class: 'text-green-400' }, '● Live')
    ),
    h('div', { class: 'space-y-2' },
      liveEvents.value.map(event =>
        h(TimelineItem, { event })
      )
    )
  );
}

function TimelineItem({ event }) {
  const icons = {
    user_prompt: '💬',
    assistant_response: '🤖',
    tool_observation: '🛠️'
  };

  return h('div', { class: 'flex gap-4 p-4 bg-gray-800 rounded' },
    h('div', { class: 'text-2xl' }, icons[event.eventType] || '📝'),
    h('div', { class: 'flex-1' },
      h('div', { class: 'text-sm text-gray-400' },
        new Date(event.timestamp).toLocaleTimeString()
      ),
      h('div', {}, event.preview)
    )
  );
}
```

**작업 항목**:
- [ ] 실시간 타임라인
- [ ] 이벤트 타입별 아이콘
- [ ] 필터링 옵션
- [ ] 무한 스크롤

### 5.3 Search 페이지

**파일**: `src/ui/pages/Search.ts` (신규)

```typescript
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { search } from '../api';

export function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  async function handleSearch() {
    if (!query.trim()) return;
    setLoading(true);
    const data = await search(query);
    setResults(data.results);
    setLoading(false);
  }

  return h('div', { class: 'space-y-4' },
    h('div', { class: 'flex gap-2' },
      h('input', {
        type: 'text',
        value: query,
        onInput: (e) => setQuery(e.target.value),
        onKeyDown: (e) => e.key === 'Enter' && handleSearch(),
        placeholder: 'Search memories...',
        class: 'flex-1 bg-gray-800 rounded px-4 py-2'
      }),
      h('button', {
        onClick: handleSearch,
        class: 'bg-blue-600 px-4 py-2 rounded'
      }, 'Search')
    ),
    loading && h('div', {}, 'Searching...'),
    h('div', { class: 'space-y-2' },
      results.map(r => h(SearchResult, { result: r }))
    )
  );
}
```

**작업 항목**:
- [ ] 검색 입력
- [ ] 필터 옵션
- [ ] 결과 표시
- [ ] 하이라이트

## Phase 6: 빌드 및 통합 (P0)

### 6.1 빌드 스크립트

**파일**: `package.json` 수정

```json
{
  "scripts": {
    "build:ui": "esbuild src/ui/app.ts --bundle --outfile=dist/ui/app.js --minify",
    "build:server": "esbuild src/server/index.ts --bundle --platform=node --outfile=dist/server.js",
    "dev:ui": "esbuild src/ui/app.ts --bundle --outfile=dist/ui/app.js --watch",
    "start:server": "bun dist/server.js"
  }
}
```

**작업 항목**:
- [ ] UI 빌드 스크립트
- [ ] 서버 빌드 스크립트
- [ ] 개발 모드 설정

### 6.2 서버 자동 시작

**파일**: `src/hooks/session-start.ts` 수정

```typescript
import { startServer, isServerRunning } from '../server';

export async function handleSessionStart(): Promise<void> {
  // 서버 실행 확인 및 시작
  if (!await isServerRunning(37777)) {
    startServer(37777);
    console.log('Memory viewer started at http://localhost:37777');
  }

  // 기존 로직...
}
```

**작업 항목**:
- [ ] 세션 시작 시 서버 자동 시작
- [ ] 포트 충돌 처리
- [ ] 로그 출력

## 파일 목록

### 신규 파일
```
# Server
src/server/index.ts              # HTTP 서버 메인
src/server/api/index.ts          # API 라우터
src/server/api/sessions.ts       # Sessions API
src/server/api/events.ts         # Events API
src/server/api/search.ts         # Search API
src/server/api/stats.ts          # Stats API
src/server/api/config.ts         # Config API
src/server/websocket.ts          # WebSocket 핸들러

# UI
src/ui/index.html                # HTML 템플릿
src/ui/app.ts                    # Preact 앱
src/ui/api.ts                    # API 클라이언트
src/ui/websocket.ts              # WebSocket 클라이언트
src/ui/pages/Dashboard.ts        # 대시보드 페이지
src/ui/pages/Sessions.ts         # 세션 페이지
src/ui/pages/Timeline.ts         # 타임라인 페이지
src/ui/pages/Search.ts           # 검색 페이지
src/ui/pages/Stats.ts            # 통계 페이지
src/ui/components/*.ts           # 공통 컴포넌트
```

### 수정 파일
```
src/services/memory-service.ts   # WebSocket 브로드캐스트 추가
src/hooks/session-start.ts       # 서버 자동 시작
package.json                     # 빌드 스크립트
```

## 마일스톤

| 단계 | 완료 기준 |
|------|----------|
| M1 | HTTP 서버 + 정적 파일 서빙 |
| M2 | REST API (Sessions, Events) |
| M3 | REST API (Search, Stats, Config) |
| M4 | WebSocket 기본 구현 |
| M5 | UI 기본 레이아웃 |
| M6 | Dashboard + Timeline 페이지 |
| M7 | Search + Stats 페이지 |
| M8 | 빌드 및 통합 테스트 |
