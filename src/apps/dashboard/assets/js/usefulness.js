/**
 * Usefulness view — memory usefulness score, helpfulness distribution, and
 * the per-question evidence history (question → injected memories → answer
 * snippets that prove the memory was used).
 * Also hosts the Diagnostics view loader (vector health, operations,
 * perspective aggregates moved off the Overview page).
 */

const USEFULNESS_HISTORY_PAGE_SIZE = 20;

// --- Usefulness view ---

async function loadUsefulnessView() {
  state.usefulnessHistoryOffset = 0;
  state.usefulnessHistory = [];

  const [memoryUsefulness, helpfulness, retrievalTraces, retrievalReviewQueue, mostAccessed, adherenceSummary] = await Promise.all([
    fetch(apiUrl(`${API_BASE}/stats/usefulness`, { window: state.usefulnessWindow || '7d' })).then(r => r.json()).catch(() => null),
    fetch(apiUrl(`${API_BASE}/stats/helpfulness`, { limit: 5 })).then(r => r.json()).catch(() => null),
    fetch(apiUrl(`${API_BASE}/stats/retrieval-traces`, { limit: 20 })).then(r => r.json()).catch(() => null),
    fetch(apiUrl(`${API_BASE}/stats/retrieval-review-queue`, { limit: 10 })).then(r => r.json()).catch(() => null),
    fetch(apiUrl(`${API_BASE}/stats/most-accessed`, { limit: 10 })).then(r => r.json()).catch(() => null),
    fetchAdherenceSummary().catch(() => null)
  ]);

  state.memoryUsefulness = memoryUsefulness;
  state.helpfulness = helpfulness;
  state.retrievalTraces = retrievalTraces;
  state.retrievalReviewQueue = retrievalReviewQueue;
  state.mostAccessed = mostAccessed;
  state.adherenceSummary = adherenceSummary;

  updateMemoryUsefulnessUI();
  updateHelpfulnessUI();
  updateMostHelpfulList();
  updateTopAccessedEventsUI();
  updateAdherenceSummaryUI();
  updateRetrievalTraceUI();

  await loadUsefulnessHistory({ reset: true });
}

async function loadUsefulnessHistory(options = {}) {
  const reset = Boolean(options.reset);
  if (state.isUsefulnessHistoryLoading) return;
  state.isUsefulnessHistoryLoading = true;

  const listEl = document.getElementById('usefulness-history-list');
  const loadMoreBtn = document.getElementById('usefulness-history-load-more');
  if (reset) {
    state.usefulnessHistoryOffset = 0;
    state.usefulnessHistory = [];
    if (listEl) listEl.innerHTML = '<div class="disclosure-empty">Loading evidence history...</div>';
  }

  try {
    const res = await fetch(apiUrl(`${API_BASE}/stats/usefulness-history`, {
      limit: USEFULNESS_HISTORY_PAGE_SIZE,
      offset: state.usefulnessHistoryOffset,
      withSelectionsOnly: state.usefulnessHistoryFilter ? 'true' : 'false'
    }));
    const data = await res.json();
    const entries = data.entries || [];

    state.usefulnessHistory = state.usefulnessHistory.concat(entries);
    state.usefulnessHistoryOffset += entries.length;
    state.usefulnessHistoryHasMore = Boolean(data.hasMore) && entries.length > 0;
  } catch (error) {
    console.error('Failed to load usefulness history:', error);
    state.usefulnessHistoryHasMore = false;
  } finally {
    state.isUsefulnessHistoryLoading = false;
  }

  renderUsefulnessHistory();
  if (loadMoreBtn) loadMoreBtn.hidden = !state.usefulnessHistoryHasMore;
}

function usefulnessScoreBadge(score) {
  if (score === null || score === undefined) {
    return '<span class="evidence-score score-pending" title="Measured automatically at session end">pending</span>';
  }
  const cls = score >= 0.7 ? 'score-high' : score >= 0.4 ? 'score-mid' : 'score-low';
  return `<span class="evidence-score ${cls}">${(score * 100).toFixed(0)}%</span>`;
}

function groundingBadge(score) {
  if (score === null || score === undefined) return '';
  const cls = score >= 0.5 ? 'score-high' : score >= 0.3 ? 'score-mid' : 'score-low';
  return `<span class="evidence-score ${cls}" title="How much of this memory was reused in the answer">grounding ${(score * 100).toFixed(0)}%</span>`;
}

function renderUsefulnessHistory() {
  const listEl = document.getElementById('usefulness-history-list');
  if (!listEl) return;

  const entries = state.usefulnessHistory || [];
  if (entries.length === 0) {
    listEl.innerHTML = `
      <div class="disclosure-empty">
        No retrieval history yet. Evidence appears here after memories are injected
        into prompts and the session ends (helpfulness is measured at session end).
      </div>`;
    return;
  }

  listEl.innerHTML = entries.map((entry, index) => {
    const time = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '';
    const isSessionStart = entry.kind === 'session_start';
    const icon = isSessionStart ? 'ri-restart-line' : 'ri-question-line';
    const memories = entry.memories || [];
    const measured = memories.filter(m => m.helpfulnessScore !== null && m.helpfulnessScore !== undefined);
    const grounded = memories.filter(m => (m.contentOverlapScore || 0) >= 0.3);
    const bestScore = measured.length > 0 ? Math.max(...measured.map(m => m.helpfulnessScore)) : null;

    const statusChips = [
      `<span class="evidence-chip">${memories.length} injected</span>`,
      grounded.length > 0
        ? `<span class="evidence-chip chip-grounded"><i class="ri-double-quotes-l"></i> ${grounded.length} used in answer</span>`
        : (measured.length > 0 ? '<span class="evidence-chip chip-unused">not reused in answer</span>' : '<span class="evidence-chip">awaiting evaluation</span>'),
      entry.confidence ? `<span class="evidence-chip">${escapeHtml(entry.confidence)}</span>` : ''
    ].join('');

    const memoriesHtml = memories.length === 0
      ? ((entry.selectedCount || 0) > 0
        ? `<div class="evidence-memory-empty">${entry.selectedCount} memories were selected, but per-memory tracking is unavailable for this query (automatic retrieval or pre-upgrade data).</div>`
        : '<div class="evidence-memory-empty">No memories were injected for this question.</div>')
      : memories.map(m => {
        const evidence = m.evidence || [];
        const evidenceHtml = evidence.length === 0
          ? ''
          : `<div class="evidence-matches">
              ${evidence.slice(0, 3).map(match => `
                <div class="evidence-match">
                  <div class="evidence-match-row">
                    <span class="evidence-match-label"><i class="ri-brain-line"></i> memory</span>
                    <span class="evidence-match-text">${escapeHtml(match.memorySnippet || '')}</span>
                  </div>
                  <div class="evidence-match-row">
                    <span class="evidence-match-label answer"><i class="ri-chat-4-line"></i> answer</span>
                    <span class="evidence-match-text">${escapeHtml(match.responseSnippet || '')}</span>
                  </div>
                  <div class="evidence-match-meta">${escapeHtml(match.matchType || '')} · ${((match.similarity || 0) * 100).toFixed(0)}% similar</div>
                </div>
              `).join('')}
            </div>`;
        return `
          <div class="evidence-memory">
            <div class="evidence-memory-header">
              <span class="evidence-memory-summary" onclick="openDetailModalByEvent(${jsAttrArg(m.eventId)})" title="Open memory detail">
                ${escapeHtml(m.summary || '(no summary)')}
              </span>
              <span class="evidence-memory-scores">
                ${groundingBadge(m.contentOverlapScore)}
                ${usefulnessScoreBadge(m.helpfulnessScore)}
              </span>
            </div>
            ${evidenceHtml}
          </div>
        `;
      }).join('');

    return `
      <div class="evidence-entry${bestScore !== null && bestScore >= 0.7 ? ' entry-helpful' : ''}" data-evidence-index="${index}">
        <div class="evidence-entry-header" onclick="toggleUsefulnessEntry(${index})">
          <i class="${icon} evidence-entry-icon"></i>
          <div class="evidence-entry-question">
            ${escapeHtml(entry.question || '(no question text)')}
            <div class="evidence-entry-meta">${escapeHtml(time)}${entry.strategy ? ` · ${escapeHtml(entry.strategy)}` : ''}${entry.sessionId ? ` · session ${escapeHtml(String(entry.sessionId).slice(0, 8))}` : ''}</div>
          </div>
          <div class="evidence-entry-chips">${statusChips}</div>
          <i class="ri-arrow-down-s-line evidence-entry-caret"></i>
        </div>
        <div class="evidence-entry-body" hidden>
          ${memoriesHtml}
        </div>
      </div>
    `;
  }).join('');
}

function toggleUsefulnessEntry(index) {
  const entry = document.querySelector(`.evidence-entry[data-evidence-index="${index}"]`);
  if (!entry) return;
  const body = entry.querySelector('.evidence-entry-body');
  const caret = entry.querySelector('.evidence-entry-caret');
  if (!body) return;
  body.hidden = !body.hidden;
  if (caret) caret.classList.toggle('open', !body.hidden);
}

// --- Overview usefulness strip (compact hero on the Overview page) ---

function updateOverviewUsefulnessStrip() {
  const scoreEl = document.getElementById('overview-usefulness-score');
  const noteEl = document.getElementById('overview-usefulness-note');
  const metricsEl = document.getElementById('overview-usefulness-metrics');
  if (!scoreEl || !noteEl) return;

  const payload = state.memoryUsefulness;
  if (!payload || payload.error || !payload.score) {
    scoreEl.textContent = '-';
    scoreEl.className = 'memory-usefulness-score score-unknown';
    noteEl.textContent = 'No usefulness telemetry yet — inject some memories first.';
    if (metricsEl) metricsEl.innerHTML = '';
    return;
  }

  const score = payload.score || {};
  const metrics = payload.metrics || {};
  const counts = payload.counts || {};
  const label = score.label || 'unknown';
  scoreEl.textContent = Number(score.value || 0).toFixed(1).replace(/\.0$/, '');
  scoreEl.className = `memory-usefulness-score score-${label}`;

  const topDiagnostic = (payload.diagnostics || [])[0];
  noteEl.textContent = topDiagnostic
    ? topDiagnostic.title
    : `Memory is ${label} in the last ${payload.window || 'window'} — open Usefulness for per-question evidence.`;

  if (metricsEl) {
    const pct = (v) => v === undefined || v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`;
    metricsEl.innerHTML = `
      <span title="Average of measured helpfulness scores"><strong>${pct(metrics.avgHelpfulnessScore)}</strong> helpfulness</span>
      <span title="How much injected memory content reappears in answers"><strong>${pct(metrics.contentGroundingRate)}</strong> grounding</span>
      <span title="Share of prompts that ran a memory check"><strong>${pct(metrics.memoryHitRate)}</strong> hit rate</span>
      <span><strong>${formatNumber(counts.retrievalQueries || 0)}</strong> queries</span>
    `;
  }
}

// --- Diagnostics view ---

async function loadDiagnosticsView() {
  const [operationsStats, perspectiveStats, vectorHealth] = await Promise.all([
    fetch(apiUrl(`${API_BASE}/stats/operations`, { windowDays: operationStatsWindowDays() })).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(apiUrl(`${API_BASE}/stats/perspective`, { windowDays: operationStatsWindowDays() })).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(apiUrl(`${API_BASE}/health`)).then(r => r.ok ? r.json() : null).catch(() => null)
  ]);

  state.operationsStats = operationsStats;
  state.perspectiveStats = perspectiveStats;
  state.vectorHealth = vectorHealth;

  updateOperationsStatsUI();
  updatePerspectiveStatsUI();
  updateVectorHealthUI();
}

// --- Listeners (wired once at bootstrap) ---

function setupUsefulnessViewListeners() {
  const strip = document.getElementById('overview-usefulness-strip');
  if (strip) {
    strip.addEventListener('click', () => switchView('usefulness'));
    strip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        switchView('usefulness');
      }
    });
  }

  const refreshBtn = document.getElementById('usefulness-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadUsefulnessView());
  }

  const diagnosticsRefreshBtn = document.getElementById('diagnostics-refresh');
  if (diagnosticsRefreshBtn) {
    diagnosticsRefreshBtn.addEventListener('click', () => loadDiagnosticsView());
  }

  const filterToggle = document.getElementById('usefulness-history-filter');
  if (filterToggle) {
    filterToggle.addEventListener('change', () => {
      state.usefulnessHistoryFilter = filterToggle.checked;
      loadUsefulnessHistory({ reset: true });
    });
  }

  const loadMoreBtn = document.getElementById('usefulness-history-load-more');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => loadUsefulnessHistory());
  }

  document.querySelectorAll('#usefulness-window-controls .sort-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const windowValue = btn.dataset.useWindow;
      if (!windowValue) return;
      document.querySelectorAll('#usefulness-window-controls .sort-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.useWindow === windowValue);
      });
      state.usefulnessWindow = windowValue;
      const memoryUsefulness = await fetch(apiUrl(`${API_BASE}/stats/usefulness`, { window: windowValue }))
        .then(r => r.json()).catch(() => null);
      state.memoryUsefulness = memoryUsefulness;
      updateMemoryUsefulnessUI();
    });
  });
}
