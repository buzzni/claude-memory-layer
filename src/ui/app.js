/**
 * Code Memory Dashboard Logic
 * Handles state management, API calls, and UI updates.
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

// --- Initialization ---

document.addEventListener('DOMContentLoaded', () => {
  initDashboard();
});

async function initDashboard() {
  await refreshData();
  setupEventListeners();
  await initActivityChart();
}

function setupEventListeners() {
  // Navigation
  document.querySelectorAll('.p-step').forEach(step => {
    step.addEventListener('click', (e) => {
      const level = e.currentTarget.dataset.level;
      if (level) selectLevel(level);
    });
  });

  // Sort
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

  // Refresh
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshData);
  }
}

// --- Data Fetching ---

async function refreshData() {
  const btn = document.getElementById('refresh-btn');
  if(btn) btn.classList.add('loading');

  try {
    const [stats, shared, mostAccessed, helpfulness] = await Promise.all([
      fetch(`${API_BASE}/stats`).then(r => r.json()).catch(() => null),
      fetch(`${API_BASE}/stats/shared`).then(r => r.json()).catch(() => null),
      fetch(`${API_BASE}/stats/most-accessed?limit=10`).then(r => r.json()).catch(() => null),
      fetch(`${API_BASE}/stats/helpfulness?limit=5`).then(r => r.json()).catch(() => null)
    ]);

    state.stats = stats;
    state.sharedStats = shared;
    state.mostAccessed = mostAccessed;
    state.helpfulness = helpfulness;

    updateStatsUI();
    updateSharedUI();
    updateMemoryUsageUI();
    await loadLevelEvents(state.currentLevel);

    // Update Endless Mode Status
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
  updateEventsListUI(); // Show loading state

  try {
    const response = await fetch(`${API_BASE}/events?level=${level}&limit=20&sort=${state.currentSort}`);
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

  // Convert levelStats array to object for pipeline counts
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

  // Update Visuals
  document.querySelectorAll('.p-step').forEach(step => {
    step.classList.toggle('active', step.dataset.level === level);
  });

  loadLevelEvents(level);
}

function selectSort(sort) {
  state.currentSort = sort;

  // Update button visuals
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

  // Fetch real timeline data
  let categories = [];
  let seriesData = [];
  try {
    const res = await fetch(`${API_BASE}/stats/timeline?days=14`);
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
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
