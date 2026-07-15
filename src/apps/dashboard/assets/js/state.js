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
  perspectiveStats: null,
  vectorHealth: null,
  projectDetail: null,
  projectDetailProject: null,
  vectorHealthRecovery: null,
  vectorHealthRecoveryProject: null,
  isVectorRecoveryRunning: false,
  adherenceSummary: null,
  adherenceWindow: '24h',
  userPromptSearchQuery: '',
  userPromptItems: [],
  userPromptPage: 1,
  userPromptPageSize: 30,
  sessionInspectorSessions: [],
  sessionInspectorPage: 1,
  sessionInspectorPageSize: 50,
  selectedSession: null,
  selectedSessionTurns: [],
  selectedSessionEvents: [],
  sessionSnapshotTab: 'overview',
  sessionJumpEventId: null,
  pendingSessionJump: null,
  sessionInspectorRequestId: 0,
  sessionDetailRequestId: 0,
  isSessionInspectorLoading: false,
  isSessionDetailLoading: false,
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
  disclosureQuery: '',
  disclosureSelectedId: null,
  disclosureExpansion: null,
  disclosureSource: null,
  isDisclosureLoading: false,
  playgroundLastRun: null,
  isPlaygroundLoading: false,
  usefulnessWindow: '7d',
  usefulnessHistory: [],
  usefulnessHistoryOffset: 0,
  usefulnessHistoryHasMore: false,
  usefulnessHistoryFilter: true,
  isUsefulnessHistoryLoading: false
};

// Utils
const formatNumber = (num) => new Intl.NumberFormat().format(num || 0);

function eventTypeBadgeClass(type) {
  const token = String(type || 'unknown')
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
  return `type-${token}`;
}

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

