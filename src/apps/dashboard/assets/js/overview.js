async function loadKpiData() {
  state.kpi = await fetch(apiUrl(`${API_BASE}/stats/kpi`, { window: state.kpiWindow }))
    .then(r => r.json())
    .catch(() => null);
}

async function loadMemoryUsefulnessData() {
  state.memoryUsefulness = await fetch(apiUrl(`${API_BASE}/stats/usefulness`, { window: state.kpiWindow }))
    .then(r => r.json())
    .catch(() => null);
}

async function refreshData() {
  const btn = document.getElementById('refresh-btn');
  if(btn) btn.classList.add('loading');
  const refreshRequestId = (state.refreshRequestId || 0) + 1;
  state.refreshRequestId = refreshRequestId;
  const projectAtStart = state.currentProject;
  const kpiWindowAtStart = state.kpiWindow;

  try {
    const [stats, shared, mostAccessed, helpfulness, memoryUsefulness, retrievalTraces, adherenceSummary] = await Promise.all([
      fetch(apiUrl(`${API_BASE}/stats`)).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/shared`)).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/most-accessed`, { limit: 10 })).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/helpfulness`, { limit: 5 })).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/usefulness`, { window: state.kpiWindow })).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/retrieval-traces`, { limit: 20 })).then(r => r.json()).catch(() => null),
      fetchAdherenceSummary().catch(() => null)
    ]);

    if (
      refreshRequestId !== state.refreshRequestId ||
      projectAtStart !== state.currentProject ||
      kpiWindowAtStart !== state.kpiWindow
    ) {
      return;
    }

    state.stats = stats;
    state.sharedStats = shared;
    state.mostAccessed = mostAccessed;
    state.helpfulness = helpfulness;
    state.memoryUsefulness = memoryUsefulness;
    state.retrievalTraces = retrievalTraces;
    state.adherenceSummary = adherenceSummary;

    await loadKpiData();
    if (refreshRequestId !== state.refreshRequestId) return;

    updateStatsUI();
    updateSharedUI();
    updateMemoryUsageUI();
    updateKpiCardsUI();
    renderKpiTrendChart();
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

  document.getElementById('stat-vectors').textContent = formatNumber(vectorCount);

  // Retrieval quality stat card
  const rtStats = state.retrievalTraces?.stats;
  const totalQueries = rtStats?.totalQueries || 0;
  const selRate = rtStats ? ((rtStats.selectionRate || 0) * 100).toFixed(0) : null;
  document.getElementById('stat-retrieval-queries').textContent = formatNumber(totalQueries);
  const rateEl = document.getElementById('stat-retrieval-rate');
  if (rateEl) {
    rateEl.textContent = totalQueries > 0 && selRate !== null
      ? `${selRate}% selection rate`
      : totalQueries > 0 ? '' : 'no queries yet';
  }

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

function percentText(v) {
  return `${((v || 0) * 100).toFixed(1)}%`;
}

function renderDelta(id, value, lowerIsBetter = false, asPercent = true) {
  const el = document.getElementById(id);
  if (!el) return;
  const v = Number(value || 0);
  const sign = v > 0 ? '+' : '';
  const text = asPercent ? `${sign}${(v * 100).toFixed(1)}%` : `${sign}${v.toFixed(2)}`;

  let positive = v > 0;
  if (lowerIsBetter) positive = v < 0;
  const cls = v === 0 ? 'neutral' : (positive ? 'good' : 'bad');
  const arrow = v === 0 ? '→' : (positive ? '▲' : '▼');

  el.className = `kpi-delta ${cls}`;
  el.textContent = `${arrow} ${text} vs prev`;
}

function updateKpiCardsUI() {
  const m = state.kpi?.metrics;
  const d = state.kpi?.deltas;
  if (!m) return;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  set('kpi-useful-recall', percentText(m.usefulRecallRate));
  set('kpi-completion-turns', Number(m.avgCompletionTurns || 0).toFixed(2));
  set('kpi-rework-rate', percentText(m.reworkRate));
  set('kpi-failure-rate', percentText(m.postChangeFailureRate));

  if (d) {
    renderDelta('kpi-useful-recall-delta', d.usefulRecallRate, false, true);
    renderDelta('kpi-completion-turns-delta', d.avgCompletionTurns, true, false);
    renderDelta('kpi-rework-rate-delta', d.reworkRate, true, true);
    renderDelta('kpi-failure-rate-delta', d.postChangeFailureRate, true, true);
  }

  const alertsEl = document.getElementById('kpi-alerts');
  if (alertsEl) {
    const alerts = state.kpi?.alerts || [];
    if (alerts.length === 0) {
      alertsEl.innerHTML = '<span style="color:var(--success);">No KPI alerts in current window.</span>';
    } else {
      alertsEl.innerHTML = alerts.slice(0, 3).map(a => `⚠️ ${escapeHtml(a.message)} (${a.metric})`).join(' · ');
    }
  }
}

function renderKpiTrendChart() {
  const chartEl = document.querySelector('#kpi-trend-chart');
  if (!chartEl) return;

  const daily = state.kpi?.trend?.daily || [];
  const categories = daily.map(d => d.date);
  const useful = daily.map(d => Number(d.usefulRecallRate || 0) * 100);
  const rework = daily.map(d => Number(d.reworkRate || 0) * 100);
  const fail = daily.map(d => Number(d.postChangeFailureRate || 0) * 100);

  if (state.kpiChartInstance) {
    state.kpiChartInstance.destroy();
    state.kpiChartInstance = null;
  }

  const options = {
    series: [
      { name: 'Useful Recall %', data: useful },
      { name: 'Rework %', data: rework },
      { name: 'Failure %', data: fail }
    ],
    chart: {
      type: 'line',
      height: 240,
      background: 'transparent',
      toolbar: { show: false },
      fontFamily: 'Outfit, sans-serif'
    },
    stroke: { curve: 'smooth', width: 2 },
    dataLabels: { enabled: false },
    xaxis: { categories, labels: { style: { colors: '#8B9BB4' } } },
    yaxis: { labels: { formatter: (v) => `${v.toFixed(0)}%`, style: { colors: '#8B9BB4' } } },
    theme: { mode: 'dark' },
    grid: { borderColor: 'rgba(255,255,255,0.05)', strokeDashArray: 4 },
    colors: ['#34D399', '#FEB019', '#FF4560']
  };

  state.kpiChartInstance = new ApexCharts(chartEl, options);
  state.kpiChartInstance.render();
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

function getAdherenceInfo(event) {
  const adherence = event?.metadata?.adherence || event?.meta?.adherence || null;
  if (!adherence || typeof adherence !== 'object') return null;
  const reason = adherence.reason || 'unknown';
  const checked = Boolean(adherence.checked);
  const turn = adherence.turn;
  return { reason, checked, turn };
}

function renderAdherenceBadge(event) {
  const info = getAdherenceInfo(event);
  if (!info) return '';
  const modeClass = info.checked ? 'adherence-checked' : 'adherence-skipped';
  const turnText = Number.isFinite(info.turn) ? ` · T${info.turn}` : '';
  return `<span class="adherence-badge ${modeClass}" title="adherence ${info.checked ? 'checked' : 'skipped'}${turnText}">adh:${escapeHtml(info.reason)}</span>`;
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
    const adherenceBadge = renderAdherenceBadge(event);
    const lastUsed = (state.currentSort === 'accessed' || state.currentSort === 'most-accessed') && event.lastAccessedAt
      ? `<span class="event-time" style="color:var(--accent-secondary);">used ${new Date(event.lastAccessedAt).toLocaleString()}</span>`
      : '';

    el.innerHTML = `
      <div class="event-header">
        <div style="display:flex; gap:8px; align-items:center;">
          <span class="event-type-badge ${typeClass}">${eventType}</span>
          ${adherenceBadge}
        </div>
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

function updateTopAccessedEventsUI() {
  const container = document.getElementById('top-accessed-events-list');
  if (!container) return;

  const events = (state.mostAccessed?.events || state.mostAccessed?.memories || []);
  const filtered = events.filter(e => (e.accessCount || 0) > 0).slice(0, 5);

  if (filtered.length === 0) {
    container.innerHTML = '<div style="padding:12px; text-align:center; color:var(--text-muted); font-size:13px;">No accessed memories yet</div>';
    return;
  }

  container.innerHTML = filtered.map((m, i) => {
    const type = m.eventType || m.type || 'memory';
    const preview = (m.summary || m.preview || m.content || '').replace(/<[^>]*>/g, '').slice(0, 80);
    const lastAccessed = m.lastAccessedAt ? new Date(m.lastAccessedAt).toLocaleDateString() : (m.lastAccessed ? new Date(m.lastAccessed).toLocaleDateString() : '-');
    const id = m.id || m.memoryId || '';
    return `
      <div class="shared-item" style="cursor:pointer;" ${id ? `onclick="openDetailModal('${id}')"` : ''}>
        <div class="shared-info" style="flex-direction:column; align-items:flex-start; gap:2px;">
          <div style="display:flex; gap:6px; align-items:center;">
            <span class="event-type-badge type-${type.replace('_','-')}">${type}</span>
            <span style="font-size:10px; color:var(--text-muted);">last: ${lastAccessed}</span>
          </div>
          <span style="font-size:12px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px;" title="${escapeHtml(preview)}">${escapeHtml(preview) || '(no preview)'}</span>
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px; min-width:40px;">
          <span style="font-size:15px; font-weight:700; color:var(--accent-primary);">${m.accessCount}</span>
          <span style="font-size:10px; color:var(--text-muted);">hits</span>
        </div>
      </div>
    `;
  }).join('');
}

function updateMemoryUsageUI() {
  updateGraduationBars();
  updateMemoryUsefulnessUI();
  updateHelpfulnessUI();
  updateMostHelpfulList();
  updateTopAccessedEventsUI();
  updateAdherenceSummaryUI();
  updateRetrievalTraceUI();
}

function adherenceWindowToMs(window) {
  if (window === '24h') return 24 * 60 * 60 * 1000;
  if (window === '7d') return 7 * 24 * 60 * 60 * 1000;
  if (window === '30d') return 30 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

async function fetchAdherenceSummary() {
  const res = await fetch(apiUrl(`${API_BASE}/events`, { level: 'L0', limit: 500, sort: 'recent' }));
  if (!res.ok) return null;
  const data = await res.json();
  const events = data.events || [];

  const counts = {};
  let checked = 0;
  let skipped = 0;
  let total = 0;

  const now = Date.now();
  const windowMs = adherenceWindowToMs(state.adherenceWindow);

  for (const e of events) {
    const ts = e?.timestamp ? new Date(e.timestamp).getTime() : 0;
    if (!ts || now - ts > windowMs) continue;

    const adherence = e?.metadata?.adherence || e?.meta?.adherence;
    if (!adherence) continue;
    total++;
    const reason = adherence.reason || 'unknown';
    counts[reason] = (counts[reason] || 0) + 1;
    if (adherence.checked) checked++; else skipped++;
  }

  return { total, checked, skipped, counts, window: state.adherenceWindow };
}

function updateAdherenceSummaryUI() {
  const el = document.getElementById('adherence-summary');
  if (!el) return;

  const s = state.adherenceSummary;
  if (!s || !s.total) {
    el.innerHTML = '<span style="color:var(--text-muted);">No adherence metadata yet.</span>';
    return;
  }

  const top = Object.entries(s.counts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => `<span class="adherence-badge adherence-checked" style="margin-right:6px;">${escapeHtml(reason)}: ${count}</span>`)
    .join('');

  el.innerHTML = `
    <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:8px;">
      <span><strong>${s.total}</strong> tagged prompts (${escapeHtml(s.window || state.adherenceWindow)})</span>
      <span style="color:var(--success);"><strong>${s.checked}</strong> checked</span>
      <span style="color:var(--text-muted);"><strong>${s.skipped}</strong> skipped</span>
    </div>
    <div>${top}</div>
  `;
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

function updateMemoryUsefulnessUI() {
  const scoreEl = document.getElementById('memory-usefulness-score');
  const summaryEl = document.getElementById('memory-usefulness-summary');
  const breakdownEl = document.getElementById('memory-usefulness-breakdown');
  const diagnosticsEl = document.getElementById('memory-usefulness-diagnostics');
  if (!scoreEl || !summaryEl || !breakdownEl) return;

  const payload = state.memoryUsefulness;
  if (!payload || payload.error || !payload.score) {
    scoreEl.textContent = '-';
    scoreEl.className = 'memory-usefulness-score score-unknown';
    summaryEl.innerHTML = '<span style="color:var(--text-muted);">No usefulness telemetry yet.</span>';
    breakdownEl.innerHTML = '';
    if (diagnosticsEl) diagnosticsEl.innerHTML = '';
    return;
  }

  const score = payload.score || {};
  const counts = payload.counts || {};
  const label = score.label || 'unknown';
  const confidencePct = ((score.confidence || 0) * 100).toFixed(0);
  scoreEl.textContent = Number(score.value || 0).toFixed(1).replace(/\.0$/, '');
  scoreEl.className = `memory-usefulness-score score-${label}`;

  summaryEl.innerHTML = `
    <span class="usefulness-pill usefulness-${escapeHtml(label)}">${escapeHtml(label)}</span>
    <span><strong>${formatNumber(counts.retrievalQueries || 0)}</strong> queries</span>
    <span><strong>${formatNumber(counts.rewrittenQueries || 0)}</strong> rewritten</span>
    <span><strong>${formatNumber(counts.promptCount || 0)}</strong> prompts</span>
    <span><strong>${formatNumber(counts.totalEvaluated || 0)}</strong> evaluated</span>
    <span title="How many input signals were available for the composite score"><strong>${confidencePct}%</strong> confidence</span>
  `;

  const components = payload.components || [];
  breakdownEl.innerHTML = components.map((component) => {
    const valuePct = `${((component.value || 0) * 100).toFixed(1)}%`;
    const availableClass = component.available ? '' : ' unavailable';
    const availableText = component.available ? valuePct : 'n/a';
    const width = Math.max(0, Math.min(100, (component.value || 0) * 100));
    return `
      <div class="usefulness-component${availableClass}">
        <div class="usefulness-component-row">
          <span>${escapeHtml(component.label || component.key)}</span>
          <strong>${availableText}</strong>
        </div>
        <div class="usefulness-bar-track"><div class="usefulness-bar-fill" style="width:${width}%;"></div></div>
      </div>
    `;
  }).join('');

  const diagnostics = (payload.diagnostics || []).slice(0, 3);
  if (!diagnosticsEl) return;
  if (diagnostics.length === 0) {
    diagnosticsEl.innerHTML = '<div class="usefulness-diagnostics-empty">No immediate improvement actions.</div>';
    return;
  }

  diagnosticsEl.innerHTML = `
    <div class="usefulness-diagnostics-title">Top improvement actions</div>
    ${diagnostics.map((diagnostic) => `
      <div class="usefulness-diagnostic usefulness-diagnostic-${escapeHtml(diagnostic.severity || 'info')}">
        <div class="usefulness-diagnostic-header">
          <span class="usefulness-diagnostic-severity">${escapeHtml(diagnostic.severity || 'info')}</span>
          <strong>${escapeHtml(diagnostic.title || diagnostic.key || 'Improve memory usefulness')}</strong>
        </div>
        <div class="usefulness-diagnostic-detail">${escapeHtml(diagnostic.detail || '')}</div>
        <div class="usefulness-diagnostic-action">${escapeHtml(diagnostic.action || '')}</div>
      </div>
    `).join('')}
  `;
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


function updateRetrievalTraceUI() {
  const summaryEl = document.getElementById('retrieval-trace-summary');
  const listEl = document.getElementById('retrieval-trace-list');
  if (!summaryEl || !listEl) return;

  const payload = state.retrievalTraces;
  const stats = payload?.stats;
  const traces = payload?.traces || [];

  if (!stats || !Number.isFinite(stats.totalQueries) || stats.totalQueries === 0) {
    summaryEl.innerHTML = '<span style="color:var(--text-muted);">No retrieval traces yet.</span>';
    listEl.innerHTML = '<div style="padding:12px; text-align:center; color:var(--text-muted); font-size:13px;">No query/context trace data</div>';
    return;
  }

  const selectionRate = ((stats.selectionRate || 0) * 100).toFixed(1);
  const rewriteRate = ((stats.rewriteRate || 0) * 100).toFixed(1);
  summaryEl.innerHTML = `
    <div style="display:flex; gap:14px; flex-wrap:wrap; font-size:12px;">
      <span><strong>${formatNumber(stats.totalQueries)}</strong> queries</span>
      <span><strong>${Number(stats.avgCandidateCount || 0).toFixed(1)}</strong> avg candidates</span>
      <span><strong>${Number(stats.avgSelectedCount || 0).toFixed(1)}</strong> avg selected</span>
      <span><strong>${selectionRate}%</strong> selection rate</span>
      <span title="Share of retrieval queries enriched with previous prompt/assistant context"><strong>${rewriteRate}%</strong> rewrite rate</span>
    </div>
  `;

  listEl.innerHTML = traces.slice(0, 8).map((t) => {
    const ts = t.createdAt ? new Date(t.createdAt).toLocaleString() : '-';
    const confidence = t.confidence || 'n/a';
    const selected = Number(t.selectedCount || 0);
    const candidates = Number(t.candidateCount || 0);
    const rewriteKind = t.queryRewriteKind || (t.rewritten ? 'rewritten' : 'none');
    const rewriteBadge = rewriteKind && rewriteKind !== 'none'
      ? `<span class="event-type-badge" title="Query was enriched before retrieval">${escapeHtml(rewriteKind)}</span>`
      : '';
    const selectedDetails = (t.selectedDetails || []).slice(0, 2);
    const candidateDetails = (t.candidateDetails || []).slice(0, 3);
    const selectedIdsHtml = selectedDetails.length > 0
      ? selectedDetails.map((d) => {
          const breakdown = `score=${Number(d.score || 0).toFixed(3)} · s=${Number(d.semanticScore || 0).toFixed(3)} · l=${Number(d.lexicalScore || 0).toFixed(3)} · r=${Number(d.recencyScore || 0).toFixed(3)}`;
          return `<span class="event-type-badge" style="cursor:pointer;" onclick="openDetailModal('${d.eventId}')" title="${escapeHtml(breakdown)}">${escapeHtml((d.eventId || '').slice(0, 8))}...</span>`;
        }).join(' ')
      : ((t.selectedEventIds || []).slice(0, 2).map((id) => `<span class="event-type-badge" style="cursor:pointer;" onclick="openDetailModal('${id}')">${escapeHtml((id || '').slice(0, 8))}...</span>`).join(' ') || '-');

    const scoreBreakdownHtml = selectedDetails.length > 0
      ? selectedDetails.map((d) => `<div style="font-size:10px; color:var(--text-muted);">${escapeHtml((d.eventId || '').slice(0, 8))}... → score ${Number(d.score || 0).toFixed(3)} (s ${Number(d.semanticScore || 0).toFixed(3)}, l ${Number(d.lexicalScore || 0).toFixed(3)}, r ${Number(d.recencyScore || 0).toFixed(3)})</div>`).join('')
      : '';

    return `
      <div class="shared-item" style="align-items:flex-start;">
        <div class="shared-info" style="align-items:flex-start; flex-direction:column; gap:4px;">
          <span style="font-size:12px; color:var(--text-secondary);"><strong>Q:</strong> ${escapeHtml((t.queryText || '').slice(0, 120))}</span>
          <span style="font-size:11px; color:var(--text-muted);">${ts} · strategy=${escapeHtml(t.strategy || 'auto')} · conf=${escapeHtml(confidence)} ${rewriteBadge}</span>
          <span style="font-size:11px; color:var(--text-muted);">selected IDs: ${selectedIdsHtml}</span>
          <span style="font-size:11px; color:var(--text-muted);">candidates: ${candidateDetails.map((d) => `<span class=\"event-type-badge\" style=\"cursor:pointer;\" onclick=\"openDetailModal('${d.eventId}')\">${escapeHtml((d.eventId || '').slice(0, 8))}...</span>`).join(' ') || '-'}</span>
          ${scoreBreakdownHtml}
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px; min-width:68px;">
          <span style="font-size:13px; font-weight:600; color:var(--accent-primary);">${selected}/${candidates}</span>
          <span style="font-size:10px; color:var(--text-muted);">sel/cand</span>
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

