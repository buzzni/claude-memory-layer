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

function operationStatsWindowDays() {
  return state.kpiWindow === '30d' ? 30 : 7;
}

async function loadOperationsStatsData() {
  state.operationsStats = await fetch(apiUrl(`${API_BASE}/stats/operations`, { windowDays: operationStatsWindowDays() }))
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);
}

async function loadPerspectiveStatsData() {
  state.perspectiveStats = await fetch(apiUrl(`${API_BASE}/stats/perspective`, { windowDays: operationStatsWindowDays() }))
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);
}

async function loadVectorHealthData() {
  state.vectorHealth = await fetch(apiUrl(`${API_BASE}/health`))
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);
}

async function loadProjectDetailData() {
  if (!state.currentProject) {
    state.projectDetail = null;
    state.projectDetailProject = null;
    return;
  }
  const projectHash = state.currentProject;
  state.projectDetail = await fetch(apiUrl(`${API_BASE}/projects/${encodeURIComponent(projectHash)}/detail`))
    .then(r => r.ok !== false ? r.json() : null)
    .catch(() => null);
  state.projectDetailProject = projectHash;
}

function topEntries(record, limit = 3) {
  return Object.entries(record || {})
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, limit);
}

function updateProjectDetailUI() {
  const el = document.getElementById('project-detail-card');
  if (!el) return;

  if (!state.currentProject) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }

  el.hidden = false;
  const detail = state.projectDetailProject === state.currentProject ? state.projectDetail : null;
  if (!detail) {
    el.innerHTML = `
      <div class="card-header">
        <div class="card-title"><i class="ri-folder-chart-line"></i><span>Project Detail</span></div>
      </div>
      <div class="disclosure-empty">Project detail is unavailable for the selected scope.</div>
    `;
    return;
  }

  const project = detail.project || {};
  const storage = detail.storage || {};
  const sessions = detail.sessions || {};
  const retrieval = detail.retrieval || {};
  const outbox = detail.outbox || {};
  const eventTypeChips = topEntries(detail.eventTypes, 4)
    .map(([label, count]) => `<span class="event-type-badge ${eventTypeBadgeClass(label)}">${escapeHtml(label)} · ${formatNumber(count)}</span>`)
    .join('') || '<span class="session-muted">No event types</span>';
  const sourceChips = topEntries(detail.sources, 3)
    .map(([label, count]) => `<span class="disclosure-scope-pill">${escapeHtml(label)} · ${formatNumber(count)}</span>`)
    .join('') || '<span class="session-muted">No source metadata</span>';
  const selectionRate = `${((retrieval.selectionRate || 0) * 100).toFixed(1)}% selection`;

  el.innerHTML = `
    <div class="card-header" style="align-items:flex-start;">
      <div>
        <div class="card-title"><i class="ri-folder-chart-line"></i><span>Project Detail</span></div>
        <div class="session-muted">${escapeHtml(project.projectName || state.currentProject)} · ${escapeHtml(project.registered ? 'registered' : 'unregistered')}</div>
      </div>
      <span class="disclosure-scope-pill">${escapeHtml(project.hash || state.currentProject)}</span>
    </div>
    <div class="stats-grid kpi-grid" style="margin-top:0; margin-bottom:14px;">
      <div class="stat-card kpi-card"><div class="stat-value">${formatNumber(storage.eventCount || 0)} events</div><div class="stat-label"><i class="ri-file-list-3-line"></i> total</div></div>
      <div class="stat-card kpi-card"><div class="stat-value">${formatNumber(sessions.total || 0)} sessions</div><div class="stat-label"><i class="ri-discuss-line"></i> active</div></div>
      <div class="stat-card kpi-card"><div class="stat-value">${formatNumber(storage.vectorCount || 0)} vectors</div><div class="stat-label"><i class="ri-node-tree"></i> indexed</div></div>
      <div class="stat-card kpi-card"><div class="stat-value">${formatNumber(retrieval.totalQueries || 0)}</div><div class="stat-label"><i class="ri-search-eye-line"></i> ${selectionRate}</div></div>
    </div>
    <div class="cfg-grid">
      <div class="cfg-section">
        <div class="cfg-section-title"><i class="ri-price-tag-3-line"></i>Event types</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">${eventTypeChips}</div>
      </div>
      <div class="cfg-section">
        <div class="cfg-section-title"><i class="ri-router-line"></i>Sources & outbox</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px;">${sourceChips}</div>
        <div class="session-muted">${formatNumber(outbox.pending || 0)} pending · ${formatNumber(outbox.processing || 0)} processing · ${formatNumber(outbox.failed || 0)} failed · ${formatNumber(outbox.retryableFailed || 0)} retryable · ${formatNumber(outbox.quarantinedFailed || 0)} quarantined · ${formatNumber(outbox.stuckProcessing || 0)} stuck</div>
      </div>
    </div>
  `;
}

async function refreshData() {
  const btn = document.getElementById('refresh-btn');
  if(btn) btn.classList.add('loading');
  const refreshRequestId = (state.refreshRequestId || 0) + 1;
  state.refreshRequestId = refreshRequestId;
  const projectAtStart = state.currentProject;
  const kpiWindowAtStart = state.kpiWindow;

  try {
    const [stats, shared, mostAccessed, helpfulness, memoryUsefulness, retrievalTraces, retrievalReviewQueue, operationsStats, perspectiveStats, adherenceSummary, vectorHealth, projectDetail] = await Promise.all([
      fetch(apiUrl(`${API_BASE}/stats`)).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/shared`)).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/most-accessed`, { limit: 10 })).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/helpfulness`, { limit: 5 })).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/usefulness`, { window: state.kpiWindow })).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/retrieval-traces`, { limit: 20 })).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/retrieval-review-queue`, { limit: 10 })).then(r => r.json()).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/operations`, { windowDays: operationStatsWindowDays() })).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(apiUrl(`${API_BASE}/stats/perspective`, { windowDays: operationStatsWindowDays() })).then(r => r.ok ? r.json() : null).catch(() => null),
      fetchAdherenceSummary().catch(() => null),
      fetch(apiUrl(`${API_BASE}/health`)).then(r => r.ok ? r.json() : null).catch(() => null),
      state.currentProject
        ? fetch(apiUrl(`${API_BASE}/projects/${encodeURIComponent(state.currentProject)}/detail`)).then(r => r.ok ? r.json() : null).catch(() => null)
        : Promise.resolve(null)
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
    state.retrievalReviewQueue = retrievalReviewQueue;
    state.operationsStats = operationsStats;
    state.perspectiveStats = perspectiveStats;
    state.adherenceSummary = adherenceSummary;
    state.vectorHealth = vectorHealth;
    state.projectDetail = projectDetail;
    state.projectDetailProject = state.currentProject || null;

    await loadKpiData();
    if (refreshRequestId !== state.refreshRequestId) return;

    updateStatsUI();
    updateProjectDetailUI();
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
  if (typeof updateProjectScopeUI === 'function') updateProjectScopeUI();

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
    const typeClass = eventTypeBadgeClass(eventType);
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
          <span class="event-type-badge ${typeClass}">${escapeHtml(eventType)}</span>
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
    const typeClass = eventTypeBadgeClass(type);
    return `
      <div class="shared-item" style="cursor:pointer;" ${id ? `onclick="openDetailModal(${jsAttrArg(id)})"` : ''}>
        <div class="shared-info" style="flex-direction:column; align-items:flex-start; gap:2px;">
          <div style="display:flex; gap:6px; align-items:center;">
            <span class="event-type-badge ${typeClass}">${escapeHtml(type)}</span>
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
  updateVectorHealthUI();
  updateOperationsStatsUI();
  updatePerspectiveStatsUI();
}

function vectorHealthCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function vectorHealthEmpty(message) {
  return `<div style="padding:12px; text-align:center; color:var(--text-muted); font-size:13px;">${escapeHtml(message)}</div>`;
}

function vectorOutboxTotals(outbox) {
  const embedding = outbox?.embedding || {};
  const vector = outbox?.vector || {};
  const providedTotals = outbox?.totals || null;
  return {
    pending: vectorHealthCount(providedTotals?.pending ?? (vectorHealthCount(embedding.pending) + vectorHealthCount(vector.pending))),
    processing: vectorHealthCount(providedTotals?.processing ?? (vectorHealthCount(embedding.processing) + vectorHealthCount(vector.processing))),
    failed: vectorHealthCount(providedTotals?.failed ?? (vectorHealthCount(embedding.failed) + vectorHealthCount(vector.failed))),
    retryableFailed: vectorHealthCount(providedTotals?.retryableFailed ?? (vectorHealthCount(embedding.retryableFailed) + vectorHealthCount(vector.retryableFailed))),
    quarantinedFailed: vectorHealthCount(providedTotals?.quarantinedFailed ?? (vectorHealthCount(embedding.quarantinedFailed) + vectorHealthCount(vector.quarantinedFailed))),
    stuckProcessing: vectorHealthCount(providedTotals?.stuckProcessing ?? (vectorHealthCount(embedding.stuckProcessing) + vectorHealthCount(vector.stuckProcessing))),
    oldestProcessingAgeMs: providedTotals?.oldestProcessingAgeMs ?? maxNullableHealthAge(embedding.oldestProcessingAgeMs, vector.oldestProcessingAgeMs)
  };
}

function maxNullableHealthAge(a, b) {
  const values = [a, b]
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value >= 0);
  return values.length > 0 ? Math.max(...values) : null;
}

function formatVectorHealthAge(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return 'none';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function vectorOutboxQueueRow(label, stats) {
  const pending = vectorHealthCount(stats?.pending);
  const processing = vectorHealthCount(stats?.processing);
  const failed = vectorHealthCount(stats?.failed);
  const retryable = vectorHealthCount(stats?.retryableFailed);
  const quarantined = vectorHealthCount(stats?.quarantinedFailed);
  const stuck = vectorHealthCount(stats?.stuckProcessing);
  const total = vectorHealthCount(stats?.total);
  const age = formatVectorHealthAge(stats?.oldestProcessingAgeMs);
  const statusColor = quarantined > 0 || stuck > 0 || failed > 0 ? 'var(--warning)' : 'var(--success)';
  return `
    <div class="shared-item">
      <div class="shared-info" style="flex-direction:column; align-items:flex-start; gap:2px; min-width:0;">
        <span style="font-size:12px; color:var(--text-secondary);">${escapeHtml(label)}</span>
        <span style="font-size:10px; color:var(--text-muted);">pending ${formatNumber(pending)} · processing ${formatNumber(processing)} · failed ${formatNumber(failed)} · retryable ${formatNumber(retryable)} · quarantined ${formatNumber(quarantined)} · stuck ${formatNumber(stuck)} · oldest ${age}</span>
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px; min-width:48px;">
        <span style="font-size:15px; font-weight:700; color:${statusColor};">${formatNumber(total)}</span>
        <span style="font-size:10px; color:var(--text-muted);">total</span>
      </div>
    </div>
  `;
}

function recoveryBucketTotal(bucket) {
  return vectorHealthCount(bucket?.recoveredProcessing) + vectorHealthCount(bucket?.retriedFailed);
}

function renderVectorHealthRecovery() {
  const recoveryEl = document.getElementById('vector-health-recovery-result');
  if (!recoveryEl) return;

  const recovery = state.vectorHealthRecovery;
  const recoveryProject = state.vectorHealthRecoveryProject;
  if (recovery && recoveryProject !== null && recoveryProject !== (state.currentProject || '')) {
    recoveryEl.innerHTML = '<span style="color:var(--text-muted);">No recovery run in this dashboard session.</span>';
    return;
  }
  if (!recovery) {
    recoveryEl.innerHTML = '<span style="color:var(--text-muted);">No recovery run in this dashboard session.</span>';
    return;
  }

  if (recovery.status && recovery.status !== 'ok') {
    recoveryEl.innerHTML = '<span style="color:var(--warning);">Last recovery request failed. No private error details are shown.</span>';
    return;
  }

  const embeddingTotal = recoveryBucketTotal(recovery.recovered?.embedding);
  const vectorTotal = recoveryBucketTotal(recovery.recovered?.vector);
  const timestamp = recovery.timestamp ? new Date(recovery.timestamp).toLocaleString() : 'just now';
  recoveryEl.innerHTML = `
    <span style="color:var(--text-secondary);">Last recovery ${escapeHtml(timestamp)}</span>
    <span style="color:var(--text-muted); margin-left:6px;">embedding=${formatNumber(embeddingTotal)} · vector=${formatNumber(vectorTotal)} · total=${formatNumber(embeddingTotal + vectorTotal)}</span>
  `;
}

function updateVectorHealthUI() {
  const payload = state.vectorHealth;
  const summaryEl = document.getElementById('vector-health-summary');
  const queueEl = document.getElementById('vector-health-queue-list');
  const recoveryEl = document.getElementById('vector-health-recovery-result');
  if (!summaryEl && !queueEl && !recoveryEl) return;

  if (!payload) {
    if (summaryEl) summaryEl.innerHTML = '<span style="color:var(--text-muted);">Vector health unavailable</span>';
    if (queueEl) queueEl.innerHTML = vectorHealthEmpty('Vector health aggregate data unavailable');
    renderVectorHealthRecovery();
    return;
  }

  const status = payload.status || 'unknown';
  const outbox = payload.outbox || {};
  const totals = vectorOutboxTotals(outbox);
  const vectorCount = vectorHealthCount(payload.storage?.vectorCount);
  const statusColor = status === 'ok' ? 'var(--success)' : (status === 'needs-attention' ? 'var(--warning)' : 'var(--text-muted)');

  if (summaryEl) {
    summaryEl.innerHTML = `
      <div style="display:flex; gap:10px; flex-wrap:wrap; font-size:13px; color:var(--text-secondary);">
        <span><strong style="color:${statusColor};">${escapeHtml(status)}</strong></span>
        <span><strong>${formatNumber(vectorCount)} vectors</strong></span>
        <span><strong>${formatNumber(totals.pending)} pending</strong></span>
        <span><strong>${formatNumber(totals.processing)} processing</strong></span>
        <span><strong>${formatNumber(totals.failed)} failed</strong></span>
        <span><strong>${formatNumber(totals.retryableFailed)} retryable</strong></span>
        <span><strong>${formatNumber(totals.quarantinedFailed)} quarantined</strong></span>
        <span><strong>${formatNumber(totals.stuckProcessing)} stuck</strong></span>
        <span><strong>${formatVectorHealthAge(totals.oldestProcessingAgeMs)} oldest processing</strong></span>
      </div>
    `;
  }

  if (queueEl) {
    queueEl.innerHTML = [
      vectorOutboxQueueRow('Embedding Outbox', outbox.embedding),
      vectorOutboxQueueRow('Vector Outbox', outbox.vector)
    ].join('');
  }

  renderVectorHealthRecovery();
}

function healthPayloadFromRecovery(payload) {
  const after = payload?.after || {};
  if (!after.storage && !after.outbox) return null;
  const totals = vectorOutboxTotals(after.outbox || {});
  const status = totals.failed > 0 || totals.stuckProcessing > 0 ? 'needs-attention' : (payload.status || 'ok');
  return {
    status,
    timestamp: payload.timestamp || new Date().toISOString(),
    storage: after.storage || {},
    outbox: after.outbox || {},
    levelStats: []
  };
}

async function recoverVectorHealth() {
  const button = document.getElementById('vector-health-recover-btn');
  if (state.isVectorRecoveryRunning) return;
  state.isVectorRecoveryRunning = true;
  if (button) button.disabled = true;

  try {
    const response = await fetch(apiUrl(`${API_BASE}/health/recover`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!response.ok) throw new Error('recovery failed');
    const payload = await response.json();
    state.vectorHealthRecovery = payload;
    state.vectorHealthRecoveryProject = state.currentProject || '';
    const health = healthPayloadFromRecovery(payload);
    if (health) state.vectorHealth = health;
    updateVectorHealthUI();
  } catch {
    state.vectorHealthRecovery = {
      status: 'error',
      timestamp: new Date().toISOString(),
      recovered: {
        embedding: { recoveredProcessing: 0, retriedFailed: 0 },
        vector: { recoveredProcessing: 0, retriedFailed: 0 }
      }
    };
    state.vectorHealthRecoveryProject = state.currentProject || '';
    updateVectorHealthUI();
  } finally {
    state.isVectorRecoveryRunning = false;
    if (button) button.disabled = false;
  }
}

function operationCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function operationEmpty(message) {
  return `<div style="padding:12px; text-align:center; color:var(--text-muted); font-size:13px;">${escapeHtml(message)}</div>`;
}

function operationRows(rows, labelKey, countKey, emptyMessage, labelFormatter) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (safeRows.length === 0) return operationEmpty(emptyMessage);
  return safeRows.map(row => {
    const label = labelFormatter ? labelFormatter(row) : row?.[labelKey];
    return `
      <div class="shared-item">
        <div class="shared-info" style="min-width:0;">
          <span style="font-size:12px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(label || 'unknown')}</span>
        </div>
        <div class="shared-count">${formatNumber(operationCount(row?.[countKey]))}</div>
      </div>
    `;
  }).join('');
}

function updateOperationsStatsUI() {
  const payload = state.operationsStats;
  const summaryEl = document.getElementById('operations-stats-summary');
  const facetsEl = document.getElementById('operations-facets-list');
  const actionsEl = document.getElementById('operations-actions-list');
  const leasesEl = document.getElementById('operations-leases-list');
  const retentionEl = document.getElementById('operations-retention-list');
  const governanceEl = document.getElementById('operations-governance-list');
  const lessonsEl = document.getElementById('operations-lessons-list');

  if (!summaryEl && !facetsEl && !actionsEl && !leasesEl && !retentionEl && !governanceEl && !lessonsEl) return;

  if (!payload) {
    if (summaryEl) summaryEl.innerHTML = '<span style="color:var(--text-muted);">Operation aggregates unavailable</span>';
    if (facetsEl) facetsEl.innerHTML = operationEmpty('Operation aggregate data unavailable');
    if (actionsEl) actionsEl.innerHTML = operationEmpty('Operation aggregate data unavailable');
    if (leasesEl) leasesEl.innerHTML = operationEmpty('Operation aggregate data unavailable');
    if (retentionEl) retentionEl.innerHTML = operationEmpty('Operation aggregate data unavailable');
    if (governanceEl) governanceEl.innerHTML = operationEmpty('Operation aggregate data unavailable');
    if (lessonsEl) lessonsEl.innerHTML = operationEmpty('Operation aggregate data unavailable');
    return;
  }

  const available = payload.projection?.available !== false && payload.projection?.databaseExists !== false;
  if (summaryEl) {
    if (!available) {
      summaryEl.innerHTML = '<span style="color:var(--text-muted);">Operation projections unavailable</span>';
    } else {
      summaryEl.innerHTML = `
        <div style="display:flex; gap:10px; flex-wrap:wrap; font-size:13px; color:var(--text-secondary);">
          <span><strong>${formatNumber(operationCount(payload.facets?.totalAssignments))} facets</strong></span>
          <span><strong>${formatNumber(operationCount(payload.actions?.total))} actions</strong></span>
          <span><strong>${formatNumber(operationCount(payload.leases?.totalActive))} active leases</strong></span>
          <span><strong>${formatNumber(operationCount(payload.retention?.total))} retention decisions</strong></span>
          <span><strong>${formatNumber(operationCount(payload.governanceAudit?.total))} audits</strong></span>
          <span><strong>${formatNumber(operationCount(payload.lessons?.total))} lessons</strong></span>
        </div>
      `;
    }
  }

  if (!available) {
    if (facetsEl) facetsEl.innerHTML = operationEmpty('No facet aggregates');
    if (actionsEl) actionsEl.innerHTML = operationEmpty('No action status data');
    if (leasesEl) leasesEl.innerHTML = operationEmpty('No active leases');
    if (retentionEl) retentionEl.innerHTML = operationEmpty('No retention decisions');
    if (governanceEl) governanceEl.innerHTML = operationEmpty('No governance audit activity');
    if (lessonsEl) lessonsEl.innerHTML = operationEmpty('No lesson confidence data');
    return;
  }

  if (facetsEl) {
    const distributions = Array.isArray(payload.facets?.distribution) ? payload.facets.distribution : [];
    facetsEl.innerHTML = distributions.length === 0
      ? operationEmpty('No facet aggregates')
      : distributions.map(item => {
          const valueCount = Array.isArray(item?.values) ? item.values.reduce((sum, row) => sum + operationCount(row?.count), 0) : 0;
          const otherCount = operationCount(item?.other);
          const bucketCount = (Array.isArray(item?.values) ? item.values.length : 0) + (otherCount > 0 ? 1 : 0);
          return `
            <div class="shared-item">
              <div class="shared-info" style="min-width:0;">
                <span style="font-size:12px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(item?.dimension || 'unknown')}</span>
              </div>
              <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px; min-width:72px;">
                <span style="font-size:15px; font-weight:700; color:var(--accent-primary);">${formatNumber(valueCount + otherCount)}</span>
                <span style="font-size:10px; color:var(--text-muted);">${bucketCount} value buckets</span>
              </div>
            </div>
          `;
        }).join('');
  }

  if (actionsEl) actionsEl.innerHTML = operationRows(payload.actions?.byStatus, 'status', 'count', 'No action status data');
  if (leasesEl) leasesEl.innerHTML = operationRows(payload.leases?.activeByTargetType, 'targetType', 'count', 'No active leases');
  if (retentionEl) retentionEl.innerHTML = operationRows(payload.retention?.byDecision, 'decision', 'count', 'No retention decisions');
  if (governanceEl) {
    const days = Array.isArray(payload.governanceAudit?.operationsByDay) ? payload.governanceAudit.operationsByDay : [];
    governanceEl.innerHTML = days.length === 0
      ? operationEmpty('No governance audit activity')
      : days.map(day => {
          const operations = (Array.isArray(day?.operations) ? day.operations : [])
            .map(op => `${escapeHtml(op?.operation || 'unknown')}: ${formatNumber(operationCount(op?.count))}`)
            .join(' · ');
          return `
            <div class="shared-item">
              <div class="shared-info" style="flex-direction:column; align-items:flex-start; gap:2px; min-width:0;">
                <span style="font-size:12px; color:var(--text-secondary);">${escapeHtml(day?.date || 'unknown')}</span>
                <span style="font-size:10px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:220px;">${operations || 'no operations'}</span>
              </div>
              <div class="shared-count">${formatNumber(operationCount(day?.total))}</div>
            </div>
          `;
        }).join('');
  }
  if (lessonsEl) lessonsEl.innerHTML = operationRows(payload.lessons?.confidenceBuckets, 'bucket', 'count', 'No lesson confidence data');
}

function perspectiveLevelRows(rows, emptyMessage) {
  return operationRows(rows, 'level', 'count', emptyMessage);
}

function perspectiveGraphRows(edges) {
  const safeEdges = Array.isArray(edges) ? edges : [];
  if (safeEdges.length === 0) return operationEmpty('No perspective graph edges');
  return safeEdges.map(edge => {
    const confidence = `${(Number(edge?.averageConfidence || 0) * 100).toFixed(0)}% avg confidence`;
    const levels = (Array.isArray(edge?.levelCounts) ? edge.levelCounts : [])
      .map(level => `${escapeHtml(level?.level || 'unknown')}: ${formatNumber(operationCount(level?.count))}`)
      .join(' · ');
    return `
      <div class="shared-item">
        <div class="shared-info" style="flex-direction:column; align-items:flex-start; gap:2px; min-width:0;">
          <span style="font-size:12px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:240px;">${escapeHtml(edge?.observerActorId || 'unknown')} → ${escapeHtml(edge?.observedActorId || 'unknown')}</span>
          <span style="font-size:10px; color:var(--text-muted);">${formatNumber(operationCount(edge?.observationCount))} observations · ${formatNumber(operationCount(edge?.actorCardCount))} actor cards · ${confidence}</span>
          <span style="font-size:10px; color:var(--text-muted);">sources: ${formatNumber(operationCount(edge?.sourceEventCount))} events · ${formatNumber(operationCount(edge?.sourceObservationCount))} observations</span>
          <span style="font-size:10px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:240px;">${levels || 'no levels'}</span>
        </div>
        <div class="shared-count">${formatNumber(operationCount(edge?.observationCount))}</div>
      </div>
    `;
  }).join('');
}

function perspectiveSourceEvidenceRows(sourceEvidence) {
  const rows = Array.isArray(sourceEvidence?.byLevel) ? sourceEvidence.byLevel : [];
  const summary = sourceEvidence?.summary || {};
  if (rows.length === 0) return operationEmpty('No source evidence aggregates');
  return `
    <div class="shared-item">
      <div class="shared-info" style="flex-direction:column; align-items:flex-start; gap:2px; min-width:0;">
        <span style="font-size:12px; color:var(--text-secondary);">Evidence coverage</span>
        <span style="font-size:10px; color:var(--text-muted);">${formatNumber(operationCount(summary.totalSourceEvents))} source events · ${formatNumber(operationCount(summary.totalSourceObservations))} source observations · ${formatNumber(operationCount(summary.observationsMissingEvidence))} missing evidence</span>
      </div>
      <div class="shared-count">${formatNumber(operationCount(summary.totalObservations))}</div>
    </div>
    ${rows.map(row => `
      <div class="shared-item">
        <div class="shared-info" style="flex-direction:column; align-items:flex-start; gap:2px; min-width:0;">
          <span style="font-size:12px; color:var(--text-secondary);">${escapeHtml(row?.level || 'unknown')}</span>
          <span style="font-size:10px; color:var(--text-muted);">sources: ${formatNumber(operationCount(row?.sourceEventCount))} events · ${formatNumber(operationCount(row?.sourceObservationCount))} observations · missing: ${formatNumber(operationCount(row?.missingEvidenceCount))}</span>
        </div>
        <div class="shared-count">${formatNumber(operationCount(row?.count))}</div>
      </div>
    `).join('')}
  `;
}

function updatePerspectiveStatsUI() {
  const payload = state.perspectiveStats;
  const summaryEl = document.getElementById('perspective-stats-summary');
  const actorsEl = document.getElementById('perspective-actors-list');
  const cardsEl = document.getElementById('perspective-cards-list');
  const observationsEl = document.getElementById('perspective-observations-list');
  const graphEl = document.getElementById('perspective-graph-list');
  const evidenceEl = document.getElementById('perspective-evidence-list');
  const contradictionsEl = document.getElementById('perspective-contradictions-list');
  const activityEl = document.getElementById('perspective-activity-list');

  if (!summaryEl && !actorsEl && !cardsEl && !observationsEl && !graphEl && !evidenceEl && !contradictionsEl && !activityEl) return;

  if (!payload) {
    if (summaryEl) summaryEl.innerHTML = '<span style="color:var(--text-muted);">Perspective aggregates unavailable</span>';
    if (actorsEl) actorsEl.innerHTML = operationEmpty('Perspective aggregate data unavailable');
    if (cardsEl) cardsEl.innerHTML = operationEmpty('Perspective aggregate data unavailable');
    if (observationsEl) observationsEl.innerHTML = operationEmpty('Perspective aggregate data unavailable');
    if (graphEl) graphEl.innerHTML = operationEmpty('Perspective aggregate data unavailable');
    if (evidenceEl) evidenceEl.innerHTML = operationEmpty('Perspective aggregate data unavailable');
    if (contradictionsEl) contradictionsEl.innerHTML = operationEmpty('Perspective aggregate data unavailable');
    if (activityEl) activityEl.innerHTML = operationEmpty('Perspective aggregate data unavailable');
    return;
  }

  const available = payload.projection?.available !== false && payload.projection?.databaseExists !== false;
  if (summaryEl) {
    if (!available) {
      summaryEl.innerHTML = '<span style="color:var(--text-muted);">Perspective projections unavailable</span>';
    } else {
      summaryEl.innerHTML = `
        <div style="display:flex; gap:10px; flex-wrap:wrap; font-size:13px; color:var(--text-secondary);">
          <span><strong>${formatNumber(operationCount(payload.actors?.total))} actors</strong></span>
          <span><strong>${formatNumber(operationCount(payload.sessionActors?.total))} session actors</strong></span>
          <span><strong>${formatNumber(operationCount(payload.actorCards?.total))} actor cards</strong></span>
          <span><strong>${formatNumber(operationCount(payload.observations?.total))} observations</strong></span>
          <span><strong>${formatNumber(operationCount(payload.perspectiveGraph?.summary?.totalEdges))} perspective edges</strong></span>
          <span><strong>${formatNumber(operationCount(payload.contradictions?.summary?.total))} contradictions</strong></span>
        </div>
      `;
    }
  }

  if (!available) {
    if (actorsEl) actorsEl.innerHTML = operationEmpty('No actor kind data');
    if (cardsEl) cardsEl.innerHTML = operationEmpty('No actor card aggregates');
    if (observationsEl) observationsEl.innerHTML = operationEmpty('No perspective observation data');
    if (graphEl) graphEl.innerHTML = operationEmpty('No perspective graph edges');
    if (evidenceEl) evidenceEl.innerHTML = operationEmpty('No source evidence aggregates');
    if (contradictionsEl) contradictionsEl.innerHTML = operationEmpty('No contradictions queued');
    if (activityEl) activityEl.innerHTML = operationEmpty('No perspective activity');
    return;
  }

  if (actorsEl) {
    const kindRows = operationRows(payload.actors?.byKind, 'kind', 'count', 'No actor kind data');
    const roleRows = operationRows(payload.sessionActors?.byRole, 'role', 'count', 'No session actor roles');
    actorsEl.innerHTML = `
      <div class="section-label" style="font-size:11px; margin-bottom:6px;">Actor Kinds</div>
      ${kindRows}
      <div class="section-label" style="font-size:11px; margin:12px 0 6px;">Session Roles</div>
      ${roleRows}
      <div style="font-size:10px; color:var(--text-muted); padding:8px 0;">observe self: ${formatNumber(operationCount(payload.sessionActors?.observeSelfEnabled))} · observe others: ${formatNumber(operationCount(payload.sessionActors?.observeOthersEnabled))}</div>
    `;
  }

  if (cardsEl) {
    const totalCards = operationCount(payload.actorCards?.total);
    if (totalCards === 0) {
      cardsEl.innerHTML = operationEmpty('No actor card aggregates');
    } else {
      cardsEl.innerHTML = `
        <div class="shared-item">
          <div class="shared-info"><span style="font-size:12px; color:var(--text-secondary);">Total cards</span></div>
          <div class="shared-count">${formatNumber(totalCards)}</div>
        </div>
        <div class="shared-item">
          <div class="shared-info"><span style="font-size:12px; color:var(--text-secondary);">Card entries</span></div>
          <div class="shared-count">${formatNumber(operationCount(payload.actorCards?.totalEntries))} entries</div>
        </div>
        <div class="shared-item">
          <div class="shared-info"><span style="font-size:12px; color:var(--text-secondary);">Average entries</span></div>
          <div class="shared-count">${Number(payload.actorCards?.averageEntries || 0).toFixed(2)}</div>
        </div>
        <div class="shared-item">
          <div class="shared-info"><span style="font-size:12px; color:var(--text-secondary);">Full cards</span></div>
          <div class="shared-count">${formatNumber(operationCount(payload.actorCards?.fullCards))} full cards</div>
        </div>
      `;
    }
  }

  if (observationsEl) {
    const byLevel = perspectiveLevelRows(payload.observations?.byLevel, 'No perspective observation data');
    const byCreatedBy = operationRows(payload.observations?.byCreatedBy, 'createdBy', 'count', 'No observation creator data');
    observationsEl.innerHTML = `
      <div class="section-label" style="font-size:11px; margin-bottom:6px;">Timeline / Levels</div>
      ${byLevel}
      <div class="section-label" style="font-size:11px; margin:12px 0 6px;">Created By</div>
      ${byCreatedBy}
    `;
  }

  if (graphEl) {
    graphEl.innerHTML = perspectiveGraphRows(payload.perspectiveGraph?.edges);
  }

  if (evidenceEl) {
    evidenceEl.innerHTML = perspectiveSourceEvidenceRows(payload.sourceEvidence);
  }

  if (contradictionsEl) {
    const items = Array.isArray(payload.contradictions?.items) ? payload.contradictions.items : [];
    contradictionsEl.innerHTML = items.length === 0
      ? operationEmpty('No contradictions queued')
      : items.map(item => {
          const confidence = `${(Number(item?.confidence || 0) * 100).toFixed(0)}%`;
          return `
            <div class="shared-item">
              <div class="shared-info" style="flex-direction:column; align-items:flex-start; gap:2px; min-width:0;">
                <span style="font-size:12px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:220px;">${escapeHtml(item?.observationId || 'unknown')}</span>
                <span style="font-size:10px; color:var(--text-muted);">${escapeHtml(item?.observerActorId || 'unknown')} → ${escapeHtml(item?.observedActorId || 'unknown')}</span>
                <span style="font-size:10px; color:var(--text-muted);">sources: ${formatNumber(operationCount(item?.sourceEventCount))} events · ${formatNumber(operationCount(item?.sourceObservationCount))} observations</span>
              </div>
              <div class="shared-count">${confidence}</div>
            </div>
          `;
        }).join('');
  }

  if (activityEl) {
    const days = Array.isArray(payload.recentActivity?.byDay) ? payload.recentActivity.byDay : [];
    activityEl.innerHTML = days.length === 0
      ? operationEmpty('No perspective activity')
      : days.map(day => {
          const levels = (Array.isArray(day?.levels) ? day.levels : [])
            .map(level => `${escapeHtml(level?.level || 'unknown')}: ${formatNumber(operationCount(level?.count))}`)
            .join(' · ');
          return `
            <div class="shared-item">
              <div class="shared-info" style="flex-direction:column; align-items:flex-start; gap:2px; min-width:0;">
                <span style="font-size:12px; color:var(--text-secondary);">${escapeHtml(day?.date || 'unknown')}</span>
                <span style="font-size:10px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:220px;">${levels || 'no levels'}</span>
              </div>
              <div class="shared-count">${formatNumber(operationCount(day?.total))}</div>
            </div>
          `;
        }).join('');
  }
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
  // Keep the compact Overview strip in sync (defined in usefulness.js;
  // absent in isolated test harnesses).
  if (typeof updateOverviewUsefulnessStrip === 'function') {
    updateOverviewUsefulnessStrip();
  }
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


function updateRetrievalReviewQueueUI() {
  const summaryEl = document.getElementById('retrieval-review-summary');
  const listEl = document.getElementById('retrieval-review-list');
  if (!summaryEl || !listEl) return;

  const payload = state.retrievalReviewQueue;
  if (payload?.error) {
    summaryEl.innerHTML = '<span style="color:var(--warning, #FEB019);">Retrieval review queue is temporarily unavailable.</span>';
    listEl.innerHTML = '<div style="padding:12px; text-align:center; color:var(--text-muted); font-size:13px;">Unable to load bad retrieval cases right now.</div>';
    return;
  }
  const summary = payload?.summary;
  const items = payload?.items || [];

  if (!summary || !Number.isFinite(summary.reviewItems) || summary.reviewItems === 0) {
    summaryEl.innerHTML = '<span style="color:var(--text-muted);">No retrieval traces need review.</span>';
    listEl.innerHTML = '<div style="padding:12px; text-align:center; color:var(--text-muted); font-size:13px;">No bad retrieval cases in the current scan</div>';
    return;
  }

  summaryEl.innerHTML = `
    <div style="display:flex; gap:14px; flex-wrap:wrap; font-size:12px;">
      <span><strong>${formatNumber(summary.reviewItems)}</strong> review items</span>
      <span><strong>${formatNumber(summary.rewrittenNoSelection || 0)}</strong> rewritten no-selection</span>
      <span><strong>${formatNumber(summary.candidateNoSelection || 0)}</strong> candidate no-selection</span>
      <span><strong>${formatNumber(summary.emptyCandidateSet || 0)}</strong> empty candidates</span>
    </div>
  `;

  listEl.innerHTML = items.slice(0, 10).map((item) => {
    const ts = item.createdAt ? new Date(item.createdAt).toLocaleString() : '-';
    const severityColor = item.severity === 'warn' ? 'var(--warning, #FEB019)' : 'var(--accent-primary)';
    const rewriteKind = item.queryRewriteKind || (item.rewritten ? 'rewritten' : 'none');
    const rewriteBadge = rewriteKind && rewriteKind !== 'none'
      ? `<span class="event-type-badge" title="Safe rewrite classification">${escapeHtml(rewriteKind)}</span>`
      : '';
    const candidateIds = (item.candidateEventIds || []).slice(0, 3)
      .map((id) => `<span class="event-type-badge">${escapeHtml((id || '').slice(0, 8))}...</span>`)
      .join(' ');
    const selectedIds = (item.selectedEventIds || []).slice(0, 3)
      .map((id) => `<span class="event-type-badge">${escapeHtml((id || '').slice(0, 8))}...</span>`)
      .join(' ');
    const strategy = normalizeRetrievalTraceStrategyLabel(item.strategy);
    return `
      <div class="shared-item" style="align-items:flex-start; border-left:2px solid ${severityColor};">
        <div class="shared-info" style="align-items:flex-start; flex-direction:column; gap:4px;">
          <span style="font-size:12px; color:var(--text-secondary);"><strong>${escapeHtml(item.title || 'Retrieval trace needs review')}</strong></span>
          <span style="font-size:11px; color:var(--text-muted);">Trace ${escapeHtml((item.traceId || '').slice(0, 18))} · ${ts} · reason=${escapeHtml(item.reason || 'unknown')} · strategy=${escapeHtml(strategy)} ${rewriteBadge}</span>
          <span style="font-size:11px; color:var(--text-muted);">${escapeHtml(item.detail || '')}</span>
          <span style="font-size:11px; color:var(--text-secondary);"><strong>Action:</strong> ${escapeHtml(item.action || '')}</span>
          <span style="font-size:11px; color:var(--text-muted);">candidates: ${candidateIds || '-'} · selected: ${selectedIds || '-'}</span>
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px; min-width:68px;">
          <span style="font-size:13px; font-weight:600; color:${severityColor};">${Number(item.selectedCount || 0)}/${Number(item.candidateCount || 0)}</span>
          <span style="font-size:10px; color:var(--text-muted);">sel/cand</span>
        </div>
      </div>
    `;
  }).join('');
}

const SAFE_RETRIEVAL_TRACE_STRATEGIES = new Set([
  'auto',
  'deep',
  'fast',
  'hybrid',
  'keyword',
  'semantic',
  'mcp-context-pack',
  'session-start-hook',
  'unknown'
]);

function normalizeRetrievalTraceStrategyLabel(value) {
  const normalized = String(value || 'unknown').trim().toLowerCase();
  return SAFE_RETRIEVAL_TRACE_STRATEGIES.has(normalized) ? normalized : 'unknown';
}

function updateRetrievalTraceUI() {
  updateRetrievalReviewQueueUI();
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
  const strategyBreakdown = Array.isArray(stats.strategyBreakdown) ? stats.strategyBreakdown.slice(0, 4) : [];
  const strategyBreakdownHtml = strategyBreakdown.length > 0
    ? `<div style="display:flex; gap:8px; flex-wrap:wrap; font-size:11px; margin-top:8px; color:var(--text-muted);">
        ${strategyBreakdown.map((row) => {
          const strategy = normalizeRetrievalTraceStrategyLabel(row.strategy);
          const queries = Number(row.totalQueries || 0);
          const yieldRate = (Number(row.queryYieldRate || 0) * 100).toFixed(1);
          const selRate = (Number(row.selectionRate || 0) * 100).toFixed(1);
          return `<span class="event-type-badge" title="${escapeHtml(selRate)}% selected memories/candidates">${escapeHtml(strategy)} · ${formatNumber(queries)} queries · ${escapeHtml(yieldRate)}% yield</span>`;
        }).join('')}
      </div>`
    : '';
  summaryEl.innerHTML = `
    <div style="display:flex; gap:14px; flex-wrap:wrap; font-size:12px;">
      <span><strong>${formatNumber(stats.totalQueries)}</strong> queries</span>
      <span><strong>${Number(stats.avgCandidateCount || 0).toFixed(1)}</strong> avg candidates</span>
      <span><strong>${Number(stats.avgSelectedCount || 0).toFixed(1)}</strong> avg selected</span>
      <span><strong>${selectionRate}%</strong> selection rate</span>
      <span title="Share of retrieval queries enriched with previous prompt/assistant context"><strong>${rewriteRate}%</strong> rewrite rate</span>
    </div>
    ${strategyBreakdownHtml}
  `;

  listEl.innerHTML = traces.slice(0, 8).map((t) => {
    const ts = t.createdAt ? new Date(t.createdAt).toLocaleString() : '-';
    const confidence = t.confidence || 'n/a';
    const strategy = normalizeRetrievalTraceStrategyLabel(t.strategy);
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
          return `<span class="event-type-badge" style="cursor:pointer;" onclick="openDetailModal(${jsAttrArg(d.eventId || '')})" title="${escapeHtml(breakdown)}">${escapeHtml((d.eventId || '').slice(0, 8))}...</span>`;
        }).join(' ')
      : ((t.selectedEventIds || []).slice(0, 2).map((id) => `<span class="event-type-badge" style="cursor:pointer;" onclick="openDetailModal(${jsAttrArg(id || '')})">${escapeHtml((id || '').slice(0, 8))}...</span>`).join(' ') || '-');

    const scoreBreakdownHtml = selectedDetails.length > 0
      ? selectedDetails.map((d) => `<div style="font-size:10px; color:var(--text-muted);">${escapeHtml((d.eventId || '').slice(0, 8))}... → score ${Number(d.score || 0).toFixed(3)} (s ${Number(d.semanticScore || 0).toFixed(3)}, l ${Number(d.lexicalScore || 0).toFixed(3)}, r ${Number(d.recencyScore || 0).toFixed(3)})</div>`).join('')
      : '';

    return `
      <div class="shared-item" style="align-items:flex-start;">
        <div class="shared-info" style="align-items:flex-start; flex-direction:column; gap:4px;">
          <span style="font-size:12px; color:var(--text-secondary);"><strong>Trace:</strong> ${escapeHtml((t.traceId || '').slice(0, 12)) || '-'}</span>
          <span style="font-size:11px; color:var(--text-muted);">${ts} · strategy=${escapeHtml(strategy)} · conf=${escapeHtml(confidence)} ${rewriteBadge}</span>
          <span style="font-size:11px; color:var(--text-muted);">selected IDs: ${selectedIdsHtml}</span>
          <span style="font-size:11px; color:var(--text-muted);">candidates: ${candidateDetails.map((d) => `<span class=\"event-type-badge\" style=\"cursor:pointer;\" onclick=\"openDetailModal(${jsAttrArg(d.eventId || '')})\">${escapeHtml((d.eventId || '').slice(0, 8))}...</span>`).join(' ') || '-'}</span>
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

