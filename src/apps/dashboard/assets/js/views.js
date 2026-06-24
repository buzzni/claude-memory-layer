function switchView(viewName, options = {}) {
  const forceReload = Boolean(options.forceReload);
  if (state.currentView === viewName && !forceReload) return Promise.resolve();
  state.currentView = viewName;

  // Update nav active state
  document.querySelectorAll('.nav-item[data-nav]').forEach(item => {
    item.classList.toggle('active', item.dataset.nav === viewName);
  });

  // Switch page views
  document.querySelectorAll('.page-view').forEach(view => {
    view.classList.remove('active');
  });
  const targetView = document.getElementById(`view-${viewName}`);
  if (targetView) {
    targetView.classList.add('active');
  }

  // Load view content
  switch (viewName) {
    case 'knowledge-graph': return loadKnowledgeGraphView();
    case 'memory-banks': return loadMemoryBanksView();
    case 'sessions': return loadSessionInspectorView();
    case 'user-prompts': return loadUserPromptsView();
    case 'playground': return loadPlaygroundView();
    case 'configuration': return loadConfigurationView();
    default: return Promise.resolve();
  }
}

// --- Knowledge Graph View ---

async function loadKnowledgeGraphView() {
  const container = document.getElementById('kg-content');
  container.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-muted);">Loading knowledge graph...</div>';

  try {
    const [mostAccessedRes, helpfulnessRes] = await Promise.all([
      fetch(apiUrl(`${API_BASE}/stats/most-accessed`, { limit: 20 })).then(r => r.json()).catch(() => ({ memories: [] })),
      fetch(apiUrl(`${API_BASE}/stats/helpfulness`, { limit: 10 })).then(r => r.json()).catch(() => ({ topMemories: [] }))
    ]);

    const memories = mostAccessedRes.memories || [];
    const helpful = helpfulnessRes.topMemories || [];

    if (memories.length === 0 && helpful.length === 0) {
      container.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-muted);">No knowledge data available yet. Start using memories to build your knowledge graph.</div>';
      return;
    }

    // Collect all topics
    const topicMap = {};
    memories.forEach(m => {
      (m.topics || []).forEach(t => {
        topicMap[t] = (topicMap[t] || 0) + 1;
      });
    });
    const topTopics = Object.entries(topicMap).sort((a, b) => b[1] - a[1]).slice(0, 15);

    let topicsHtml = '';
    if (topTopics.length > 0) {
      topicsHtml = `
        <div class="card" style="margin-bottom:24px;">
          <div class="card-header">
            <div class="card-title"><i class="ri-hashtag"></i><span>Top Topics</span></div>
          </div>
          <div class="kg-topic-list">
            ${topTopics.map(([topic, count]) => `
              <span class="kg-topic-tag">${escapeHtml(topic)} (${count})</span>
            `).join('')}
          </div>
        </div>
      `;
    }

    const memoriesHtml = memories.length > 0 ? `
      <div class="card" style="margin-bottom:24px;">
        <div class="card-header">
          <div class="card-title"><i class="ri-star-line"></i><span>Most Accessed Memories</span></div>
        </div>
        <div class="kg-grid">
          ${memories.map((m, i) => `
            <div class="kg-memory-card" onclick="openDetailModalByMemory('${m.memoryId || ''}')">
              <div class="kg-memory-rank">#${i + 1}</div>
              <div class="kg-memory-summary">${escapeHtml(m.summary || '(no summary)')}</div>
              ${(m.topics || []).length > 0 ? `
                <div class="kg-topic-list">
                  ${m.topics.slice(0, 3).map(t => `<span class="kg-topic-tag">${escapeHtml(t)}</span>`).join('')}
                </div>
              ` : ''}
              <div class="kg-memory-meta">
                <span><i class="ri-eye-line"></i> ${m.accessCount || 0}x accessed</span>
                <span><i class="ri-shield-check-line"></i> ${((m.confidence || 0) * 100).toFixed(0)}% confidence</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    const helpfulHtml = helpful.length > 0 ? `
      <div class="card">
        <div class="card-header">
          <div class="card-title"><i class="ri-thumb-up-line"></i><span>Most Helpful Memories</span></div>
        </div>
        ${helpful.map((m, i) => {
          const scoreColor = m.helpfulnessScore >= 0.7 ? 'var(--success)' : m.helpfulnessScore >= 0.4 ? 'var(--warning)' : 'var(--error)';
          return `
            <div class="modal-list-item" onclick="openDetailModalByEvent('${m.eventId || ''}')">
              <div class="modal-list-info">
                <div class="title">#${i + 1} ${escapeHtml(m.summary || '(no summary)')}</div>
                <div class="subtitle">${m.accessCount || 0}x accessed | ${m.evaluationCount || 0} evaluations</div>
              </div>
              <div class="modal-list-badge" style="color:${scoreColor}; background:${scoreColor}22;">${m.helpfulnessScore}</div>
            </div>
          `;
        }).join('')}
      </div>
    ` : '';

    container.innerHTML = topicsHtml + memoriesHtml + helpfulHtml;

  } catch (error) {
    container.innerHTML = `<div style="text-align:center; padding:60px; color:var(--error);">Failed to load knowledge graph: ${escapeHtml(error.message)}</div>`;
  }
}

function openDetailModalByMemory(memoryId) {
  // memoryId might be an event ID - try to open it
  if (memoryId) openDetailModal(memoryId);
}

function openDetailModalByEvent(eventId) {
  if (eventId) openDetailModal(eventId);
}

// --- Memory Banks View ---

async function loadMemoryBanksView() {
  const container = document.getElementById('mb-content');
  container.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-muted);">Loading memory banks...</div>';

  try {
    const [statsRes, graduationRes] = await Promise.all([
      fetch(apiUrl(`${API_BASE}/stats`)).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/graduation`)).then(r => r.json()).catch(() => null)
    ]);

    const levelStats = statsRes?.levelStats || [];
    const levels = ['L0', 'L1', 'L2', 'L3', 'L4'];
    const levelNames = { L0: 'Raw Events', L1: 'Structured', L2: 'Validated', L3: 'Verified', L4: 'Active' };
    const levelCounts = {};
    levelStats.forEach(s => { levelCounts[s.level] = s.count; });

    const criteria = graduationRes?.criteria || {};

    container.innerHTML = `
      <div class="mb-level-tabs" id="mb-tabs">
        ${levels.map(level => `
          <button class="mb-level-tab ${level === 'L0' ? 'active' : ''}" data-level="${level}" style="border-left:3px solid ${CHART_COLORS[level]};">
            ${levelNames[level]} <span class="tab-count">(${levelCounts[level] || 0})</span>
          </button>
        `).join('')}
      </div>
      <div class="card" style="margin-bottom:24px;">
        <div class="card-header">
          <div class="card-title"><i class="ri-stack-line"></i><span>Level Events</span></div>
        </div>
        <div id="mb-events-list">
          <div style="text-align:center; padding:20px; color:var(--text-muted);">Select a level to view events</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title"><i class="ri-graduation-cap-line"></i><span>Graduation Criteria</span></div>
        </div>
        ${Object.entries(criteria).map(([key, c]) => `
          <div style="margin-bottom:16px;">
            <div style="font-size:14px; font-weight:600; color:var(--accent-primary); margin-bottom:8px;">${key}</div>
            <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px;">
              <div class="cfg-row" style="padding:8px 12px; background:rgba(255,255,255,0.02); border-radius:8px; border:none;">
                <span class="cfg-row-label">Min Access</span>
                <span class="cfg-row-value">${c.minAccessCount}</span>
              </div>
              <div class="cfg-row" style="padding:8px 12px; background:rgba(255,255,255,0.02); border-radius:8px; border:none;">
                <span class="cfg-row-label">Min Confidence</span>
                <span class="cfg-row-value">${c.minConfidence}</span>
              </div>
              <div class="cfg-row" style="padding:8px 12px; background:rgba(255,255,255,0.02); border-radius:8px; border:none;">
                <span class="cfg-row-label">Cross-Session Refs</span>
                <span class="cfg-row-value">${c.minCrossSessionRefs}</span>
              </div>
              <div class="cfg-row" style="padding:8px 12px; background:rgba(255,255,255,0.02); border-radius:8px; border:none;">
                <span class="cfg-row-label">Max Age (days)</span>
                <span class="cfg-row-value">${c.maxAgeDays}</span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    // Setup level tab click handlers
    document.querySelectorAll('#mb-tabs .mb-level-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#mb-tabs .mb-level-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        loadMemoryBankLevel(tab.dataset.level);
      });
    });

    // Load L0 by default
    await loadMemoryBankLevel('L0');

  } catch (error) {
    container.innerHTML = `<div style="text-align:center; padding:60px; color:var(--error);">Failed to load memory banks: ${escapeHtml(error.message)}</div>`;
  }
}

async function loadMemoryBankLevel(level) {
  const container = document.getElementById('mb-events-list');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted);">Loading...</div>';

  try {
    const res = await fetch(apiUrl(`${API_BASE}/stats/levels/${level}`, { limit: 30 }));
    const data = await res.json();
    const events = data.events || [];

    if (events.length === 0) {
      container.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted);">No events at level ${level}</div>`;
      return;
    }

    container.innerHTML = `
      <div class="mb-event-list">
        ${events.map(e => {
          const typeClass = eventTypeBadgeClass(e.eventType);
          const eventArg = jsAttrArg(e.id || '');
          return `
            <div class="mb-event-card" ${e.id ? `onclick="openDetailModal(${eventArg})"` : ''}>
              <div class="mb-event-header">
                <span class="event-type-badge ${typeClass}">${escapeHtml(e.eventType || 'event')}</span>
                <div style="display:flex; gap:8px; align-items:center;">
                  ${e.accessCount > 0 ? `<span class="access-badge"><i class="ri-eye-line"></i> ${formatNumber(e.accessCount)}</span>` : ''}
                  <span class="event-time">${new Date(e.timestamp).toLocaleString()}</span>
                </div>
              </div>
              <div class="mb-event-content">${escapeHtml((e.content || '').slice(0, 200))}</div>
            </div>
          `;
        }).join('')}
      </div>
      ${data.hasMore ? `<div style="text-align:center; padding:16px; color:var(--text-muted); font-size:13px;">Showing ${events.length} of ${data.total} events</div>` : ''}
    `;
  } catch (error) {
    container.innerHTML = `<div style="text-align:center; padding:20px; color:var(--error);">Failed to load level ${level}</div>`;
  }
}

// --- Session Inspector View ---

function formatSessionTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function formatSessionDateGroup(value) {
  if (!value) return 'Undated sessions';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Undated sessions';
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const deltaDays = Math.round((startOfToday - startOfDate) / 86400000);
  if (deltaDays === 0) return 'Today';
  if (deltaDays === 1) return 'Yesterday';
  if (deltaDays > 1 && deltaDays < 7) return `${deltaDays} days ago`;
  return date.toLocaleDateString();
}

function sessionShortId(id) {
  const text = String(id || 'unknown');
  return text.length > 18 ? `${text.slice(0, 18)}...` : text;
}

function sessionEventTypeClass(type) {
  return eventTypeBadgeClass(type);
}

function getSessionEventLevel(event) {
  const metadata = event?.metadata || event?.meta || {};
  return metadata.level || metadata.memoryLevel || metadata.stage || 'L0';
}

function sessionPreviewText(event, max = 280) {
  const preview = event?.preview || '';
  return escapeHtml(String(preview).slice(0, max));
}

function sessionEvidencePreviewText(event, max = 120) {
  if (event?.eventType === 'tool_observation') {
    return '<em>Tool observation preview hidden</em>';
  }
  return sessionPreviewText(event, max);
}

async function jumpToSession(sessionId, eventId) {
  if (!sessionId) return;
  state.pendingSessionJump = { sessionId, eventId: eventId || null, project: state.currentProject || '' };
  state.sessionJumpEventId = eventId || null;
  state.sessionDetailRequestId = (state.sessionDetailRequestId || 0) + 1;
  if (typeof closeAllModals === 'function') closeAllModals();
  await switchView('sessions', { forceReload: true });
}

async function loadSessionInspectorView() {
  const listEl = document.getElementById('session-list');
  if (!listEl) return;

  const requestId = (state.sessionInspectorRequestId || 0) + 1;
  state.sessionInspectorRequestId = requestId;
  const projectAtStart = state.currentProject;
  const jumpAtStart = state.pendingSessionJump;
  state.isSessionInspectorLoading = true;
  renderSessionList();

  try {
    const res = await fetch(apiUrl(`${API_BASE}/sessions`, {
      page: state.sessionInspectorPage,
      pageSize: state.sessionInspectorPageSize
    }));
    const data = res.ok ? await res.json() : { sessions: [] };
    if (requestId !== state.sessionInspectorRequestId || projectAtStart !== state.currentProject) {
      if (projectAtStart !== state.currentProject && jumpAtStart && state.pendingSessionJump === jumpAtStart) {
        state.pendingSessionJump = null;
        state.sessionJumpEventId = null;
      }
      return;
    }
    const pendingJump = state.pendingSessionJump;
    const jump = pendingJump?.project === projectAtStart ? pendingJump : null;
    if (pendingJump && !jump) {
      state.pendingSessionJump = null;
      state.sessionJumpEventId = null;
    }
    let sessions = data.sessions || [];
    if (jump?.sessionId && !sessions.some(s => s.id === jump.sessionId)) {
      sessions = [{ id: jump.sessionId, eventCount: 0 }, ...sessions];
    }
    state.sessionInspectorSessions = sessions;
    state.isSessionInspectorLoading = false;
    renderSessionList();

    const selectedStillExists = state.selectedSession && state.sessionInspectorSessions.some(s => s.id === state.selectedSession.id);
    const nextSessionId = jump?.sessionId || (selectedStillExists ? state.selectedSession.id : state.sessionInspectorSessions[0]?.id);
    if (nextSessionId) {
      await selectSession(nextSessionId);
      if (requestId !== state.sessionInspectorRequestId || projectAtStart !== state.currentProject) return;
      if (jump && state.pendingSessionJump === jump && jump.sessionId === nextSessionId) state.pendingSessionJump = null;
    } else {
      state.selectedSession = null;
      state.selectedSessionTurns = [];
      state.selectedSessionEvents = [];
      renderSessionConversation();
      renderSessionSnapshot();
    }
  } catch (error) {
    if (requestId !== state.sessionInspectorRequestId || projectAtStart !== state.currentProject) {
      if (projectAtStart !== state.currentProject && jumpAtStart && state.pendingSessionJump === jumpAtStart) {
        state.pendingSessionJump = null;
        state.sessionJumpEventId = null;
      }
      return;
    }
    if (jumpAtStart && state.pendingSessionJump === jumpAtStart) {
      state.pendingSessionJump = null;
      state.sessionJumpEventId = null;
    }
    state.isSessionInspectorLoading = false;
    listEl.innerHTML = `<div class="session-empty" style="color:var(--error);">Failed to load sessions: ${escapeHtml(error.message)}</div>`;
  }
}

function renderSessionList() {
  const listEl = document.getElementById('session-list');
  const metaEl = document.getElementById('session-inspector-meta');
  if (!listEl) return;

  if (state.isSessionInspectorLoading) {
    listEl.innerHTML = '<div class="session-empty">Loading sessions...</div>';
    if (metaEl) metaEl.textContent = 'Loading recent sessions...';
    return;
  }

  const sessions = state.sessionInspectorSessions || [];
  if (metaEl) {
    metaEl.textContent = `${sessions.length} sessions · page ${state.sessionInspectorPage}`;
  }

  if (sessions.length === 0) {
    listEl.innerHTML = '<div class="session-empty">No sessions found for the selected project.</div>';
    return;
  }

  let previousGroup = '';
  listEl.innerHTML = sessions.map((session) => {
    const selected = state.selectedSession?.id === session.id;
    const durationMs = session.startedAt && session.lastEventAt
      ? Math.max(0, new Date(session.lastEventAt).getTime() - new Date(session.startedAt).getTime())
      : 0;
    const durationMin = durationMs > 0 ? `${Math.max(1, Math.round(durationMs / 60000))}m` : '-';
    const timeValue = session.lastEventAt || session.endedAt || session.startedAt || session.firstUserPromptAt;
    const group = formatSessionDateGroup(timeValue);
    const promptPreview = session.promptPreview || 'No user prompt preview yet';
    const source = session.source || 'unknown';
    const toolCount = Number(session.toolCount || session.eventTypeCounts?.tool_observation || 0);
    const responseCount = Number(session.responseCount || session.eventTypeCounts?.agent_response || 0);
    const groupHtml = group !== previousGroup ? `<div class="session-date-group">${escapeHtml(group)}</div>` : '';
    previousGroup = group;
    return `
      ${groupHtml}
      <button class="session-list-item ${selected ? 'active' : ''}" onclick="selectSession(${jsAttrArg(session.id)})">
        <span class="session-list-title">${escapeHtml(promptPreview)}</span>
        <span class="session-list-id">${escapeHtml(sessionShortId(session.id))}</span>
        <span class="session-list-meta">${formatNumber(session.eventCount || 0)} events · ${durationMin} · ${formatNumber(toolCount)} tools · ${formatNumber(responseCount)} responses</span>
        <span class="session-list-time">${formatSessionTime(timeValue)}</span>
        <span class="session-list-source">source: ${escapeHtml(source)}</span>
      </button>
    `;
  }).join('');
}

async function selectSession(sessionId) {
  if (!sessionId) return;

  const detailRequestId = (state.sessionDetailRequestId || 0) + 1;
  state.sessionDetailRequestId = detailRequestId;
  const activeJump = state.pendingSessionJump;
  if (!activeJump || activeJump.sessionId !== sessionId || activeJump.project !== (state.currentProject || '')) {
    state.sessionJumpEventId = null;
  }
  const projectAtStart = state.currentProject;
  const sessions = state.sessionInspectorSessions || [];
  state.selectedSession = sessions.find(s => s.id === sessionId) || { id: sessionId, eventCount: 0 };
  state.selectedSessionTurns = [];
  state.selectedSessionEvents = [];
  state.isSessionDetailLoading = true;
  renderSessionList();
  renderSessionConversation();
  renderSessionSnapshot();

  try {
    const [turnsRes, eventsRes] = await Promise.all([
      fetch(apiUrl(`${API_BASE}/turns`, { sessionId, limit: 50, offset: 0 })),
      fetch(apiUrl(`${API_BASE}/events`, { sessionId, limit: 300, sort: 'oldest' }))
    ]);
    const turnsData = turnsRes.ok ? await turnsRes.json() : { turns: [] };
    const eventsData = eventsRes.ok ? await eventsRes.json() : { events: [] };

    if (
      detailRequestId !== state.sessionDetailRequestId ||
      projectAtStart !== state.currentProject ||
      state.selectedSession?.id !== sessionId
    ) {
      return;
    }

    state.selectedSessionTurns = turnsData.turns || [];
    state.selectedSessionEvents = eventsData.events || [];
    state.isSessionDetailLoading = false;
    renderSessionConversation();
    renderSessionSnapshot();
  } catch (error) {
    if (
      detailRequestId !== state.sessionDetailRequestId ||
      projectAtStart !== state.currentProject ||
      state.selectedSession?.id !== sessionId
    ) {
      return;
    }
    state.isSessionDetailLoading = false;
    const conversationEl = document.getElementById('session-conversation');
    if (conversationEl) {
      conversationEl.innerHTML = `<div class="session-empty" style="color:var(--error);">Failed to load session detail: ${escapeHtml(error.message)}</div>`;
    }
    renderSessionSnapshot();
  }
}

function renderSessionConversation() {
  const container = document.getElementById('session-conversation');
  const metaEl = document.getElementById('session-conversation-meta');
  if (!container) return;

  if (state.isSessionDetailLoading) {
    container.innerHTML = '<div class="session-empty">Loading conversation turns...</div>';
    if (metaEl) metaEl.textContent = 'Loading...';
    return;
  }

  if (!state.selectedSession) {
    container.innerHTML = '<div class="session-empty">Choose a session on the left to see user → tools → assistant flow.</div>';
    if (metaEl) metaEl.textContent = 'No session selected';
    return;
  }

  const turns = state.selectedSessionTurns || [];
  if (metaEl) {
    metaEl.textContent = `${sessionShortId(state.selectedSession.id)} · ${turns.length} turns`;
  }

  if (turns.length === 0) {
    container.innerHTML = '<div class="session-empty">No turn grouping found. Try running turn backfill if this is legacy data.</div>';
    return;
  }

  const jumpNotice = state.sessionJumpEventId ? `
    <div class="session-jump-notice">
      <i class="ri-corner-down-right-line"></i>
      <span>Opened from User Prompts · Jump target is highlighted below.</span>
    </div>
  ` : '';

  container.innerHTML = jumpNotice + turns.map((turn, index) => {
    const events = turn.events || [];
    const userEvents = events.filter(e => e.eventType === 'user_prompt');
    const agentEvents = events.filter(e => e.eventType === 'agent_response');
    const toolEvents = events.filter(e => e.eventType === 'tool_observation');
    const otherEvents = events.filter(e => !['user_prompt', 'agent_response', 'tool_observation'].includes(e.eventType));
    const jumpedToolEvent = toolEvents.find(e => e.id && state.sessionJumpEventId === e.id);
    const renderMessage = (event, roleLabel, icon) => {
      const jumpClass = event.id && state.sessionJumpEventId === event.id ? 'session-message-jump' : '';
      return `
      <div class="session-message ${sessionEventTypeClass(event.eventType)} ${jumpClass}" ${event.id ? `onclick="openDetailModal(${jsAttrArg(event.id)})"` : ''}>
        <div class="session-message-role">${icon} ${roleLabel}${jumpClass ? ' · <span class="session-jump-badge">Jump target</span>' : ''}</div>
        <div class="session-message-preview">${sessionPreviewText(event)}</div>
        <div class="session-message-meta">${escapeHtml(event.eventType || 'event')} · ${formatSessionTime(event.timestamp)} · ${escapeHtml(event.id || '')}</div>
      </div>
    `;
    };

    return `
      <article class="session-turn">
        <div class="session-turn-header">
          <span>Turn ${index + 1}</span>
          <span>${formatNumber(turn.eventCount || events.length || 0)} events · ${formatNumber(turn.toolCount ?? toolEvents.length)} tools · ${turn.hasResponse ? 'answered' : 'open'}</span>
        </div>
        ${userEvents.map(e => renderMessage(e, 'User', '👤')).join('')}
        ${toolEvents.length > 0 ? `
          <div class="session-tool-summary ${jumpedToolEvent ? 'session-message-jump' : ''}" ${jumpedToolEvent?.id ? `onclick="openDetailModal(${jsAttrArg(jumpedToolEvent.id)})"` : ''}>
            <i class="ri-tools-line"></i>
            <span>${formatNumber(toolEvents.length)} tool observations captured · raw tool output hidden in timeline${jumpedToolEvent ? ' · target tool highlighted' : ''}</span>
          </div>
        ` : ''}
        ${agentEvents.map(e => renderMessage(e, 'Assistant', '🤖')).join('')}
        ${otherEvents.map(e => renderMessage(e, 'Event', '•')).join('')}
      </article>
    `;
  }).join('');
}

function setSessionSnapshotTab(tab) {
  const allowed = ['overview', 'evidence', 'quality'];
  state.sessionSnapshotTab = allowed.includes(tab) ? tab : 'overview';
  document.querySelectorAll('#session-snapshot-tabs .sort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sessionSnapshotTab === state.sessionSnapshotTab);
  });
  renderSessionSnapshot();
}

function renderSessionSnapshot() {
  const container = document.getElementById('session-snapshot-content');
  if (!container) return;

  if (state.isSessionDetailLoading) {
    container.innerHTML = '<div class="session-empty">Loading memory snapshot...</div>';
    return;
  }

  if (!state.selectedSession) {
    container.innerHTML = '<div class="session-empty">Select a session to see memory levels, evidence links, and quality signals.</div>';
    return;
  }

  const tab = state.sessionSnapshotTab || 'overview';
  if (tab === 'evidence') {
    renderSessionEvidenceSnapshot(container);
  } else if (tab === 'quality') {
    renderSessionQualitySnapshot(container);
  } else {
    renderSessionOverviewSnapshot(container);
  }
}

function renderSessionOverviewSnapshot(container) {
  const session = state.selectedSession || {};
  const turns = state.selectedSessionTurns || [];
  const events = state.selectedSessionEvents || [];
  const eventCount = session.eventCount || events.length || 0;
  const levelCounts = {};
  const typeCounts = {};
  for (const event of events) {
    const level = getSessionEventLevel(event);
    levelCounts[level] = (levelCounts[level] || 0) + 1;
    const type = event.eventType || 'unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }

  container.innerHTML = `
    <div class="snapshot-kpi-grid">
      <div class="snapshot-kpi"><strong>${formatNumber(eventCount)} events</strong><span>captured</span></div>
      <div class="snapshot-kpi"><strong>${formatNumber(turns.length)} turns</strong><span>conversation groups</span></div>
      <div class="snapshot-kpi"><strong>${formatNumber(events.filter(e => (e.accessCount || 0) > 0).length)} used</strong><span>retrieved later</span></div>
    </div>
    <div class="snapshot-section-title">Memory Levels</div>
    <div class="snapshot-chip-list">
      ${Object.entries(levelCounts).length > 0
        ? Object.entries(levelCounts).map(([level, count]) => `<span class="snapshot-chip">${escapeHtml(level)} · ${formatNumber(count)}</span>`).join('')
        : '<span class="snapshot-chip muted">No level metadata</span>'}
    </div>
    <div class="snapshot-section-title">Event Mix</div>
    <div class="snapshot-chip-list">
      ${Object.entries(typeCounts).map(([type, count]) => `<span class="snapshot-chip">${escapeHtml(type)} · ${formatNumber(count)}</span>`).join('') || '<span class="snapshot-chip muted">No events loaded</span>'}
    </div>
    <div class="snapshot-note">Raw metadata is intentionally hidden here; use Event Detail for explicit drill-down.</div>
  `;
}

function renderSessionEvidenceSnapshot(container) {
  const events = state.selectedSessionEvents || [];
  const visible = events.slice(0, 30);
  container.innerHTML = `
    <div class="snapshot-section-title">Evidence Coverage</div>
    <div class="snapshot-note">Showing sanitized event IDs, types, levels, and short previews. Raw metadata and tool output are not rendered in this panel.</div>
    ${visible.length === 0 ? '<div class="session-empty">No evidence events loaded.</div>' : ''}
    <div class="snapshot-evidence-list">
      ${visible.map(event => `
        <button class="snapshot-evidence-item" ${event.id ? `onclick="openDetailModal(${jsAttrArg(event.id)})"` : ''}>
          <span class="event-type-badge ${sessionEventTypeClass(event.eventType)}">${escapeHtml(event.eventType || 'event')}</span>
          <span class="snapshot-evidence-id">${escapeHtml(event.id || '')}</span>
          <span class="snapshot-evidence-meta">${escapeHtml(getSessionEventLevel(event))} · ${formatSessionTime(event.timestamp)} · ${formatNumber(event.accessCount || 0)} hits</span>
          <span class="snapshot-evidence-preview">${sessionEvidencePreviewText(event, 120)}</span>
        </button>
      `).join('')}
    </div>
  `;
}

function renderSessionQualitySnapshot(container) {
  const turns = state.selectedSessionTurns || [];
  const events = state.selectedSessionEvents || [];
  const answeredTurns = turns.filter(t => t.hasResponse).length;
  const toolCount = turns.reduce((sum, turn) => sum + Number(turn.toolCount || 0), 0);
  const userPromptCount = events.filter(e => e.eventType === 'user_prompt').length;
  const responseCount = events.filter(e => e.eventType === 'agent_response').length;
  const responseCoverage = turns.length > 0 ? Math.round((answeredTurns / turns.length) * 100) : 0;

  container.innerHTML = `
    <div class="snapshot-kpi-grid">
      <div class="snapshot-kpi"><strong>${responseCoverage}%</strong><span>response coverage</span></div>
      <div class="snapshot-kpi"><strong>${formatNumber(toolCount)}</strong><span>tool observations</span></div>
      <div class="snapshot-kpi"><strong>${formatNumber(userPromptCount)}:${formatNumber(responseCount)}</strong><span>prompt/response</span></div>
    </div>
    <div class="snapshot-section-title">Turn Quality Signals</div>
    <div class="snapshot-chip-list">
      <span class="snapshot-chip">${formatNumber(answeredTurns)} answered turns</span>
      <span class="snapshot-chip">${formatNumber(Math.max(0, turns.length - answeredTurns))} open turns</span>
      <span class="snapshot-chip">${formatNumber(events.filter(e => (e.accessCount || 0) > 0).length)} reused memories</span>
    </div>
    <div class="snapshot-note">This is a lightweight dashboard heuristic, not a model judgment. It helps spot sessions with missing responses, heavy tool usage, or later memory reuse.</div>
  `;
}

// --- User Prompts View ---

async function renderUserPromptList() {
  const listEl = document.getElementById('user-prompt-list');
  const pageEl = document.getElementById('user-prompt-page');
  const prevBtn = document.getElementById('user-prompt-prev');
  const nextBtn = document.getElementById('user-prompt-next');
  const metaEl = document.getElementById('user-prompt-meta');
  if (!listEl) return;

  const items = state.userPromptItems || [];
  const pageSize = state.userPromptPageSize;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  if (state.userPromptPage > totalPages) state.userPromptPage = totalPages;

  const start = (state.userPromptPage - 1) * pageSize;
  const paged = items.slice(start, start + pageSize);

  if (pageEl) pageEl.textContent = `${state.userPromptPage} / ${totalPages}`;
  if (prevBtn) prevBtn.disabled = state.userPromptPage <= 1;
  if (nextBtn) nextBtn.disabled = state.userPromptPage >= totalPages;

  if (metaEl) {
    const sessionCount = new Set(items.map(i => i.sessionId)).size;
    metaEl.textContent = `${items.length} prompts · ${sessionCount} sessions${state.userPromptSearchQuery ? ` · query: "${state.userPromptSearchQuery}"` : ''}`;
  }

  if (paged.length === 0) {
    listEl.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted);">No user prompts found.</div>';
    return;
  }

  // Group current page by session
  const groups = new Map();
  for (const e of paged) {
    const key = e.sessionId || 'unknown';
    const arr = groups.get(key) || [];
    arr.push(e);
    groups.set(key, arr);
  }

  const html = Array.from(groups.entries()).map(([sessionId, sessionItems]) => {
    const heading = `
      <div style="margin:10px 0 6px; font-size:12px; color:var(--text-muted); font-weight:600;">
        <i class="ri-chat-1-line"></i> Session ${escapeHtml((sessionId || '').slice(0, 16))}... · ${sessionItems.length} prompts
      </div>
    `;

    const cards = sessionItems.map((e) => {
      const eventArg = jsAttrArg(e.id || '');
      const sessionArg = jsAttrArg(e.sessionId || '');
      return `
      <div class="event-item" style="cursor:pointer;" ${e.id ? `onclick="openDetailModal(${eventArg})"` : ''}>
        <div class="event-header">
          <span class="event-type-badge type-user-prompt">user_prompt</span>
          <span class="event-time">${new Date(e.timestamp).toLocaleString()}</span>
        </div>
        <div class="event-content" style="-webkit-line-clamp:4;">${escapeHtml(e.preview || '')}</div>
        ${e.sessionId ? `
          <div class="event-actions">
            <button type="button" class="inline-action-btn" onclick="event.stopPropagation(); jumpToSession(${sessionArg}, ${eventArg})">
              <i class="ri-corner-right-up-line"></i> Open in Sessions
            </button>
          </div>
        ` : ''}
      </div>
    `;
    }).join('');

    return heading + cards;
  }).join('');

  listEl.innerHTML = html;
}

async function loadUserPromptsView() {
  const listEl = document.getElementById('user-prompt-list');
  if (!listEl) return;

  listEl.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted);">Loading user prompts...</div>';

  try {
    const params = {
      type: 'user_prompt',
      sort: 'recent',
      limit: 500,
      q: state.userPromptSearchQuery || undefined
    };
    const res = await fetch(apiUrl(`${API_BASE}/events`, params));
    const data = await res.json();
    const items = data.events || [];
    state.userPromptItems = items;

    await renderUserPromptList();
  } catch (error) {
    listEl.innerHTML = `<div style="padding:20px; text-align:center; color:var(--error);">Failed to load user prompts: ${escapeHtml(error.message)}</div>`;
  }
}

// --- Playground View ---

async function loadPlaygroundView() {
  renderPlaygroundDryRun(state.playgroundLastRun);
  const status = document.getElementById('playground-status');
  if (status && !state.playgroundLastRun) {
    status.textContent = state.currentProject
      ? 'Ready. Dry-run uses the selected project scope.'
      : 'Ready. Global dry-run; select a project for project-local replay.';
  }
}

async function runPlaygroundDryRun() {
  if (state.isPlaygroundLoading) return;
  const queryInput = document.getElementById('playground-query');
  const query = (queryInput?.value || '').trim();
  const status = document.getElementById('playground-status');
  const button = document.getElementById('playground-run-btn');
  if (!query) {
    if (status) status.textContent = 'Enter a query before running a dry-run replay.';
    return;
  }

  const strategy = document.getElementById('playground-strategy')?.value || 'fast';
  const topK = Math.max(1, Math.min(20, parseInt(document.getElementById('playground-topk')?.value || '5', 10) || 5));
  const windowSize = Math.max(1, Math.min(10, parseInt(document.getElementById('playground-window')?.value || '3', 10) || 3));
  const includeShared = Boolean(document.getElementById('playground-include-shared')?.checked);

  state.isPlaygroundLoading = true;
  if (button) button.disabled = true;
  if (status) status.textContent = 'Running dry-run replay...';
  renderPlaygroundDryRun(null, true);

  try {
    const res = await fetch(apiUrl('/api/playground/dry-run'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        options: { strategy, topK, includeShared, windowSize }
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Playground dry-run failed');
    state.playgroundLastRun = data;
    if (status) status.textContent = `Dry-run complete · ${data.search?.results?.length || 0} result(s) · ${data.replayTrace?.join(' → ') || 'no trace'}`;
    renderPlaygroundDryRun(data);
  } catch (error) {
    if (status) status.textContent = `Dry-run failed: ${error.message}`;
    renderPlaygroundDryRun({ error: error.message, replayTrace: [] });
  } finally {
    state.isPlaygroundLoading = false;
    if (button) button.disabled = false;
  }
}

function renderPlaygroundDryRun(result, isLoading = false) {
  const container = document.getElementById('playground-output');
  if (!container) return;
  if (isLoading) {
    container.innerHTML = `
      <div class="disclosure-results"><div class="disclosure-empty">Searching ranked candidates...</div></div>
      <div class="disclosure-drilldown"><div class="disclosure-empty">Replay trace will appear after search.</div></div>
    `;
    return;
  }
  if (!result) {
    container.innerHTML = `
      <div class="disclosure-results"><div class="disclosure-empty">Run a query to see ranked results and replay trace.</div></div>
      <div class="disclosure-drilldown"><div class="disclosure-empty">Expansion/source details will appear here.</div></div>
    `;
    return;
  }
  if (result.error) {
    container.innerHTML = `
      <div class="disclosure-results"><div class="disclosure-empty" style="color:var(--error);">${escapeHtml(result.error)}</div></div>
      <div class="disclosure-drilldown"><div class="disclosure-empty">No replay output.</div></div>
    `;
    return;
  }

  const results = result.search?.results || [];
  const resultCards = results.length ? results.map((r, idx) => `
    <div class="disclosure-result${r.id === result.selectedResultId ? ' active' : ''}">
      <div class="disclosure-result-head">
        <span class="event-type-badge">#${idx + 1} ${escapeHtml(r.resultType || 'result')}</span>
        <span class="disclosure-scope-pill">score ${Number(r.score || 0).toFixed(2)}</span>
      </div>
      <div class="disclosure-snippet">${highlightDisclosureText(r.snippet || r.preview || '', result.query || '')}</div>
      <div class="disclosure-rank-explain"><strong>Why this ranked</strong>${(r.reasons || []).map(reason => `<span class="disclosure-chip">${escapeHtml(reason)}</span>`).join('') || '<span class="disclosure-chip">no_reason</span>'}</div>
    </div>
  `).join('') : '<div class="disclosure-empty">No results. Try a broader query or another project scope.</div>';

  const trace = (result.replayTrace || []).map(step => `<span class="disclosure-chip">${escapeHtml(step)}</span>`).join('');
  const expansionFacts = (result.expansion?.surroundingFacts || []).slice(0, 6).map(f => `
    <div class="shared-item"><div class="shared-info"><span>${escapeHtml(f.snippet || f.summary || f.id || 'fact')}</span></div></div>
  `).join('') || '<div class="disclosure-empty">No expansion facts returned.</div>';
  const rawEvents = (result.source?.rawEvents || []).slice(0, 3).map(e => {
    const preview = e?.preview || e?.id || e?.eventId || 'source preview unavailable';
    return `<pre class="disclosure-source-pre">${escapeHtml(buildSafeDisclosurePreview(preview))}</pre>`;
  }).join('') || '<div class="disclosure-empty">No safe source preview returned.</div>';

  container.innerHTML = `
    <div class="disclosure-results">
      <div class="snapshot-note">Dry-run: ${result.mutated === false ? 'no memory writes' : 'mutation state unknown'} · selected ${escapeHtml(result.selectedResultId || 'none')}</div>
      ${resultCards}
    </div>
    <div class="disclosure-drilldown">
      <div class="disclosure-section-title">Replay Trace</div>
      <div class="disclosure-rank-explain">${trace || '<span class="disclosure-chip">empty</span>'}</div>
      <div class="disclosure-section-title" style="margin-top:14px;">Expand layer</div>
      ${expansionFacts}
      <div class="disclosure-section-title" style="margin-top:14px;">Source layer</div>
      ${rawEvents}
    </div>
  `;
}

// --- Configuration View ---

function renderSetupProviderHealthCard(setupHealth) {
  if (!setupHealth) {
    return `
      <div class="card setup-provider-health-card" style="margin-bottom:24px;">
        <div class="card-header"><div class="card-title"><i class="ri-stethoscope-line"></i><span>Setup & Provider Health</span></div></div>
        <div class="disclosure-empty">Setup health is unavailable.</div>
      </div>
    `;
  }
  const setup = setupHealth.setup || {};
  const storage = setup.storage || {};
  const outbox = setup.outbox || {};
  const providers = setupHealth.providers || {};
  const claude = providers.claudeCli || {};
  const embeddings = providers.embeddings || {};
  const recommendations = Array.isArray(setupHealth.recommendations) ? setupHealth.recommendations : [];
  const status = setupHealth.status || 'unknown';
  const scope = setup.scope || 'global';
  const recommendationHtml = recommendations.length
    ? recommendations.map(item => `<div class="snapshot-note">${escapeHtml(item)}</div>`).join('')
    : '<div class="snapshot-note">No setup action required.</div>';

  return `
    <div class="card setup-provider-health-card" style="margin-bottom:24px;">
      <div class="card-header" style="align-items:flex-start;">
        <div>
          <div class="card-title"><i class="ri-stethoscope-line"></i><span>Setup & Provider Health</span></div>
          <div class="session-muted">Provider readiness, storage visibility, and setup guidance for the current ${escapeHtml(scope)} scope.</div>
        </div>
        <span class="disclosure-scope-pill">${escapeHtml(status)}</span>
      </div>
      <div class="cfg-grid">
        <div class="cfg-section">
          <div class="cfg-section-title"><i class="ri-hard-drive-2-line"></i>Storage Readiness</div>
          <div class="cfg-row"><span class="cfg-row-label">Status</span><span class="cfg-row-value">${escapeHtml(storage.status || 'unknown')}</span></div>
          <div class="cfg-row"><span class="cfg-row-label">Events</span><span class="cfg-row-value">${formatNumber(storage.totalEvents || 0)} events</span></div>
          <div class="cfg-row"><span class="cfg-row-label">Vectors</span><span class="cfg-row-value">${formatNumber(storage.vectorCount || 0)} vectors</span></div>
          <div class="cfg-row"><span class="cfg-row-label">Outbox</span><span class="cfg-row-value">${formatNumber(outbox.pending || 0)} pending · ${formatNumber(outbox.failed || 0)} failed · ${formatNumber(outbox.retryableFailed || 0)} retryable · ${formatNumber(outbox.quarantinedFailed || 0)} quarantined · ${formatNumber(outbox.stuckProcessing || 0)} stuck</span></div>
        </div>
        <div class="cfg-section">
          <div class="cfg-section-title"><i class="ri-terminal-box-line"></i>Provider Readiness</div>
          <div class="cfg-row"><span class="cfg-row-label">Claude CLI</span><span class="cfg-row-value">${escapeHtml(claude.status || 'unknown')}</span></div>
          <div class="cfg-row"><span class="cfg-row-label">Claude Auth Signal</span><span class="cfg-row-value">${escapeHtml(claude.authSignal || 'not-detected')}</span></div>
          <div class="cfg-row"><span class="cfg-row-label">Embedding Backend</span><span class="cfg-row-value">${escapeHtml(embeddings.status || 'unknown')}</span></div>
          <div class="cfg-row"><span class="cfg-row-label">Backend</span><span class="cfg-row-value">${escapeHtml(embeddings.backend || '@huggingface/transformers')}</span></div>
        </div>
      </div>
      <div style="margin-top:14px;">
        <div class="section-label">Setup recommendations</div>
        ${recommendationHtml}
      </div>
    </div>
  `;
}

async function loadConfigurationView() {
  const container = document.getElementById('cfg-content');
  container.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-muted);">Loading configuration...</div>';

  try {
    const [statsRes, graduationRes, endlessRes, setupHealthRes] = await Promise.all([
      fetch(apiUrl(`${API_BASE}/stats`)).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/graduation`)).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/endless`)).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/health/setup`)).then(r => r.json()).catch(() => null)
    ]);

    const memory = statsRes?.memory || {};
    const storage = statsRes?.storage || {};
    const criteria = graduationRes?.criteria || {};
    const descriptions = graduationRes?.description || {};
    const endless = endlessRes || {};
    const setupHealth = setupHealthRes || null;

    container.innerHTML = `
      ${renderSetupProviderHealthCard(setupHealth)}
      <div class="cfg-grid">
        <div class="cfg-section">
          <div class="cfg-section-title"><i class="ri-database-2-line"></i>Storage</div>
          <div class="cfg-row">
            <span class="cfg-row-label">Total Events</span>
            <span class="cfg-row-value">${formatNumber(storage.eventCount || 0)}</span>
          </div>
          <div class="cfg-row">
            <span class="cfg-row-label">Vector Nodes</span>
            <span class="cfg-row-value">${formatNumber(storage.vectorCount || 0)}</span>
          </div>
          <div class="cfg-row">
            <span class="cfg-row-label">Heap Used</span>
            <span class="cfg-row-value">${memory.heapUsed || 0} MB</span>
          </div>
          <div class="cfg-row">
            <span class="cfg-row-label">Heap Total</span>
            <span class="cfg-row-value">${memory.heapTotal || 0} MB</span>
          </div>
        </div>

        <div class="cfg-section">
          <div class="cfg-section-title"><i class="ri-infinite-loop-line"></i>Endless Mode</div>
          <div class="cfg-row">
            <span class="cfg-row-label">Mode</span>
            <span class="cfg-row-value">${endless.mode || 'session'}</span>
          </div>
          <div class="cfg-row">
            <span class="cfg-row-label">Continuity Score</span>
            <span class="cfg-row-value">${endless.continuityScore || 0}</span>
          </div>
          <div class="cfg-row">
            <span class="cfg-row-label">Working Set Size</span>
            <span class="cfg-row-value">${endless.workingSetSize || 0}</span>
          </div>
          <div class="cfg-row">
            <span class="cfg-row-label">Consolidated</span>
            <span class="cfg-row-value">${endless.consolidatedCount || 0}</span>
          </div>
          <div class="cfg-row">
            <span class="cfg-row-label">Last Consolidation</span>
            <span class="cfg-row-value">${endless.lastConsolidation ? new Date(endless.lastConsolidation).toLocaleDateString() : 'Never'}</span>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:24px;">
        <div class="card-header">
          <div class="card-title"><i class="ri-graduation-cap-line"></i><span>Graduation Criteria</span></div>
        </div>
        <div style="margin-bottom:16px; font-size:13px; color:var(--text-muted);">
          ${Object.entries(descriptions).map(([key, desc]) => `
            <div style="margin-bottom:4px;"><strong style="color:var(--text-secondary);">${key}</strong>: ${desc}</div>
          `).join('')}
        </div>
        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:16px;">
          ${Object.entries(criteria).map(([key, c]) => `
            <div style="background:var(--bg-panel); border-radius:12px; padding:16px;">
              <div style="font-size:14px; font-weight:600; color:var(--accent-primary); margin-bottom:12px;">${key}</div>
              <div class="cfg-row"><span class="cfg-row-label">Min Access Count</span><span class="cfg-row-value">${c.minAccessCount}</span></div>
              <div class="cfg-row"><span class="cfg-row-label">Min Confidence</span><span class="cfg-row-value">${c.minConfidence}</span></div>
              <div class="cfg-row"><span class="cfg-row-label">Cross-Session Refs</span><span class="cfg-row-value">${c.minCrossSessionRefs}</span></div>
              <div class="cfg-row"><span class="cfg-row-label">Max Age (days)</span><span class="cfg-row-value">${c.maxAgeDays}</span></div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } catch (error) {
    container.innerHTML = `<div style="text-align:center; padding:60px; color:var(--error);">Failed to load configuration: ${escapeHtml(error.message)}</div>`;
  }
}

// --- Helpers ---

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function handleSearch(query) {
  console.log('Searching for:', query);
}

function escapeHtml(unsafe) {
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function jsAttrArg(value) {
  return escapeHtml(JSON.stringify(String(value ?? '')));
}

// --- Chat Panel ---

const CHAT_STORAGE_KEY = 'code-memory-chat-history';

