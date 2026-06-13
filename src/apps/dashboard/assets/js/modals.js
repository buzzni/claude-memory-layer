function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.style.display = 'none';
    document.body.style.overflow = '';
  }
}

function closeAllModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => {
    m.style.display = 'none';
  });
  document.body.style.overflow = '';
}

// --- Detail Modal ---

async function openDetailModal(eventId) {
  const body = document.getElementById('detail-modal-body');
  body.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);"><i class="ri-loader-4-line" style="font-size:24px; animation: spin 1s linear infinite;"></i><br>Loading event details...</div>';
  openModal('detail-modal');

  try {
    const res = await fetch(apiUrl(`${API_BASE}/events/${eventId}`));
    if (!res.ok) throw new Error('Event not found');
    const data = await res.json();
    const evt = data.event;
    const ctx = data.context || [];

    const eventType = evt.eventType || 'unknown';
    const typeClass = eventTypeBadgeClass(eventType);
    const time = new Date(evt.timestamp).toLocaleString();
    const adherenceBadge = renderAdherenceBadge(evt);

    let contextHtml = '';
    if (ctx.length > 0) {
      contextHtml = `
        <div class="modal-section-title">Context (Surrounding Events)</div>
        <div class="modal-context-list">
          ${ctx.map(c => `
            <div class="modal-context-item" ${c.id ? `onclick="openDetailModal(${jsAttrArg(c.id)})"` : ''}>
              <span class="event-type-badge ${eventTypeBadgeClass(c.eventType)}" style="flex-shrink:0;">${escapeHtml(c.eventType || 'event')}</span>
              <div style="flex:1; min-width:0;">
                <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">${new Date(c.timestamp).toLocaleString()}</div>
                <div style="font-size:13px; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(c.preview || '')}</div>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }

    body.innerHTML = `
      <div class="modal-meta">
        <div class="modal-meta-item">
          <i class="ri-price-tag-3-line"></i>
          <span class="event-type-badge ${typeClass}">${escapeHtml(eventType)}</span>
        </div>
        ${adherenceBadge ? `<div class="modal-meta-item">${adherenceBadge}</div>` : ''}
        <div class="modal-meta-item">
          <i class="ri-time-line"></i>
          ${time}
        </div>
        <div class="modal-meta-item">
          <i class="ri-chat-1-line"></i>
          Session: ${evt.sessionId ? escapeHtml(evt.sessionId.slice(0, 12)) + '...' : 'N/A'}
        </div>
        ${evt.sessionId ? `
          <button type="button" class="inline-action-btn" onclick="jumpToSession(${jsAttrArg(evt.sessionId)}, ${jsAttrArg(evt.id || eventId)})">
            <i class="ri-corner-right-up-line"></i> Open in Sessions
          </button>
        ` : ''}
      </div>
      <div class="modal-section-title">Content</div>
      <div class="modal-content-block">${escapeHtml(evt.content || '(empty)')}</div>
      ${contextHtml}
    `;
  } catch (error) {
    body.innerHTML = `<div style="text-align:center; padding:40px; color:var(--error);">Failed to load event: ${escapeHtml(error.message)}</div>`;
  }
}

// --- Stat Card Click Handlers ---

function handleStatClick(statType) {
  switch (statType) {
    case 'events': showEventsListModal(); break;
    case 'sessions': showSessionsModal(); break;
    case 'shared': showSharedModal(); break;
    case 'vectors': showVectorsModal(); break;
  }
}

async function showEventsListModal() {
  document.getElementById('list-modal-title').textContent = 'Total Events';
  const body = document.getElementById('list-modal-body');
  body.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);">Loading events...</div>';
  openModal('list-modal');

  try {
    const res = await fetch(apiUrl(`${API_BASE}/events`, { limit: 50 }));
    const data = await res.json();
    const events = data.events || [];

    if (events.length === 0) {
      body.innerHTML = '<div class="modal-list-empty">No events found</div>';
      return;
    }

    body.innerHTML = events.map(e => {
      const typeClass = eventTypeBadgeClass(e.eventType);
      const adherenceBadge = renderAdherenceBadge(e);
      const eventArg = jsAttrArg(e.id || '');
      const sessionArg = jsAttrArg(e.sessionId || '');
      return `
        <div class="modal-list-item" ${e.id ? `onclick="openDetailModal(${eventArg})"` : ''}>
          <div class="modal-list-info">
            <div class="title">
              <span class="event-type-badge ${typeClass}" style="margin-right:8px;">${escapeHtml(e.eventType || 'event')}</span>
              ${adherenceBadge}
              ${escapeHtml((e.preview || '').slice(0, 80))}
            </div>
            <div class="subtitle">${new Date(e.timestamp).toLocaleString()} | Session: ${escapeHtml((e.sessionId || '').slice(0, 12))}...</div>
            ${e.sessionId ? `
              <div class="event-actions">
                <button type="button" class="inline-action-btn" onclick="event.stopPropagation(); jumpToSession(${sessionArg}, ${eventArg})">
                  <i class="ri-corner-right-up-line"></i> Open in Sessions
                </button>
              </div>
            ` : ''}
          </div>
          ${e.accessCount > 0 ? `<div class="modal-list-badge"><i class="ri-eye-line"></i> ${formatNumber(e.accessCount)}</div>` : ''}
        </div>
      `;
    }).join('');
  } catch (error) {
    body.innerHTML = `<div class="modal-list-empty">Failed to load events</div>`;
  }
}

async function showSessionsModal() {
  document.getElementById('list-modal-title').textContent = 'Active Sessions';
  const body = document.getElementById('list-modal-body');
  body.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);">Loading sessions...</div>';
  openModal('list-modal');

  try {
    const res = await fetch(apiUrl(`${API_BASE}/sessions`, { pageSize: 50 }));
    const data = await res.json();
    const sessions = data.sessions || [];

    if (sessions.length === 0) {
      body.innerHTML = '<div class="modal-list-empty">No sessions found</div>';
      return;
    }

    body.innerHTML = sessions.map(s => {
      const started = new Date(s.startedAt).toLocaleString();
      const lastEvent = new Date(s.lastEventAt).toLocaleString();
      return `
        <div class="modal-list-item" onclick="showSessionDetailInModal(${jsAttrArg(s.id)})">
          <div class="modal-list-info">
            <div class="title"><i class="ri-chat-1-line" style="color:var(--accent-primary); margin-right:6px;"></i>${escapeHtml(s.id.slice(0, 20))}...</div>
            <div class="subtitle">Started: ${started} | Last: ${lastEvent}</div>
          </div>
          <div class="modal-list-badge">${formatNumber(s.eventCount)} events</div>
        </div>
      `;
    }).join('');
  } catch (error) {
    body.innerHTML = `<div class="modal-list-empty">Failed to load sessions</div>`;
  }
}

async function showSessionDetailInModal(sessionId) {
  document.getElementById('list-modal-title').textContent = 'Session Detail';
  const body = document.getElementById('list-modal-body');
  body.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted);">Loading session...</div>';

  try {
    const res = await fetch(apiUrl(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}`));
    const data = await res.json();
    const session = data.session;
    const events = data.events || [];
    const stats = data.stats || {};

    body.innerHTML = `
      <div class="modal-meta">
        <div class="modal-meta-item"><i class="ri-fingerprint-line"></i>${escapeHtml(sessionId.slice(0, 20))}...</div>
        <div class="modal-meta-item"><i class="ri-time-line"></i>${new Date(session.startedAt).toLocaleString()}</div>
        <div class="modal-meta-item"><i class="ri-file-list-3-line"></i>${session.eventCount} events</div>
      </div>
      <div style="display:flex; gap:12px; margin-bottom:20px; flex-wrap:wrap;">
        <div style="padding:10px 16px; background:rgba(59,130,246,0.1); border-radius:8px; font-size:13px;">
          <span style="color:#60A5FA; font-weight:600;">${stats.user_prompt || 0}</span> <span style="color:var(--text-muted);">prompts</span>
        </div>
        <div style="padding:10px 16px; background:rgba(16,185,129,0.1); border-radius:8px; font-size:13px;">
          <span style="color:#34D399; font-weight:600;">${stats.agent_response || 0}</span> <span style="color:var(--text-muted);">responses</span>
        </div>
        <div style="padding:10px 16px; background:rgba(245,158,11,0.1); border-radius:8px; font-size:13px;">
          <span style="color:#FBBF24; font-weight:600;">${stats.tool_observation || 0}</span> <span style="color:var(--text-muted);">tools</span>
        </div>
      </div>
      <div class="modal-section-title">Events</div>
      ${events.map(e => {
        const typeClass = eventTypeBadgeClass(e.eventType);
        const adherenceBadge = renderAdherenceBadge(e);
        const eventArg = jsAttrArg(e.id || '');
        const sessionArg = jsAttrArg(e.sessionId || sessionId);
        return `
          <div class="modal-list-item" ${e.id ? `onclick="closeAllModals(); openDetailModal(${eventArg})"` : ''}>
            <div class="modal-list-info">
              <div class="title">
                <span class="event-type-badge ${typeClass}" style="margin-right:8px;">${escapeHtml(e.eventType || 'event')}</span>
                ${adherenceBadge}
                ${escapeHtml((e.preview || '').slice(0, 80))}
              </div>
              <div class="subtitle">${new Date(e.timestamp).toLocaleString()}</div>
              <div class="event-actions">
                <button type="button" class="inline-action-btn" onclick="event.stopPropagation(); jumpToSession(${sessionArg}, ${eventArg})">
                  <i class="ri-corner-right-up-line"></i> Open in Sessions
                </button>
              </div>
            </div>
          </div>
        `;
      }).join('')}
    `;
  } catch (error) {
    body.innerHTML = `<div class="modal-list-empty">Failed to load session</div>`;
  }
}

function showSharedModal() {
  document.getElementById('list-modal-title').textContent = 'Shared Items';
  const body = document.getElementById('list-modal-body');
  const s = state.sharedStats || {};

  const items = [
    { icon: '🔧', label: 'Troubleshooting', count: s.troubleshooting || 0, color: '#60A5FA' },
    { icon: '✨', label: 'Best Practices', count: s.bestPractices || 0, color: '#34D399' },
    { icon: '⚠️', label: 'Common Errors', count: s.commonErrors || 0, color: '#FBBF24' }
  ];

  const total = items.reduce((a, b) => a + b.count, 0);
  const lastUpdated = s.lastUpdated ? new Date(s.lastUpdated).toLocaleString() : 'N/A';

  body.innerHTML = `
    <div style="text-align:center; margin-bottom:24px;">
      <div style="font-size:48px; font-weight:700; background:linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">${formatNumber(total)}</div>
      <div style="font-size:13px; color:var(--text-muted); margin-top:4px;">Total shared items</div>
    </div>
    ${items.map(item => `
      <div class="modal-list-item" style="cursor:default;">
        <div class="modal-list-info">
          <div class="title">${item.icon} ${item.label}</div>
          <div class="subtitle">Cross-project knowledge items</div>
        </div>
        <div class="modal-list-badge" style="background:${item.color}22; color:${item.color};">${formatNumber(item.count)}</div>
      </div>
    `).join('')}
    <div style="text-align:center; margin-top:20px; font-size:12px; color:var(--text-muted);">
      Total usage: ${formatNumber(s.totalUsageCount || 0)} | Last updated: ${lastUpdated}
    </div>
  `;

  openModal('list-modal');
}

function showVectorsModal() {
  document.getElementById('list-modal-title').textContent = 'Vector Nodes';
  const body = document.getElementById('list-modal-body');
  const stats = state.stats || {};
  const vectorCount = stats.storage?.vectorCount || 0;
  const memory = stats.memory || {};

  body.innerHTML = `
    <div style="text-align:center; margin-bottom:24px;">
      <div style="font-size:48px; font-weight:700; background:linear-gradient(135deg, var(--accent-primary), var(--accent-secondary)); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">${formatNumber(vectorCount)}</div>
      <div style="font-size:13px; color:var(--text-muted); margin-top:4px;">Total vector nodes</div>
    </div>
    <div class="modal-list-item" style="cursor:default;">
      <div class="modal-list-info">
        <div class="title"><i class="ri-node-tree" style="color:var(--accent-primary); margin-right:6px;"></i>Embedded Vectors</div>
        <div class="subtitle">Semantic search index entries</div>
      </div>
      <div class="modal-list-badge">${formatNumber(vectorCount)}</div>
    </div>
    <div class="modal-list-item" style="cursor:default;">
      <div class="modal-list-info">
        <div class="title"><i class="ri-cpu-line" style="color:var(--accent-secondary); margin-right:6px;"></i>Heap Used</div>
        <div class="subtitle">Current memory usage</div>
      </div>
      <div class="modal-list-badge" style="background:rgba(0,240,255,0.1); color:var(--accent-secondary);">${memory.heapUsed || 0} MB</div>
    </div>
    <div class="modal-list-item" style="cursor:default;">
      <div class="modal-list-info">
        <div class="title"><i class="ri-hard-drive-2-line" style="color:var(--warning); margin-right:6px;"></i>Heap Total</div>
        <div class="subtitle">Allocated memory</div>
      </div>
      <div class="modal-list-badge" style="background:rgba(254,176,25,0.1); color:var(--warning);">${memory.heapTotal || 0} MB</div>
    </div>
  `;

  openModal('list-modal');
}

// =============================================
// Sidebar Navigation
// =============================================

