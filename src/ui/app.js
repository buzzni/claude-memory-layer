/**
 * Code Memory Dashboard Logic
 * Handles state management, API calls, UI updates, modals, and navigation.
 */

const API_BASE = '/api';

// State
const state = {
  stats: null,
  sharedStats: null,
  mostAccessed: null,
  helpfulness: null,
  currentLevel: 'L0',
  currentSort: 'recent',
  currentView: 'overview',
  currentProject: '', // empty = global
  projects: [],
  events: [],
  isLoading: false,
  chartInstance: null
};

// Utils
const formatNumber = (num) => new Intl.NumberFormat().format(num || 0);

// Colors for Chart
const CHART_COLORS = {
  L0: '#7B61FF',
  L1: '#00F0FF',
  L2: '#00E396',
  L3: '#FEB019',
  L4: '#FF4560'
};

// --- API URL Helper ---

function apiUrl(path, params = {}) {
  const url = new URL(path, window.location.origin);
  if (state.currentProject) {
    url.searchParams.set('project', state.currentProject);
  }
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

// --- Initialization ---

document.addEventListener('DOMContentLoaded', () => {
  initDashboard();
});

async function initDashboard() {
  await loadProjects();
  await refreshData();
  setupEventListeners();
  await initActivityChart();
}

async function loadProjects() {
  try {
    const res = await fetch(`${API_BASE}/projects`);
    const data = await res.json();
    state.projects = data.projects || [];

    const select = document.getElementById('project-select');
    if (!select) return;

    // Clear existing options except first
    while (select.options.length > 1) select.remove(1);

    // Add project options
    state.projects.forEach(p => {
      const option = document.createElement('option');
      option.value = p.hash;
      option.textContent = `${p.projectName} (${p.dbSizeHuman})`;
      select.appendChild(option);
    });
  } catch (error) {
    console.error('Failed to load projects:', error);
  }
}

function setupEventListeners() {
  // Pipeline steps
  document.querySelectorAll('.p-step').forEach(step => {
    step.addEventListener('click', (e) => {
      const level = e.currentTarget.dataset.level;
      if (level) selectLevel(level);
    });
  });

  // Sort buttons
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sort = e.currentTarget.dataset.sort;
      if (sort) selectSort(sort);
    });
  });

  // Search
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', debounce((e) => handleSearch(e.target.value), 300));
  }

  // Project selector
  const projectSelect = document.getElementById('project-select');
  if (projectSelect) {
    projectSelect.addEventListener('change', async (e) => {
      state.currentProject = e.target.value;
      await refreshData();
      if (state.chartInstance) {
        state.chartInstance.destroy();
        state.chartInstance = null;
      }
      await initActivityChart();
      // Reload current view if not overview
      if (state.currentView !== 'overview') {
        switchView(state.currentView);
      }
    });
  }

  // Refresh
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshData);
  }

  // Stat cards
  document.querySelectorAll('.stat-card[data-stat]').forEach(card => {
    card.addEventListener('click', () => {
      handleStatClick(card.dataset.stat);
    });
  });

  // Sidebar navigation
  document.querySelectorAll('.nav-item[data-nav]').forEach(item => {
    item.addEventListener('click', () => {
      switchView(item.dataset.nav);
    });
  });

  // Modal close buttons
  document.querySelectorAll('.modal-close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.dataset.modal;
      closeModal(modalId);
    });
  });

  // Modal overlay click to close
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeModal(overlay.id);
      }
    });
  });

  // ESC key to close modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllModals();
    }
  });
}

// --- Data Fetching ---

async function refreshData() {
  const btn = document.getElementById('refresh-btn');
  if(btn) btn.classList.add('loading');

  try {
    const [stats, shared, mostAccessed, helpfulness] = await Promise.all([
      fetch(apiUrl(`${API_BASE}/stats`)).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/shared`)).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/most-accessed`, { limit: 10 })).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/helpfulness`, { limit: 5 })).then(r => r.json()).catch(() => null)
    ]);

    state.stats = stats;
    state.sharedStats = shared;
    state.mostAccessed = mostAccessed;
    state.helpfulness = helpfulness;

    updateStatsUI();
    updateSharedUI();
    updateMemoryUsageUI();
    await loadLevelEvents(state.currentLevel);

    checkEndlessStatus();

  } catch (error) {
    console.error('Failed to refresh data:', error);
  } finally {
    if(btn) btn.classList.remove('loading');
  }
}

async function loadLevelEvents(level, sort) {
  if (sort) state.currentSort = sort;
  state.isLoading = true;
  updateEventsListUI();

  try {
    const response = await fetch(apiUrl(`${API_BASE}/events`, { level, limit: 20, sort: state.currentSort }));
    if (response.ok) {
      const data = await response.json();
      state.events = data.events || [];
    } else {
      state.events = [];
    }
  } catch (error) {
    console.error(`Failed to load events for ${level}:`, error);
    state.events = [];
  } finally {
    state.isLoading = false;
    updateEventsListUI();
  }
}

// --- UI Updates ---

function updateStatsUI() {
  if (!state.stats) return;

  const eventCount = state.stats.storage?.eventCount || 0;
  const sessionCount = state.stats.sessions?.total || 0;
  const vectorCount = state.stats.storage?.vectorCount || 0;

  document.getElementById('stat-events').textContent = formatNumber(eventCount);
  document.getElementById('stat-sessions').textContent = formatNumber(sessionCount);

  const sharedCount = state.sharedStats ?
    ((state.sharedStats.troubleshooting || 0) + (state.sharedStats.bestPractices || 0) + (state.sharedStats.commonErrors || 0)) : 0;

  document.getElementById('stat-shared').textContent = formatNumber(sharedCount);
  document.getElementById('stat-vectors').textContent = formatNumber(vectorCount);

  const levelCounts = {};
  if (state.stats.levelStats) {
    state.stats.levelStats.forEach(item => { levelCounts[item.level] = item.count; });
  }
  updatePipelineCounts(levelCounts);
}

function updatePipelineCounts(counts) {
  document.querySelectorAll('.p-step').forEach(step => {
    const level = step.dataset.level;
    const countEl = step.querySelector('.p-step-count');
    countEl.textContent = formatNumber(counts[level] || 0);
  });
}

function updateSharedUI() {
  if (!state.sharedStats) return;

  document.getElementById('shared-troubleshooting').textContent = formatNumber(state.sharedStats.troubleshooting || 0);
  document.getElementById('shared-best-practices').textContent = formatNumber(state.sharedStats.bestPractices || 0);
  document.getElementById('shared-errors').textContent = formatNumber(state.sharedStats.commonErrors || 0);
}

function selectLevel(level) {
  state.currentLevel = level;

  document.querySelectorAll('.p-step').forEach(step => {
    step.classList.toggle('active', step.dataset.level === level);
  });

  loadLevelEvents(level);
}

function selectSort(sort) {
  state.currentSort = sort;

  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sort === sort);
  });

  loadLevelEvents(state.currentLevel, sort);
}

function updateEventsListUI() {
  const container = document.getElementById('event-list-container');
  container.innerHTML = '';

  if (state.isLoading) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">Loading events...</div>';
    return;
  }

  if (state.events.length === 0) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">No events found for this level.</div>';
    return;
  }

  state.events.forEach(event => {
    const el = document.createElement('div');
    el.className = 'event-item';
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => openDetailModal(event.id));

    const time = new Date(event.timestamp).toLocaleString();
    const eventType = event.eventType || event.type || 'unknown';
    const typeClass = `type-${eventType.toLowerCase().replace('_', '-')}`;
    const preview = event.preview || event.content || '';
    const accessBadge = event.accessCount > 0
      ? `<span class="access-badge"><i class="ri-eye-line"></i> ${event.accessCount}</span>`
      : '';
    const lastUsed = (state.currentSort === 'accessed' || state.currentSort === 'most-accessed') && event.lastAccessedAt
      ? `<span class="event-time" style="color:var(--accent-secondary);">used ${new Date(event.lastAccessedAt).toLocaleString()}</span>`
      : '';

    el.innerHTML = `
      <div class="event-header">
        <span class="event-type-badge ${typeClass}">${eventType}</span>
        <div style="display:flex; gap:8px; align-items:center;">
          ${accessBadge}
          ${lastUsed}
          <span class="event-time">${time}</span>
        </div>
      </div>
      <div class="event-content">${escapeHtml(preview)}</div>
    `;

    container.appendChild(el);
  });
}

// --- Memory Usage ---

function updateMemoryUsageUI() {
  updateGraduationBars();
  updateHelpfulnessUI();
  updateMostHelpfulList();
}

function updateGraduationBars() {
  const container = document.getElementById('graduation-bars');
  if (!container || !state.stats?.levelStats) return;

  const levels = ['L0', 'L1', 'L2', 'L3', 'L4'];
  const colors = [CHART_COLORS.L0, CHART_COLORS.L1, CHART_COLORS.L2, CHART_COLORS.L3, CHART_COLORS.L4];

  const counts = {};
  state.stats.levelStats.forEach(s => { counts[s.level] = s.count; });
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;

  container.innerHTML = levels.map((level, i) => {
    const count = counts[level] || 0;
    const pct = ((count / total) * 100).toFixed(1);
    return `
      <div class="grad-bar-row">
        <span class="grad-bar-label" style="color:${colors[i]}">${level}</span>
        <div class="grad-bar-track">
          <div class="grad-bar-fill" style="width:${pct}%; background:${colors[i]};"></div>
        </div>
        <span class="grad-bar-value">${count} (${pct}%)</span>
      </div>
    `;
  }).join('');
}

function updateHelpfulnessUI() {
  const container = document.getElementById('helpfulness-summary');
  if (!container) return;

  const h = state.helpfulness;
  if (!h || h.totalEvaluated === 0) {
    container.innerHTML = '<span style="color:var(--text-muted);">No evaluations yet. Helpfulness is measured automatically at session end.</span>';
    return;
  }

  const scoreColor = h.avgScore >= 0.7 ? 'var(--success, #00E396)' : h.avgScore >= 0.4 ? 'var(--warning, #FEB019)' : 'var(--danger, #FF4560)';

  container.innerHTML = `
    <div style="display:flex; gap:16px; align-items:center; flex-wrap:wrap;">
      <div style="display:flex; align-items:baseline; gap:4px;">
        <span style="font-size:20px; font-weight:700; color:${scoreColor};">${h.avgScore}</span>
        <span style="font-size:11px; color:var(--text-muted);">avg</span>
      </div>
      <div style="display:flex; gap:10px; font-size:12px;">
        <span style="color:var(--success, #00E396);">${h.helpful} helpful</span>
        <span style="color:var(--warning, #FEB019);">${h.neutral} neutral</span>
        <span style="color:var(--danger, #FF4560);">${h.unhelpful} unhelpful</span>
      </div>
      <span style="font-size:11px; color:var(--text-muted);">${h.totalEvaluated} evaluated / ${h.totalRetrievals} retrieved</span>
    </div>
  `;
}

function updateMostHelpfulList() {
  const container = document.getElementById('most-helpful-list');
  if (!container) return;

  const memories = state.helpfulness?.topMemories || [];

  if (memories.length === 0) {
    container.innerHTML = '<div style="padding:12px; text-align:center; color:var(--text-muted); font-size:13px;">No helpful memories yet</div>';
    return;
  }

  container.innerHTML = memories.slice(0, 5).map((m, i) => {
    const scoreColor = m.helpfulnessScore >= 0.7 ? 'var(--success, #00E396)' : m.helpfulnessScore >= 0.4 ? 'var(--warning, #FEB019)' : 'var(--danger, #FF4560)';
    return `
      <div class="shared-item">
        <div class="shared-info">
          <div class="shared-icon" style="font-size:14px; font-weight:700; color:var(--accent-primary);">#${i + 1}</div>
          <span style="font-size:13px; color:var(--text-secondary); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">
            ${escapeHtml(m.summary || '(no summary)')}
          </span>
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px;">
          <span style="font-size:14px; font-weight:600; color:${scoreColor};">${m.helpfulnessScore}</span>
          <span style="font-size:10px; color:var(--text-muted);">${m.accessCount}x accessed</span>
        </div>
      </div>
    `;
  }).join('');
}

// --- Charts ---

async function initActivityChart() {
  const chartEl = document.querySelector("#activity-chart");
  if (!chartEl) return;

  let categories = [];
  let seriesData = [];
  try {
    const res = await fetch(apiUrl(`${API_BASE}/stats/timeline`, { days: 14 }));
    const data = await res.json();
    if (data.daily && data.daily.length > 0) {
      categories = data.daily.map(d => d.date);
      seriesData = data.daily.map(d => d.total);
    }
  } catch (e) {
    console.error('Failed to load timeline:', e);
  }

  if (seriesData.length === 0) {
    categories = ['No data'];
    seriesData = [0];
  }

  const options = {
    series: [{
      name: 'Events',
      data: seriesData
    }],
    chart: {
      type: 'area',
      height: 300,
      background: 'transparent',
      toolbar: { show: false },
      fontFamily: 'Outfit, sans-serif'
    },
    theme: { mode: 'dark' },
    stroke: {
      curve: 'smooth',
      width: 3,
      colors: [CHART_COLORS.L0]
    },
    fill: {
      type: 'gradient',
      gradient: {
        shadeIntensity: 1,
        opacityFrom: 0.7,
        opacityTo: 0.1,
        stops: [0, 90, 100]
      }
    },
    dataLabels: { enabled: false },
    grid: {
      borderColor: 'rgba(255,255,255,0.05)',
      strokeDashArray: 4,
    },
    xaxis: {
      categories: categories,
      labels: {
        style: { colors: '#8B9BB4' },
        rotate: -45,
        rotateAlways: categories.length > 7
      },
      axisBorder: { show: false },
      axisTicks: { show: false }
    },
    yaxis: {
      labels: { style: { colors: '#8B9BB4' } }
    },
    colors: [CHART_COLORS.L0]
  };

  state.chartInstance = new ApexCharts(chartEl, options);
  state.chartInstance.render();
}

// --- Endless Mode ---

async function checkEndlessStatus() {
  const statusEl = document.getElementById('status-dot');
  const textEl = document.getElementById('status-text');

  const isRunning = false;

  if (statusEl && textEl) {
    if (isRunning) {
      statusEl.classList.add('active');
      textEl.textContent = 'Active Background Processing';
      textEl.style.color = 'var(--success)';
    } else {
      statusEl.classList.remove('active');
      textEl.textContent = 'Idle';
      textEl.style.color = 'var(--text-muted)';
    }
  }
}

// =============================================
// Modal System
// =============================================

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
    const typeClass = `type-${eventType.toLowerCase().replace('_', '-')}`;
    const time = new Date(evt.timestamp).toLocaleString();

    let contextHtml = '';
    if (ctx.length > 0) {
      contextHtml = `
        <div class="modal-section-title">Context (Surrounding Events)</div>
        <div class="modal-context-list">
          ${ctx.map(c => `
            <div class="modal-context-item" onclick="openDetailModal('${c.id}')">
              <span class="event-type-badge ${`type-${(c.eventType || '').toLowerCase().replace('_', '-')}`}" style="flex-shrink:0;">${c.eventType}</span>
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
          <span class="event-type-badge ${typeClass}">${eventType}</span>
        </div>
        <div class="modal-meta-item">
          <i class="ri-time-line"></i>
          ${time}
        </div>
        <div class="modal-meta-item">
          <i class="ri-chat-1-line"></i>
          Session: ${evt.sessionId ? evt.sessionId.slice(0, 12) + '...' : 'N/A'}
        </div>
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
      const typeClass = `type-${(e.eventType || '').toLowerCase().replace('_', '-')}`;
      return `
        <div class="modal-list-item" onclick="openDetailModal('${e.id}')">
          <div class="modal-list-info">
            <div class="title">
              <span class="event-type-badge ${typeClass}" style="margin-right:8px;">${e.eventType}</span>
              ${escapeHtml((e.preview || '').slice(0, 80))}
            </div>
            <div class="subtitle">${new Date(e.timestamp).toLocaleString()} | Session: ${(e.sessionId || '').slice(0, 12)}...</div>
          </div>
          ${e.accessCount > 0 ? `<div class="modal-list-badge"><i class="ri-eye-line"></i> ${e.accessCount}</div>` : ''}
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
        <div class="modal-list-item" onclick="showSessionDetailInModal('${s.id}')">
          <div class="modal-list-info">
            <div class="title"><i class="ri-chat-1-line" style="color:var(--accent-primary); margin-right:6px;"></i>${s.id.slice(0, 20)}...</div>
            <div class="subtitle">Started: ${started} | Last: ${lastEvent}</div>
          </div>
          <div class="modal-list-badge">${s.eventCount} events</div>
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
    const res = await fetch(apiUrl(`${API_BASE}/sessions/${sessionId}`));
    const data = await res.json();
    const session = data.session;
    const events = data.events || [];
    const stats = data.stats || {};

    body.innerHTML = `
      <div class="modal-meta">
        <div class="modal-meta-item"><i class="ri-fingerprint-line"></i>${sessionId.slice(0, 20)}...</div>
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
        const typeClass = `type-${(e.eventType || '').toLowerCase().replace('_', '-')}`;
        return `
          <div class="modal-list-item" onclick="closeAllModals(); openDetailModal('${e.id}')">
            <div class="modal-list-info">
              <div class="title">
                <span class="event-type-badge ${typeClass}" style="margin-right:8px;">${e.eventType}</span>
                ${escapeHtml((e.preview || '').slice(0, 80))}
              </div>
              <div class="subtitle">${new Date(e.timestamp).toLocaleString()}</div>
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
