function switchView(viewName) {
  if (state.currentView === viewName) return;
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
    case 'knowledge-graph': loadKnowledgeGraphView(); break;
    case 'memory-banks': loadMemoryBanksView(); break;
    case 'user-prompts': loadUserPromptsView(); break;
    case 'configuration': loadConfigurationView(); break;
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
          const typeClass = `type-${(e.eventType || '').toLowerCase().replace('_', '-')}`;
          return `
            <div class="mb-event-card" onclick="openDetailModal('${e.id}')">
              <div class="mb-event-header">
                <span class="event-type-badge ${typeClass}">${e.eventType}</span>
                <div style="display:flex; gap:8px; align-items:center;">
                  ${e.accessCount > 0 ? `<span class="access-badge"><i class="ri-eye-line"></i> ${e.accessCount}</span>` : ''}
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

    const cards = sessionItems.map((e) => `
      <div class="event-item" style="cursor:pointer;" onclick="openDetailModal('${e.id}')">
        <div class="event-header">
          <span class="event-type-badge type-user-prompt">user_prompt</span>
          <span class="event-time">${new Date(e.timestamp).toLocaleString()}</span>
        </div>
        <div class="event-content" style="-webkit-line-clamp:4;">${escapeHtml(e.preview || '')}</div>
      </div>
    `).join('');

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

// --- Configuration View ---

async function loadConfigurationView() {
  const container = document.getElementById('cfg-content');
  container.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-muted);">Loading configuration...</div>';

  try {
    const [statsRes, graduationRes, endlessRes] = await Promise.all([
      fetch(apiUrl(`${API_BASE}/stats`)).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/graduation`)).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/endless`)).then(r => r.json()).catch(() => null)
    ]);

    const memory = statsRes?.memory || {};
    const storage = statsRes?.storage || {};
    const criteria = graduationRes?.criteria || {};
    const descriptions = graduationRes?.description || {};
    const endless = endlessRes || {};

    container.innerHTML = `
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

// --- Chat Panel ---

const CHAT_STORAGE_KEY = 'code-memory-chat-history';

