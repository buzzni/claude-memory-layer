import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';

class TestElement {
  innerHTML = '';
  textContent = '';
  value = '';
  disabled = false;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners: Record<string, Array<(...args: any[]) => void>> = {};
  classList = { add() {}, remove() {}, toggle() {} };

  addEventListener(event: string, handler: (...args: any[]) => void) {
    this.listeners[event] = this.listeners[event] || [];
    this.listeners[event].push(handler);
  }
}

function loadDashboardWithElements(
  elements: Record<string, TestElement>,
  fetchImpl: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }> = async () => ({ ok: true, json: async () => ({}) })
) {
  const dashboardDir = join(process.cwd(), 'src/apps/dashboard/assets/js');
  const source = ['state.js', 'views.js', 'overview.js']
    .map(file => readFileSync(join(dashboardDir, file), 'utf-8'))
    .join('\n');
  const context = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    ApexCharts: function () { return { render() {}, destroy() {} }; },
    fetch: fetchImpl,
    window: { location: { origin: 'http://localhost:37777' } },
    document: {
      addEventListener() {},
      getElementById(id: string) { return elements[id] ?? null; },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      createElement() { return new TestElement(); },
    },
  };

  vm.runInNewContext(
    `${source}\n;globalThis.__dashboardTestHooks = { state, switchView, loadSessionInspectorView, renderSessionList, selectSession, renderSessionConversation, setSessionSnapshotTab };`,
    context
  );
  return (context as unknown as { __dashboardTestHooks: {
    state: Record<string, any>;
    switchView: (viewName: string, options?: { forceReload?: boolean }) => Promise<void>;
    loadSessionInspectorView: () => Promise<void>;
    renderSessionList: () => void;
    selectSession: (sessionId: string) => Promise<void>;
    renderSessionConversation: () => void;
    setSessionSnapshotTab: (tab: string) => void;
  }}).__dashboardTestHooks;
}

const sessionPayload = {
  sessions: [
    {
      id: "session'alpha",
      startedAt: '2026-06-13T09:00:00.000Z',
      lastEventAt: '2026-06-13T09:05:00.000Z',
      eventCount: 4,
    },
  ],
  total: 1,
  page: 1,
  pageSize: 50,
  hasMore: false,
};

const turnsPayload = {
  turns: [
    {
      turnId: 'turn-1',
      startedAt: '2026-06-13T09:00:00.000Z',
      promptPreview: 'How should we inspect user memories?',
      eventCount: 3,
      toolCount: 1,
      hasResponse: true,
      events: [
        { id: 'e-user', eventType: 'user_prompt', timestamp: '2026-06-13T09:00:00.000Z', preview: 'How should we inspect user memories?', contentLength: 36 },
        { id: 'e-tool', eventType: 'tool_observation', timestamp: '2026-06-13T09:01:00.000Z', preview: 'search_files result with PRIVATE_TOOL_SENTINEL', contentLength: 42 },
        { id: 'e-agent', eventType: 'agent_response', timestamp: '2026-06-13T09:02:00.000Z', preview: 'Use a session inspector with evidence links.', contentLength: 44 },
      ],
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
  hasMore: false,
};

const eventsPayload = {
  events: [
    { id: 'e-user', eventType: 'user_prompt', timestamp: '2026-06-13T09:00:00.000Z', sessionId: "session'alpha", preview: 'How should we inspect user memories?', metadata: { source: 'hermes' }, accessCount: 2 },
    { id: 'e-agent', eventType: 'agent_response', timestamp: '2026-06-13T09:02:00.000Z', sessionId: "session'alpha", preview: 'Use a session inspector with evidence links.', metadata: { level: 'L2' }, accessCount: 0 },
  ],
  total: 2,
};

describe('dashboard session inspector', () => {
  it('defines a dedicated Sessions navigation item and view containers', () => {
    const html = readFileSync(join(process.cwd(), 'src/apps/dashboard/index.html'), 'utf-8');

    expect(html).toContain('data-nav="sessions"');
    expect(html).toContain('Session Inspector');
    for (const id of [
      'view-sessions',
      'session-list',
      'session-conversation',
      'session-snapshot-panel',
      'session-snapshot-tabs',
      'session-snapshot-content'
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('loads session list, turns, and evidence with current project scope', async () => {
    const requestedUrls: string[] = [];
    const elements = {
      'session-list': new TestElement(),
      'session-conversation': new TestElement(),
      'session-snapshot-panel': new TestElement(),
      'session-snapshot-content': new TestElement(),
      'session-inspector-meta': new TestElement(),
    };
    const hooks = loadDashboardWithElements(elements, async (url) => {
      requestedUrls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/api/sessions') return { ok: true, json: async () => sessionPayload };
      if (parsed.pathname === '/api/turns') return { ok: true, json: async () => turnsPayload };
      if (parsed.pathname === '/api/events') return { ok: true, json: async () => eventsPayload };
      return { ok: false, json: async () => ({}) };
    });
    hooks.state.currentProject = 'project-safe-hash';

    await hooks.loadSessionInspectorView();

    expect(requestedUrls.map(u => new URL(u).pathname)).toEqual(['/api/sessions', '/api/turns', '/api/events']);
    for (const rawUrl of requestedUrls) {
      expect(new URL(rawUrl).searchParams.get('project')).toBe('project-safe-hash');
    }
    expect(elements['session-list'].innerHTML).toContain('session&#039;alpha');
    expect(elements['session-list'].innerHTML).toContain('selectSession(&quot;session&#039;alpha&quot;)');
    expect(elements['session-list'].innerHTML).not.toContain("selectSession('session&#039;alpha')");
    expect(elements['session-conversation'].innerHTML).toContain('How should we inspect user memories?');
    expect(elements['session-conversation'].innerHTML).toContain('Use a session inspector with evidence links.');
    expect(elements['session-snapshot-content'].innerHTML).toContain('4 events');
    expect(elements['session-snapshot-content'].innerHTML).toContain('1 turns');
    expect(elements['session-snapshot-content'].innerHTML).not.toContain('PRIVATE_TOOL_SENTINEL');
  });

  it('renders memory snapshot tabs from selected session evidence without exposing raw metadata', () => {
    const elements = {
      'session-list': new TestElement(),
      'session-conversation': new TestElement(),
      'session-snapshot-panel': new TestElement(),
      'session-snapshot-content': new TestElement(),
      'session-inspector-meta': new TestElement(),
    };
    const hooks = loadDashboardWithElements(elements);
    hooks.state.selectedSession = sessionPayload.sessions[0];
    hooks.state.selectedSessionTurns = turnsPayload.turns;
    hooks.state.selectedSessionEvents = [
      ...eventsPayload.events,
      {
        id: 'e-private',
        eventType: 'tool_observation',
        timestamp: '2026-06-13T09:03:00.000Z',
        sessionId: 'session-alpha',
        preview: 'PRIVATE_TOOL_SENTINEL from tool output',
        metadata: { rawPath: '/Users/alice/private-project', privateMarker: 'PRIVATE_META_SENTINEL' },
        accessCount: 1,
      },
    ];

    hooks.setSessionSnapshotTab('evidence');

    expect(elements['session-snapshot-content'].innerHTML).toContain('Evidence Coverage');
    expect(elements['session-snapshot-content'].innerHTML).toContain('e-user');
    expect(elements['session-snapshot-content'].innerHTML).toContain('user_prompt');
    expect(elements['session-snapshot-content'].innerHTML).toContain('Tool observation preview hidden');
    expect(elements['session-snapshot-content'].innerHTML).not.toContain('PRIVATE_TOOL_SENTINEL');
    expect(elements['session-snapshot-content'].innerHTML).not.toContain('/Users/alice/private-project');
    expect(elements['session-snapshot-content'].innerHTML).not.toContain('PRIVATE_META_SENTINEL');
  });

  it('force reloads the sessions view when the project changes while sessions is active', async () => {
    const requestedUrls: string[] = [];
    const elements = {
      'view-sessions': new TestElement(),
      'session-list': new TestElement(),
      'session-conversation': new TestElement(),
      'session-snapshot-panel': new TestElement(),
      'session-snapshot-content': new TestElement(),
      'session-inspector-meta': new TestElement(),
    };
    const hooks = loadDashboardWithElements(elements, async (url) => {
      requestedUrls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/api/sessions') return { ok: true, json: async () => sessionPayload };
      if (parsed.pathname === '/api/turns') return { ok: true, json: async () => turnsPayload };
      if (parsed.pathname === '/api/events') return { ok: true, json: async () => eventsPayload };
      return { ok: false, json: async () => ({}) };
    });

    hooks.state.currentView = 'sessions';
    await hooks.switchView('sessions');
    expect(requestedUrls).toHaveLength(0);

    hooks.state.currentProject = 'second-project';
    await hooks.switchView('sessions', { forceReload: true });

    expect(requestedUrls.map(u => new URL(u).pathname)).toEqual(['/api/sessions', '/api/turns', '/api/events']);
    for (const rawUrl of requestedUrls) {
      expect(new URL(rawUrl).searchParams.get('project')).toBe('second-project');
    }
  });

  it('ignores stale session detail responses after a newer session is selected', async () => {
    type PendingRequest = {
      path: string;
      sessionId: string;
      resolve: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    };
    const pending: PendingRequest[] = [];
    const elements = {
      'session-list': new TestElement(),
      'session-conversation': new TestElement(),
      'session-snapshot-panel': new TestElement(),
      'session-snapshot-content': new TestElement(),
      'session-inspector-meta': new TestElement(),
    };
    const hooks = loadDashboardWithElements(elements, async (url) => {
      const parsed = new URL(url);
      const sessionId = parsed.searchParams.get('sessionId') || '';
      return new Promise(resolve => pending.push({ path: parsed.pathname, sessionId, resolve }));
    });
    hooks.state.sessionInspectorSessions = [
      { id: 'session-one', startedAt: '2026-06-13T09:00:00.000Z', lastEventAt: '2026-06-13T09:01:00.000Z', eventCount: 2 },
      { id: 'session-two', startedAt: '2026-06-13T10:00:00.000Z', lastEventAt: '2026-06-13T10:01:00.000Z', eventCount: 2 },
    ];

    const firstSelection = hooks.selectSession('session-one');
    const secondSelection = hooks.selectSession('session-two');
    expect(pending.map(req => `${req.path}:${req.sessionId}`)).toEqual([
      '/api/turns:session-one',
      '/api/events:session-one',
      '/api/turns:session-two',
      '/api/events:session-two',
    ]);

    const responseFor = (sessionId: string, marker: string, path: string) => ({
      ok: true,
      json: async () => path === '/api/turns'
        ? {
            turns: [{
              turnId: `${sessionId}-turn`,
              eventCount: 2,
              toolCount: 0,
              hasResponse: true,
              events: [
                { id: `${sessionId}-user`, eventType: 'user_prompt', timestamp: '2026-06-13T10:00:00.000Z', preview: `${marker} user` },
                { id: `${sessionId}-agent`, eventType: 'agent_response', timestamp: '2026-06-13T10:01:00.000Z', preview: `${marker} agent` },
              ],
            }],
          }
        : {
            events: [
              { id: `${sessionId}-user`, eventType: 'user_prompt', timestamp: '2026-06-13T10:00:00.000Z', preview: `${marker} evidence` },
            ],
          },
    });

    for (const req of pending.filter(req => req.sessionId === 'session-two')) {
      req.resolve(responseFor('session-two', 'SECOND_MARKER', req.path));
    }
    await secondSelection;
    expect(elements['session-conversation'].innerHTML).toContain('SECOND_MARKER');

    for (const req of pending.filter(req => req.sessionId === 'session-one')) {
      req.resolve(responseFor('session-one', 'STALE_MARKER', req.path));
    }
    await firstSelection;

    expect(hooks.state.selectedSession.id).toBe('session-two');
    expect(elements['session-conversation'].innerHTML).toContain('SECOND_MARKER');
    expect(elements['session-conversation'].innerHTML).not.toContain('STALE_MARKER');
  });
});
