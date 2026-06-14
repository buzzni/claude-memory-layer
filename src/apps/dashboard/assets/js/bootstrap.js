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

    const savedProject = window.localStorage?.getItem('cml.dashboard.project') || '';
    if (!state.currentProject && savedProject && state.projects.some(p => p.hash === savedProject)) {
      state.currentProject = savedProject;
      select.value = savedProject;
    }
    updateProjectScopeUI();
  } catch (error) {
    console.error('Failed to load projects:', error);
    updateProjectScopeUI();
  }
}

function updateProjectScopeUI() {
  const label = document.getElementById('scope-context-label');
  const detail = document.getElementById('scope-context-detail');
  const disclosureBadge = document.getElementById('disclosure-scope-badge');
  const empty = document.getElementById('global-empty-state');
  const project = state.currentProject ? state.projects.find(p => p.hash === state.currentProject) : null;
  const eventCount = state.stats?.storage?.eventCount || 0;
  const sessionCount = state.stats?.sessions?.total || 0;
  const vectorCount = state.stats?.storage?.vectorCount || 0;

  if (project) {
    if (label) label.textContent = `Scope: ${project.projectName}`;
    if (detail) detail.textContent = `Project-local memory · ${project.dbSizeHuman || project.hash}`;
    if (disclosureBadge) disclosureBadge.textContent = `Search → Expand → Source · Project-local: ${project.projectName}`;
    if (empty) empty.hidden = true;
    return;
  }

  if (label) label.textContent = 'Scope: All projects';
  if (detail) detail.textContent = 'Global aggregate view. Select a project for live project-local sessions and retrieval evidence.';
  if (disclosureBadge) disclosureBadge.textContent = 'Search → Expand → Source · Global scope unless a project is selected';
  if (empty) empty.hidden = !(eventCount === 0 && sessionCount === 0 && vectorCount === 0);
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
  document.querySelectorAll('.sort-btn[data-sort]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sort = e.currentTarget.dataset.sort;
      if (sort) selectSort(sort);
    });
  });

  // Adherence window controls
  document.querySelectorAll('#adherence-window-controls .sort-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const window = e.currentTarget.dataset.adhWindow;
      if (!window || state.adherenceWindow === window) return;
      state.adherenceWindow = window;
      document.querySelectorAll('#adherence-window-controls .sort-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.adhWindow === window);
      });
      state.adherenceSummary = await fetchAdherenceSummary().catch(() => null);
      updateAdherenceSummaryUI();
    });
  });

  // KPI window controls
  document.querySelectorAll('.sort-btn[data-kpi-window]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const window = e.currentTarget.dataset.kpiWindow;
      if (!window || state.kpiWindow === window) return;
      state.kpiWindow = window;
      document.querySelectorAll('.sort-btn[data-kpi-window]').forEach(b => {
        b.classList.toggle('active', b.dataset.kpiWindow === window);
      });
      await loadKpiData();
      await loadMemoryUsefulnessData();
      await loadOperationsStatsData();
      await loadPerspectiveStatsData();
      updateKpiCardsUI();
      updateMemoryUsefulnessUI();
      updateOperationsStatsUI();
      updatePerspectiveStatsUI();
      renderKpiTrendChart();
    });
  });

  // Search
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', debounce((e) => handleSearch(e.target.value), 300));
  }

  // User prompt search
  const userPromptSearch = document.getElementById('user-prompt-search');
  if (userPromptSearch) {
    userPromptSearch.addEventListener('input', debounce(async (e) => {
      state.userPromptSearchQuery = e.target.value || '';
      state.userPromptPage = 1;
      await loadUserPromptsView();
    }, 250));
  }
  const userPromptRefresh = document.getElementById('user-prompt-refresh');
  if (userPromptRefresh) {
    userPromptRefresh.addEventListener('click', async () => {
      await loadUserPromptsView();
    });
  }

  const sessionRefresh = document.getElementById('session-refresh');
  if (sessionRefresh) {
    sessionRefresh.addEventListener('click', async () => {
      await loadSessionInspectorView();
    });
  }
  document.querySelectorAll('#session-snapshot-tabs .sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setSessionSnapshotTab(btn.dataset.sessionSnapshotTab || 'overview');
    });
  });

  const userPromptPrev = document.getElementById('user-prompt-prev');
  if (userPromptPrev) {
    userPromptPrev.addEventListener('click', async () => {
      if (state.userPromptPage <= 1) return;
      state.userPromptPage -= 1;
      await renderUserPromptList();
    });
  }
  const userPromptNext = document.getElementById('user-prompt-next');
  if (userPromptNext) {
    userPromptNext.addEventListener('click', async () => {
      const totalPages = Math.max(1, Math.ceil((state.userPromptItems?.length || 0) / state.userPromptPageSize));
      if (state.userPromptPage >= totalPages) return;
      state.userPromptPage += 1;
      await renderUserPromptList();
    });
  }

  // Project selector
  const projectSelect = document.getElementById('project-select');
  if (projectSelect) {
    projectSelect.addEventListener('change', async (e) => {
      state.currentProject = e.target.value;
      if (window.localStorage) window.localStorage.setItem('cml.dashboard.project', state.currentProject || '');
      updateProjectScopeUI();
      await refreshData();
      if (state.chartInstance) {
        state.chartInstance.destroy();
        state.chartInstance = null;
      }
      if (state.kpiChartInstance) {
        state.kpiChartInstance.destroy();
        state.kpiChartInstance = null;
      }
      await initActivityChart();
      // Reload current view if not overview
      if (state.currentView !== 'overview') {
        await switchView(state.currentView, { forceReload: true });
      }
      updateChatProjectScope();
      updateProjectScopeUI();
    });
  }

  // Refresh
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshData);
  }

  const vectorHealthRecoverBtn = document.getElementById('vector-health-recover-btn');
  if (vectorHealthRecoverBtn) {
    vectorHealthRecoverBtn.addEventListener('click', recoverVectorHealth);
  }

  const playgroundRunBtn = document.getElementById('playground-run-btn');
  if (playgroundRunBtn) {
    playgroundRunBtn.addEventListener('click', runPlaygroundDryRun);
  }
  const playgroundQuery = document.getElementById('playground-query');
  if (playgroundQuery) {
    playgroundQuery.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runPlaygroundDryRun();
      }
    });
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
      if (state.isChatOpen) {
        closeChatPanel();
      } else {
        closeAllModals();
      }
    }
  });

  // Chat panel
  const chatToggle = document.getElementById('chat-toggle-btn');
  if (chatToggle) {
    chatToggle.addEventListener('click', toggleChatPanel);
  }
  const chatClose = document.getElementById('chat-close-btn');
  if (chatClose) {
    chatClose.addEventListener('click', () => closeChatPanel());
  }

  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('chat-send-btn');
  if (chatInput) {
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
      chatSendBtn.disabled = !chatInput.value.trim() || state.isChatStreaming;
    });
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (chatInput.value.trim() && !state.isChatStreaming) {
          sendChatMessage();
        }
      }
    });
  }
  if (chatSendBtn) {
    chatSendBtn.addEventListener('click', () => {
      if (!state.isChatStreaming) sendChatMessage();
    });
  }

  // Chat tabs
  document.querySelectorAll('.chat-header-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchChatTab(tab.dataset.chatTab);
    });
  });

  // New conversation button
  const chatNewBtn = document.getElementById('chat-new-btn');
  if (chatNewBtn) {
    chatNewBtn.addEventListener('click', startNewConversation);
  }

  setupDisclosureSearchListeners();
}

// --- Data Fetching ---

