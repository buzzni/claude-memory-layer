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
  className = '';
  children: TestElement[] = [];
  classList = { add() {}, remove() {}, toggle() {} };

  addEventListener(event: string, handler: (...args: any[]) => void) {
    this.listeners[event] = this.listeners[event] || [];
    this.listeners[event].push(handler);
  }

  appendChild(child: TestElement) {
    this.children.push(child);
    this.innerHTML += child.innerHTML;
  }
}

function loadDashboardWithElements(
  elements: Record<string, TestElement>,
  fetchImpl: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }> = async () => ({ ok: true, json: async () => ({}) })
) {
  const dashboardDir = join(process.cwd(), 'src/apps/dashboard/assets/js');
  const source = ['state.js', 'views.js', 'overview.js', 'modals.js']
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
      body: { style: {} },
      addEventListener() {},
      getElementById(id: string) { return elements[id] ?? null; },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      createElement() { return new TestElement(); },
    },
  };

  vm.runInNewContext(
    `${source}\n;globalThis.__dashboardTestHooks = { state, switchView, loadSessionInspectorView, renderSessionList, selectSession, renderSessionConversation, setSessionSnapshotTab, renderUserPromptList, updateEventsListUI, jumpToSession: typeof jumpToSession === 'function' ? jumpToSession : undefined, openDetailModal, showEventsListModal, showSessionDetailInModal };`,
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
    renderUserPromptList: () => Promise<void>;
    updateEventsListUI: () => void;
    jumpToSession?: (sessionId: string, eventId?: string) => Promise<void>;
    openDetailModal: (eventId: string) => Promise<void>;
    showEventsListModal: () => Promise<void>;
    showSessionDetailInModal: (sessionId: string) => Promise<void>;
  }}).__dashboardTestHooks;
}

const sessionPayload = {
  sessions: [
    {
      id: "session'alpha",
      startedAt: '2026-06-13T09:00:00.000Z',
      lastEventAt: '2026-06-13T09:05:00.000Z',
      eventCount: 4,
      promptPreview: 'How should we inspect user memories?',
      firstUserPromptAt: '2026-06-13T09:00:00.000Z',
      toolCount: 1,
      responseCount: 1,
      source: 'hermes',
      eventTypeCounts: { user_prompt: 1, tool_observation: 1, agent_response: 1 },
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
    expect(elements['session-list'].innerHTML).toContain('How should we inspect user memories?');
    expect(elements['session-list'].innerHTML).toContain('session-date-group');
    expect(elements['session-list'].innerHTML).toContain('1 tools');
    expect(elements['session-list'].innerHTML).toContain('1 responses');
    expect(elements['session-list'].innerHTML).toContain('source: hermes');
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

  it('renders safe Open in Sessions actions for user prompt cards', async () => {
    const elements = {
      'user-prompt-list': new TestElement(),
      'user-prompt-page': new TestElement(),
      'user-prompt-prev': new TestElement(),
      'user-prompt-next': new TestElement(),
      'user-prompt-meta': new TestElement(),
    };
    const hooks = loadDashboardWithElements(elements);
    hooks.state.userPromptItems = [
      {
        id: "event'one",
        eventType: 'user_prompt',
        timestamp: '2026-06-13T09:00:00.000Z',
        sessionId: "session'alpha",
        preview: 'Jump this prompt to the full session timeline',
      },
    ];
    hooks.state.userPromptPage = 1;
    hooks.state.userPromptPageSize = 10;

    await hooks.renderUserPromptList();

    expect(elements['user-prompt-list'].innerHTML).toContain('Open in Sessions');
    expect(elements['user-prompt-list'].innerHTML).toContain('jumpToSession(&quot;session&#039;alpha&quot;, &quot;event&#039;one&quot;)');
    expect(elements['user-prompt-list'].innerHTML).not.toContain("jumpToSession('session&#039;alpha'");
  });

  it('escapes event type labels and normalizes badge classes in the overview event list', () => {
    const elements = {
      'event-list-container': new TestElement(),
    };
    const hooks = loadDashboardWithElements(elements);
    hooks.state.isLoading = false;
    hooks.state.events = [
      {
        id: 'overview-event',
        eventType: '<img src=x onerror=alert(1)>',
        timestamp: '2026-06-13T09:00:00.000Z',
        preview: 'Overview preview',
        accessCount: 0,
      },
      {
        id: 'normal-event',
        eventType: 'user_prompt',
        timestamp: '2026-06-13T09:01:00.000Z',
        preview: 'Normal prompt',
        accessCount: 0,
      },
    ];

    hooks.updateEventsListUI();

    expect(elements['event-list-container'].innerHTML).toContain('type-img-src-x-onerror-alert-1');
    expect(elements['event-list-container'].innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(elements['event-list-container'].innerHTML).not.toContain('<img src=x');
    expect(elements['event-list-container'].innerHTML).toContain('type-user-prompt');
    expect(elements['event-list-container'].innerHTML).not.toContain('type-user_prompt');
  });

  it('jumps from an event to the session inspector and highlights the target event', async () => {
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
      if (parsed.pathname === '/api/sessions') return { ok: true, json: async () => ({ sessions: [], total: 0 }) };
      if (parsed.pathname === '/api/turns') {
        return {
          ok: true,
          json: async () => ({
            turns: [{
              turnId: 'jump-turn',
              eventCount: 2,
              toolCount: 0,
              hasResponse: true,
              events: [
                { id: 'event-target', eventType: 'user_prompt', timestamp: '2026-06-13T09:00:00.000Z', preview: 'TARGET_PROMPT_MARKER' },
                { id: 'event-agent', eventType: 'agent_response', timestamp: '2026-06-13T09:01:00.000Z', preview: 'answer' },
              ],
            }],
          }),
        };
      }
      if (parsed.pathname === '/api/events') {
        return {
          ok: true,
          json: async () => ({
            events: [
              { id: 'event-target', eventType: 'user_prompt', timestamp: '2026-06-13T09:00:00.000Z', sessionId: 'session-target', preview: 'TARGET_PROMPT_MARKER', accessCount: 0 },
            ],
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });

    expect(typeof hooks.jumpToSession).toBe('function');
    await hooks.jumpToSession?.('session-target', 'event-target');

    expect(hooks.state.currentView).toBe('sessions');
    expect(hooks.state.selectedSession.id).toBe('session-target');
    expect(hooks.state.sessionJumpEventId).toBe('event-target');
    expect(requestedUrls.map(u => new URL(u).pathname)).toEqual(['/api/sessions', '/api/turns', '/api/events']);
    expect(new URL(requestedUrls[1]).searchParams.get('sessionId')).toBe('session-target');
    expect(elements['session-conversation'].innerHTML).toContain('TARGET_PROMPT_MARKER');
    expect(elements['session-conversation'].innerHTML).toContain('session-message-jump');
    expect(elements['session-conversation'].innerHTML).toContain('Opened from User Prompts');
    expect(elements['session-conversation'].innerHTML).toContain('Jump target');
  });

  it('clears stale pending session jumps when the project changes before sessions load', async () => {
    type PendingSessions = {
      resolve: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    };
    const pendingSessions: PendingSessions[] = [];
    const elements = {
      'view-sessions': new TestElement(),
      'session-list': new TestElement(),
      'session-conversation': new TestElement(),
      'session-snapshot-panel': new TestElement(),
      'session-snapshot-content': new TestElement(),
      'session-inspector-meta': new TestElement(),
    };
    const hooks = loadDashboardWithElements(elements, async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/sessions') {
        return new Promise(resolve => pendingSessions.push({ resolve }));
      }
      return { ok: true, json: async () => ({ turns: [], events: [] }) };
    });

    hooks.state.currentProject = 'project-old';
    const jumpPromise = hooks.jumpToSession?.('old-session', 'old-event');
    await Promise.resolve();
    expect(pendingSessions).toHaveLength(1);
    expect(hooks.state.pendingSessionJump).toMatchObject({ sessionId: 'old-session', eventId: 'old-event', project: 'project-old' });

    hooks.state.currentProject = 'project-new';
    pendingSessions[0].resolve({ ok: true, json: async () => ({ sessions: [] }) });
    await jumpPromise;

    expect(hooks.state.pendingSessionJump).toBeNull();
    expect(hooks.state.sessionJumpEventId).toBeNull();
    expect(hooks.state.sessionInspectorSessions.some((s: { id: string }) => s.id === 'old-session')).toBe(false);
    expect(hooks.state.selectedSession?.id).not.toBe('old-session');
  });

  it('keeps the newer same-project pending jump when an older sessions load returns late', async () => {
    type PendingSessions = {
      resolve: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    };
    const pendingSessions: PendingSessions[] = [];
    const elements = {
      'view-sessions': new TestElement(),
      'session-list': new TestElement(),
      'session-conversation': new TestElement(),
      'session-snapshot-panel': new TestElement(),
      'session-snapshot-content': new TestElement(),
      'session-inspector-meta': new TestElement(),
    };
    const hooks = loadDashboardWithElements(elements, async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/sessions') {
        return new Promise(resolve => pendingSessions.push({ resolve }));
      }
      if (parsed.pathname === '/api/turns') {
        const sessionId = parsed.searchParams.get('sessionId');
        return {
          ok: true,
          json: async () => ({
            turns: [{
              turnId: `${sessionId}-turn`,
              eventCount: 1,
              toolCount: 0,
              hasResponse: true,
              events: [
                { id: sessionId === 'new-session' ? 'new-event' : 'old-event', eventType: 'user_prompt', timestamp: '2026-06-13T09:00:00.000Z', preview: `${sessionId} marker` },
              ],
            }],
          }),
        };
      }
      if (parsed.pathname === '/api/events') return { ok: true, json: async () => ({ events: [] }) };
      return { ok: false, json: async () => ({}) };
    });

    hooks.state.currentProject = 'same-project';
    const firstJump = hooks.jumpToSession?.('old-session', 'old-event');
    await Promise.resolve();
    expect(pendingSessions).toHaveLength(1);

    const secondJump = hooks.jumpToSession?.('new-session', 'new-event');
    await Promise.resolve();
    expect(pendingSessions).toHaveLength(2);

    pendingSessions[0].resolve({ ok: true, json: async () => ({ sessions: [] }) });
    await firstJump;
    expect(hooks.state.pendingSessionJump).toMatchObject({ sessionId: 'new-session', eventId: 'new-event', project: 'same-project' });
    expect(hooks.state.sessionJumpEventId).toBe('new-event');

    pendingSessions[1].resolve({ ok: true, json: async () => ({ sessions: [] }) });
    await secondJump;
    expect(hooks.state.selectedSession.id).toBe('new-session');
    expect(hooks.state.pendingSessionJump).toBeNull();
    expect(elements['session-conversation'].innerHTML).toContain('new-session marker');
    expect(elements['session-conversation'].innerHTML).toContain('session-message-jump');
    expect(elements['session-conversation'].innerHTML).not.toContain('old-session marker');
  });

  it('keeps a same-project pending jump when a manual sessions reload supersedes the first load', async () => {
    type PendingSessions = {
      resolve: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    };
    const pendingSessions: PendingSessions[] = [];
    const elements = {
      'view-sessions': new TestElement(),
      'session-list': new TestElement(),
      'session-conversation': new TestElement(),
      'session-snapshot-panel': new TestElement(),
      'session-snapshot-content': new TestElement(),
      'session-inspector-meta': new TestElement(),
    };
    const hooks = loadDashboardWithElements(elements, async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/sessions') {
        return new Promise(resolve => pendingSessions.push({ resolve }));
      }
      if (parsed.pathname === '/api/turns') {
        const sessionId = parsed.searchParams.get('sessionId');
        return {
          ok: true,
          json: async () => ({
            turns: [{
              turnId: `${sessionId}-turn`,
              eventCount: 1,
              toolCount: 0,
              hasResponse: true,
              events: [
                { id: 'target-event', eventType: 'user_prompt', timestamp: '2026-06-13T09:00:00.000Z', preview: 'TARGET_AFTER_RELOAD' },
              ],
            }],
          }),
        };
      }
      if (parsed.pathname === '/api/events') return { ok: true, json: async () => ({ events: [] }) };
      return { ok: false, json: async () => ({}) };
    });

    hooks.state.currentProject = 'same-project';
    const firstLoad = hooks.jumpToSession?.('target-session', 'target-event');
    await Promise.resolve();
    expect(pendingSessions).toHaveLength(1);
    const reload = hooks.loadSessionInspectorView();
    await Promise.resolve();
    expect(pendingSessions).toHaveLength(2);

    pendingSessions[0].resolve({ ok: true, json: async () => ({ sessions: [] }) });
    await firstLoad;
    expect(hooks.state.pendingSessionJump).toMatchObject({ sessionId: 'target-session', eventId: 'target-event', project: 'same-project' });

    pendingSessions[1].resolve({ ok: true, json: async () => ({ sessions: [] }) });
    await reload;
    expect(hooks.state.selectedSession.id).toBe('target-session');
    expect(hooks.state.pendingSessionJump).toBeNull();
    expect(elements['session-conversation'].innerHTML).toContain('TARGET_AFTER_RELOAD');
    expect(elements['session-conversation'].innerHTML).toContain('session-message-jump');
  });

  it('does not clear a newer pending jump when an older session detail finishes late', async () => {
    type PendingSessions = {
      resolve: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    };
    type PendingDetail = {
      path: string;
      sessionId: string;
      resolve: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    };
    const pendingSessions: PendingSessions[] = [];
    const pendingDetails: PendingDetail[] = [];
    const elements = {
      'view-sessions': new TestElement(),
      'session-list': new TestElement(),
      'session-conversation': new TestElement(),
      'session-snapshot-panel': new TestElement(),
      'session-snapshot-content': new TestElement(),
      'session-inspector-meta': new TestElement(),
    };
    const hooks = loadDashboardWithElements(elements, async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/sessions') {
        return new Promise(resolve => pendingSessions.push({ resolve }));
      }
      if (parsed.pathname === '/api/turns' || parsed.pathname === '/api/events') {
        const sessionId = parsed.searchParams.get('sessionId') || '';
        return new Promise(resolve => pendingDetails.push({ path: parsed.pathname, sessionId, resolve }));
      }
      return { ok: false, json: async () => ({}) };
    });
    const responseFor = (sessionId: string, marker: string, path: string) => ({
      ok: true,
      json: async () => path === '/api/turns'
        ? {
            turns: [{
              turnId: `${sessionId}-turn`,
              eventCount: 1,
              toolCount: 0,
              hasResponse: true,
              events: [
                { id: `${sessionId}-event`, eventType: 'user_prompt', timestamp: '2026-06-13T09:00:00.000Z', preview: marker },
              ],
            }],
          }
        : { events: [] },
    });

    hooks.state.currentProject = 'same-project';
    const firstJump = hooks.jumpToSession?.('old-session', 'old-session-event');
    await Promise.resolve();
    pendingSessions[0].resolve({ ok: true, json: async () => ({ sessions: [] }) });
    for (let i = 0; i < 10 && pendingDetails.length < 2; i++) await Promise.resolve();
    expect(pendingDetails.map(req => `${req.path}:${req.sessionId}`)).toEqual([
      '/api/turns:old-session',
      '/api/events:old-session',
    ]);

    const secondJump = hooks.jumpToSession?.('new-session', 'new-session-event');
    await Promise.resolve();
    expect(pendingSessions).toHaveLength(2);

    for (const req of pendingDetails.filter(req => req.sessionId === 'old-session')) {
      req.resolve(responseFor('old-session', 'OLD_STALE_MARKER', req.path));
    }
    await firstJump;
    expect(hooks.state.pendingSessionJump).toMatchObject({ sessionId: 'new-session', eventId: 'new-session-event', project: 'same-project' });
    expect(elements['session-conversation'].innerHTML).not.toContain('OLD_STALE_MARKER');

    pendingSessions[1].resolve({ ok: true, json: async () => ({ sessions: [] }) });
    for (let i = 0; i < 10 && pendingDetails.filter(req => req.sessionId === 'new-session').length < 2; i++) await Promise.resolve();
    for (const req of pendingDetails.filter(req => req.sessionId === 'new-session')) {
      req.resolve(responseFor('new-session', 'NEW_TARGET_MARKER', req.path));
    }
    await secondJump;

    expect(hooks.state.selectedSession.id).toBe('new-session');
    expect(hooks.state.pendingSessionJump).toBeNull();
    expect(elements['session-conversation'].innerHTML).toContain('NEW_TARGET_MARKER');
    expect(elements['session-conversation'].innerHTML).toContain('session-message-jump');
  });

  it('highlights a jumped tool observation summary without exposing raw tool output', async () => {
    const elements = {
      'view-sessions': new TestElement(),
      'session-list': new TestElement(),
      'session-conversation': new TestElement(),
      'session-snapshot-panel': new TestElement(),
      'session-snapshot-content': new TestElement(),
      'session-inspector-meta': new TestElement(),
    };
    const hooks = loadDashboardWithElements(elements, async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/sessions') return { ok: true, json: async () => ({ sessions: [], total: 0 }) };
      if (parsed.pathname === '/api/turns') {
        return {
          ok: true,
          json: async () => ({
            turns: [{
              turnId: 'tool-turn',
              eventCount: 2,
              toolCount: 1,
              hasResponse: true,
              events: [
                { id: 'tool-target', eventType: 'tool_observation', timestamp: '2026-06-13T09:00:00.000Z', preview: 'PRIVATE_TOOL_SENTINEL raw output' },
                { id: 'agent-after-tool', eventType: 'agent_response', timestamp: '2026-06-13T09:01:00.000Z', preview: 'done' },
              ],
            }],
          }),
        };
      }
      if (parsed.pathname === '/api/events') return { ok: true, json: async () => ({ events: [] }) };
      return { ok: false, json: async () => ({}) };
    });

    await hooks.jumpToSession?.('tool-session', 'tool-target');

    expect(elements['session-conversation'].innerHTML).toContain('session-tool-summary session-message-jump');
    expect(elements['session-conversation'].innerHTML).toContain('target tool highlighted');
    expect(elements['session-conversation'].innerHTML).toContain('openDetailModal(&quot;tool-target&quot;)');
    expect(elements['session-conversation'].innerHTML).not.toContain('PRIVATE_TOOL_SENTINEL');
  });

  it('escapes session ids in the session detail modal metadata', async () => {
    const elements = {
      'list-modal-title': new TestElement(),
      'list-modal-body': new TestElement(),
    };
    const maliciousSessionId = '<svg/onload=alert()>';
    const requestedUrls: string[] = [];
    const hooks = loadDashboardWithElements(elements, async (url) => {
      requestedUrls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.startsWith('/api/sessions/')) {
        return {
          ok: true,
          json: async () => ({
            session: {
              id: maliciousSessionId,
              startedAt: '2026-06-13T09:00:00.000Z',
              eventCount: 0,
            },
            events: [],
            stats: {},
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });

    await hooks.showSessionDetailInModal(maliciousSessionId);

    expect(requestedUrls[0]).toContain(`/api/sessions/${encodeURIComponent(maliciousSessionId)}`);
    expect(elements['list-modal-body'].innerHTML).toContain('&lt;svg/onload=alert()&gt;');
    expect(elements['list-modal-body'].innerHTML).not.toContain('<svg');
  });

  it('renders safe Open in Sessions actions in event list and detail modals', async () => {
    const elements = {
      'list-modal': new TestElement(),
      'list-modal-title': new TestElement(),
      'list-modal-body': new TestElement(),
      'detail-modal': new TestElement(),
      'detail-modal-body': new TestElement(),
    };
    const hooks = loadDashboardWithElements(elements, async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/events') {
        return {
          ok: true,
          json: async () => ({
            events: [{
              id: "event'one",
              eventType: '<img src=x onerror=alert(1)>',
              timestamp: '2026-06-13T09:00:00.000Z',
              sessionId: "session'alpha",
              preview: 'Prompt in total events modal',
              accessCount: 0,
            }],
          }),
        };
      }
      if (parsed.pathname === "/api/events/event'one") {
        return {
          ok: true,
          json: async () => ({
            event: {
              id: "event'one",
              eventType: '<img src=x onerror=alert(1)>',
              timestamp: '2026-06-13T09:00:00.000Z',
              sessionId: "session'alpha",
              content: 'Prompt in detail modal',
            },
            context: [],
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });

    await hooks.showEventsListModal();
    expect(elements['list-modal-body'].innerHTML).toContain('Open in Sessions');
    expect(elements['list-modal-body'].innerHTML).toContain('type-img-src-x-onerror-alert-1');
    expect(elements['list-modal-body'].innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(elements['list-modal-body'].innerHTML).not.toContain('<img src=x');
    expect(elements['list-modal-body'].innerHTML).toContain('jumpToSession(&quot;session&#039;alpha&quot;, &quot;event&#039;one&quot;)');
    expect(elements['list-modal-body'].innerHTML).not.toContain("openDetailModal('event&#039;one')");

    await hooks.openDetailModal("event'one");
    expect(elements['detail-modal-body'].innerHTML).toContain('Open in Sessions');
    expect(elements['detail-modal-body'].innerHTML).toContain('type-img-src-x-onerror-alert-1');
    expect(elements['detail-modal-body'].innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(elements['detail-modal-body'].innerHTML).not.toContain('<img src=x');
    expect(elements['detail-modal-body'].innerHTML).toContain('jumpToSession(&quot;session&#039;alpha&quot;, &quot;event&#039;one&quot;)');
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
