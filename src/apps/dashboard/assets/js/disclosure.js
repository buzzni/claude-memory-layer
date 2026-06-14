
// --- Progressive Disclosure Dashboard ---

function setupDisclosureSearchListeners() {
  const input = document.getElementById('disclosure-search-input');
  const button = document.getElementById('disclosure-search-btn');
  if (button) button.addEventListener('click', handleDisclosureSearch);
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleDisclosureSearch();
      }
    });
  }
}

function renderDisclosureStatus(message, isError = false) {
  const status = document.getElementById('disclosure-status');
  if (!status) return;
  status.textContent = message || '';
  status.style.color = isError ? 'var(--error)' : 'var(--text-muted)';
}

async function handleDisclosureSearch() {
  const input = document.getElementById('disclosure-search-input');
  const query = (input?.value || '').trim();
  if (!query || state.isDisclosureLoading) return;

  const button = document.getElementById('disclosure-search-btn');
  const includeShared = document.getElementById('disclosure-include-shared')?.checked || false;
  const strategy = document.getElementById('disclosure-strategy')?.value || 'auto';
  const topK = parseInt(document.getElementById('disclosure-topk')?.value || '8', 10);

  state.isDisclosureLoading = true;
  state.disclosureResults = [];
  state.disclosureMeta = null;
  state.disclosureSelectedId = null;
  state.disclosureExpansion = null;
  state.disclosureSource = null;
  if (button) button.disabled = true;
  renderDisclosureStatus('Searching compact retrieval envelopes...');
  renderDisclosureResults();
  renderDisclosureDrilldown();

  try {
    const res = await fetch(apiUrl(`${API_BASE}/search/disclosure`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        options: {
          topK: Number.isFinite(topK) ? topK : 8,
          includeShared,
          strategy
        }
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Disclosure search failed');

    state.disclosureResults = data.results || [];
    state.disclosureMeta = data.meta || null;
    state.isDisclosureLoading = false;
    if (button) button.disabled = false;
    renderDisclosureStatus(`Search layer returned ${state.disclosureResults.length} result(s). Click a result to expand/source.`);
    renderDisclosureResults();
  } catch (error) {
    state.disclosureResults = [];
    state.isDisclosureLoading = false;
    if (button) button.disabled = false;
    renderDisclosureStatus(error.message || 'Disclosure search failed', true);
    renderDisclosureResults();
  } finally {
    state.isDisclosureLoading = false;
    if (button) button.disabled = false;
  }
}

function renderDisclosureResults() {
  const container = document.getElementById('disclosure-results');
  if (!container) return;

  if (state.isDisclosureLoading) {
    container.innerHTML = '<div class="disclosure-empty">Searching...</div>';
    return;
  }

  if (!state.disclosureResults.length) {
    container.innerHTML = '<div class="disclosure-empty">Search memory to inspect compact envelopes, expansion context, and raw sources.</div>';
    return;
  }

  const meta = state.disclosureMeta || {};
  const metaHtml = `
    <div class="disclosure-meta">
      total=${escapeHtml(String(meta.total ?? state.disclosureResults.length))}
      · vector=${meta.usedVector ? 'yes' : 'no'}
      · keyword=${meta.usedKeyword ? 'yes' : 'no'}
      · fallback=${meta.fallbackApplied ? 'yes' : 'no'}
    </div>`;

  const resultHtml = state.disclosureResults.map((r, idx) => {
    const active = r.id === state.disclosureSelectedId ? ' active' : '';
    const score = Number(r.score || 0).toFixed(3);
    const reasons = (r.reasons || []).map(reason => `<span class="disclosure-chip">${escapeHtml(reason)}</span>`).join('');
    const provenance = renderDisclosureProvenance(r.metadata, ['sourceProjectHash', 'sourceEntryId', 'topics']);
    return `
      <button class="disclosure-result${active}" data-result-id="${escapeHtml(r.id)}">
        <div class="disclosure-result-head">
          <span class="event-type-badge">#${idx + 1} ${escapeHtml(r.resultType || 'result')}</span>
          <span class="disclosure-score">score ${score}</span>
        </div>
        <div class="disclosure-title">${escapeHtml(r.title || r.sourceRef || r.id)}</div>
        <div class="disclosure-snippet">${escapeHtml(r.snippet || '(no snippet)')}</div>
        ${provenance}
        <div class="disclosure-reasons">${reasons || '<span class="disclosure-chip">no_reason</span>'}</div>
      </button>`;
  }).join('');

  container.innerHTML = metaHtml + resultHtml;
  container.querySelectorAll('.disclosure-result').forEach(btn => {
    btn.addEventListener('click', () => loadDisclosureDrilldown(btn.dataset.resultId));
  });
}

async function loadDisclosureDrilldown(resultId) {
  if (!resultId) return;
  state.disclosureSelectedId = resultId;
  state.disclosureExpansion = null;
  state.disclosureSource = null;
  renderDisclosureResults();
  renderDisclosureDrilldown(true);

  try {
    const encodedId = encodeURIComponent(resultId);
    const [expandRes, sourceRes] = await Promise.all([
      fetch(apiUrl(`${API_BASE}/search/disclosure/${encodedId}/expand`, { windowSize: 3 })),
      fetch(apiUrl(`${API_BASE}/search/disclosure/${encodedId}/source`))
    ]);
    const expansion = await expandRes.json();
    const source = await sourceRes.json();
    if (!expandRes.ok) throw new Error(expansion.error || 'Expand failed');
    state.disclosureExpansion = expansion;
    state.disclosureSource = sourceRes.ok ? source : null;
    renderDisclosureDrilldown(false, sourceRes.ok ? null : (source.error || 'Source not found'));
  } catch (error) {
    renderDisclosureDrilldown(false, error.message || 'Failed to load drilldown', true);
  }
}

function renderDisclosureDrilldown(isLoading = false, message = null, isError = false) {
  const container = document.getElementById('disclosure-drilldown');
  if (!container) return;
  if (isLoading) {
    container.innerHTML = '<div class="disclosure-empty">Loading expand/source layers...</div>';
    return;
  }
  if (message && isError) {
    container.innerHTML = `<div class="disclosure-empty" style="color:var(--error);">${escapeHtml(message)}</div>`;
    return;
  }
  if (!state.disclosureSelectedId) {
    container.innerHTML = '<div class="disclosure-empty">No result selected.</div>';
    return;
  }

  const expansion = state.disclosureExpansion;
  const source = state.disclosureSource;
  if (!expansion) {
    container.innerHTML = '<div class="disclosure-empty">Expansion not loaded yet.</div>';
    return;
  }

  const surrounding = (expansion.surroundingFacts || []).map(f => `
    <div class="disclosure-context-item">
      <span class="event-type-badge">${escapeHtml(f.resultType || 'fact')}</span>
      <span>${escapeHtml(f.snippet || f.title || f.id || '')}</span>
    </div>`).join('') || '<div class="disclosure-empty compact">No surrounding facts.</div>';

  const related = (expansion.relatedSources || []).map(s => `
    <div class="disclosure-source-ref">
      <span class="disclosure-chip">${escapeHtml(s.sourceRef)} · ${escapeHtml(s.sourceType || 'source')}</span>
      ${renderDisclosureProvenance(s.metadata, ['sourceProjectHash', 'sourceEntryId', 'topics'])}
    </div>`).join('') || '<span class="disclosure-chip">no source refs</span>';

  const rawEvent = source?.primaryEvent || source?.rawEvents?.[0] || source?.rawEvent || source?.event || null;
  const isSharedSource = source?.sourceType === 'shared_troubleshooting';
  const sourcePreview = rawEvent
    ? `${rawEvent.eventType || rawEvent.type || 'event'} · ${rawEvent.timestamp || ''}\n${rawEvent.content || rawEvent.preview || ''}`
    : isSharedSource
      ? 'No local raw events for this shared source.'
      : (source ? JSON.stringify(source, null, 2) : (message || 'Source layer returned no raw event.'));
  const sourceProvenance = source?.metadata
    ? renderDisclosureProvenance(source.metadata, ['sourceProjectHash', 'sourceEntryId', 'topics', 'rootCause', 'solution', 'symptoms', 'confidence', 'usageCount'])
    : '';
  const sourceProvenanceBlock = sourceProvenance
    ? `<div class="modal-section-title">${isSharedSource ? 'Shared source provenance' : 'Source metadata'}</div>${sourceProvenance}`
    : '';

  container.innerHTML = `
    <div class="disclosure-layer">
      <div class="modal-section-title">Expand layer</div>
      <div class="modal-content-block">${escapeHtml(expansion.expandedContext || expansion.target?.snippet || '')}</div>
      <div class="modal-section-title">Surrounding context</div>
      <div class="disclosure-context-list">${surrounding}</div>
      <div class="modal-section-title">Related sources</div>
      <div class="disclosure-reasons">${related}</div>
    </div>
    <div class="disclosure-layer">
      <div class="modal-section-title">Source layer</div>
      <div class="modal-content-block">${escapeHtml(sourcePreview)}</div>
      ${sourceProvenanceBlock}
    </div>`;
}

function renderDisclosureProvenance(metadata, allowedKeys = null) {
  if (!metadata) return '';
  const entries = Object.entries(metadata)
    .filter(([key, value]) => value !== undefined && value !== null && (!allowedKeys || allowedKeys.includes(key)));
  if (!entries.length) return '';
  return `
    <div class="disclosure-provenance">
      ${entries.map(([key, value]) => `
        <div class="disclosure-provenance-row">
          <span class="disclosure-provenance-key">${escapeHtml(key)}</span>
          <span class="disclosure-provenance-value">${escapeHtml(formatDisclosureMetadataValue(value))}</span>
        </div>`).join('')}
    </div>`;
}

function formatDisclosureMetadataValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
