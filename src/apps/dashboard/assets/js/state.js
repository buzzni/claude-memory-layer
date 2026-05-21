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
  memoryUsefulness: null,
  retrievalTraces: null,
  retrievalReviewQueue: null,
  operationsStats: null,
  adherenceSummary: null,
  adherenceWindow: '24h',
  userPromptSearchQuery: '',
  userPromptItems: [],
  userPromptPage: 1,
  userPromptPageSize: 30,
  currentLevel: 'L0',
  currentSort: 'recent',
  currentView: 'overview',
  currentProject: '', // empty = global
  refreshRequestId: 0,
  projects: [],
  events: [],
  isLoading: false,
  chartInstance: null,
  kpiChartInstance: null,
  kpiWindow: '7d',
  kpi: null,
  chatMessages: [],
  isChatOpen: false,
  isChatStreaming: false,
  chatAbortController: null,
  chatConversationId: null,
  chatCurrentTab: 'chat',
  disclosureResults: [],
  disclosureMeta: null,
  disclosureSelectedId: null,
  disclosureExpansion: null,
  disclosureSource: null,
  isDisclosureLoading: false
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

