
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

function disclosureString(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function normalizeDisclosureEventId(value) {
  const raw = disclosureString(value);
  if (!raw) return null;
  return raw.startsWith('event:') ? raw.slice('event:'.length) : raw;
}

function getDisclosureJumpTarget(...candidates) {
  for (const candidate of candidates) {
    const target = getDisclosureJumpTargetFromCandidate(candidate);
    if (target) return target;
  }
  return null;
}

function getDisclosureJumpTargetFromCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;

  const nestedCandidates = [];
  if (candidate.primaryEvent) nestedCandidates.push(candidate.primaryEvent);
  if (candidate.rawEvent) nestedCandidates.push(candidate.rawEvent);
  if (candidate.event) nestedCandidates.push(candidate.event);
  if (Array.isArray(candidate.rawEvents)) nestedCandidates.push(...candidate.rawEvents);
  for (const nested of nestedCandidates) {
    const target = getDisclosureJumpTargetFromCandidate(nested);
    if (target) return target;
  }

  const metadata = candidate.metadata && typeof candidate.metadata === 'object' ? candidate.metadata : {};
  const sessionId = disclosureString(candidate.sessionId || metadata.sessionId);
  if (!sessionId) return null;

  const eventId = normalizeDisclosureEventId(
    candidate.eventId ||
    metadata.eventId ||
    candidate.id ||
    candidate.sourceRef ||
    (Array.isArray(candidate.eventIds) ? candidate.eventIds[0] : null)
  );
  return { sessionId, eventId };
}

function disclosureAttrArg(value) {
  if (typeof jsAttrArg === 'function') return jsAttrArg(value);
  return escapeHtml(JSON.stringify(String(value ?? '')));
}

function renderDisclosureJumpButton(target, label = 'Open in Sessions') {
  if (!target?.sessionId) return '';
  return `
    <button type="button" class="inline-action-btn disclosure-session-jump" onclick="event.stopPropagation(); jumpToSession(${disclosureAttrArg(target.sessionId)}, ${disclosureAttrArg(target.eventId || '')})">
      <i class="ri-corner-right-up-line"></i> ${escapeHtml(label)}
    </button>`;
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
  state.disclosureQuery = query;
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

  const query = state.disclosureQuery || document.getElementById('disclosure-search-input')?.value || '';
  const resultHtml = state.disclosureResults.map((r, idx) => {
    const active = r.id === state.disclosureSelectedId ? ' active' : '';
    const score = Number(r.score || 0).toFixed(3);
    const reasons = (r.reasons || []).map(reason => `<span class="disclosure-chip">${escapeHtml(reason)}</span>`).join('');
    const provenance = renderDisclosureProvenance(r.metadata, ['sourceProjectHash', 'sourceEntryId', 'topics']);
    const scope = getDisclosureScopeLabel(r);
    const jumpTarget = getDisclosureJumpTarget(r);
    const jumpButton = renderDisclosureJumpButton(jumpTarget);
    return `
      <div class="disclosure-result${active}" data-result-id="${escapeHtml(r.id)}" role="button" tabindex="0">
        <div class="disclosure-result-head">
          <span class="event-type-badge">#${idx + 1} ${escapeHtml(r.resultType || 'result')}</span>
          <span class="disclosure-scope-pill">${escapeHtml(scope)}</span>
          <span class="disclosure-score">score ${score}</span>
        </div>
        <div class="disclosure-title">${escapeHtml(r.title || r.sourceRef || r.id)}</div>
        <div class="disclosure-snippet" title="${escapeHtml(r.snippet || '(no snippet)')}">${highlightDisclosureText(r.snippet || '(no snippet)', query)}</div>
        ${provenance}
        <div class="disclosure-rank-explain"><strong>Why this ranked</strong>${reasons || '<span class="disclosure-chip">no_reason</span>'}</div>
        <div class="disclosure-result-cta"><span>Inspect evidence <i class="ri-arrow-right-line"></i></span>${jumpButton}</div>
      </div>`;
  }).join('');

  container.innerHTML = metaHtml + resultHtml;
  container.querySelectorAll('.disclosure-result').forEach(btn => {
    const openResult = () => loadDisclosureDrilldown(btn.dataset.resultId);
    btn.addEventListener('click', openResult);
    btn.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openResult();
    });
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
      <span>${escapeHtml(buildSafeDisclosurePreview(f.snippet || f.title || f.id || ''))}</span>
    </div>`).join('') || '<div class="disclosure-empty compact">No surrounding facts.</div>';

  const related = (expansion.relatedSources || []).map(s => `
    <div class="disclosure-source-ref">
      <span class="disclosure-chip">${escapeHtml(s.sourceRef)} · ${escapeHtml(s.sourceType || 'source')}</span>
      ${renderDisclosureProvenance(s.metadata, ['sourceProjectHash', 'sourceEntryId', 'topics'])}
    </div>`).join('') || '<span class="disclosure-chip">no source refs</span>';

  const rawEvent = source?.primaryEvent || source?.rawEvents?.[0] || source?.rawEvent || source?.event || null;
  const isSharedSource = source?.sourceType === 'shared_troubleshooting';
  const sourcePreview = rawEvent
    ? buildSafeSourcePreview(rawEvent)
    : isSharedSource
      ? 'No local raw events for this shared source.'
      : (source ? JSON.stringify(source, null, 2) : (message || 'Source layer returned no raw event.'));
  const sourceSafetyNote = rawEvent && hasCompactionBoilerplate(rawEvent.content || rawEvent.preview || '')
    ? '<div class="snapshot-note">Context compaction boilerplate hidden from the default evidence preview.</div>'
    : '';
  const sourceProvenance = source?.metadata
    ? renderDisclosureProvenance(source.metadata, ['sourceProjectHash', 'sourceEntryId', 'topics', 'rootCause', 'solution', 'symptoms', 'confidence', 'usageCount'])
    : '';
  const sourceProvenanceBlock = sourceProvenance
    ? `<div class="modal-section-title">${isSharedSource ? 'Shared source provenance' : 'Source metadata'}</div>${sourceProvenance}`
    : '';
  const sourceJumpButton = renderDisclosureJumpButton(
    getDisclosureJumpTarget(source, rawEvent, expansion.target),
    'Open in Sessions'
  );

  container.innerHTML = `
    <div class="disclosure-stepper" aria-label="Search → Expand → Source">
      <span class="active">1 Search result</span>
      <span class="active">2 Expanded context</span>
      <span class="active">3 Source evidence</span>
    </div>
    <div class="disclosure-layer">
      <div class="modal-section-title">Search result</div>
      <div class="modal-content-block">${escapeHtml(expansion.target?.title || expansion.target?.snippet || state.disclosureSelectedId || '')}</div>
      <div class="modal-section-title">Expanded context</div>
      <div class="modal-content-block">${escapeHtml(buildSafeDisclosurePreview(expansion.expandedContext || expansion.target?.snippet || ''))}</div>
      <div class="modal-section-title">Surrounding context</div>
      <div class="disclosure-context-list">${surrounding}</div>
      <div class="modal-section-title">Related sources</div>
      <div class="disclosure-reasons">${related}</div>
    </div>
    <div class="disclosure-layer">
      <div class="modal-section-title">Source evidence</div>
      <div class="disclosure-safe-label">Safe preview</div>
      <div class="modal-content-block">${escapeHtml(sourcePreview)}</div>
      ${sourceJumpButton}
      ${sourceSafetyNote}
      ${rawEvent ? '<button class="sort-btn" type="button" disabled title="Raw transcript and metadata are intentionally hidden in this dashboard panel.">Show raw/meta text</button>' : ''}
      ${sourceProvenanceBlock}
    </div>`;
}

function getDisclosureScopeLabel(result) {
  const id = String(result?.id || result?.sourceRef || '');
  if (id.startsWith('shared:') || String(result?.sourceRef || '').startsWith('shared:')) return 'Shared';
  if (result?.metadata?.sourceProjectHash) return 'Project-local';
  return state.currentProject ? 'Project-local' : 'Global';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightDisclosureText(value, query) {
  let html = escapeHtml(String(value || ''));
  const terms = String(query || '')
    .split(/\s+/)
    .map(term => term.trim())
    .filter(term => term.length >= 2)
    .slice(0, 5);
  for (const term of terms) {
    const escapedTerm = escapeRegExp(escapeHtml(term));
    html = html.replace(new RegExp(`(${escapedTerm})`, 'ig'), '<mark>$1</mark>');
  }
  return html;
}

function hasCompactionBoilerplate(value) {
  return /CONTEXT COMPACTION|REFERENCE ONLY/i.test(String(value || ''));
}

function buildSafeDisclosurePreview(value) {
  const text = String(value || '');
  if (!hasCompactionBoilerplate(text)) return text;
  const lines = text.split(/\r?\n/);
  const safeLines = [];
  for (const line of lines) {
    if (hasCompactionBoilerplate(line)) break;
    safeLines.push(line);
  }
  const safeText = safeLines.join('\n').trim();
  const note = '[context compaction handoff hidden from preview]';
  return safeText ? `${safeText}\n${note}` : note;
}

function buildSafeSourcePreview(rawEvent) {
  const rawContent = String(rawEvent.content || rawEvent.preview || '');
  const safeLines = rawContent
    .split(/\r?\n/)
    .filter(line => !hasCompactionBoilerplate(line))
    .slice(0, 8);
  const header = `${rawEvent.eventType || rawEvent.type || 'event'} · ${rawEvent.timestamp || ''}`;
  const body = safeLines.join('\n').slice(0, 1200);
  return `${header}\n${body || '(safe preview empty)'}`;
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
