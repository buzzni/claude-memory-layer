function loadChatHistory() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveChatHistory(conversations) {
  try {
    // Keep last 50 conversations max
    const trimmed = conversations.slice(-50);
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(trimmed));
  } catch { /* storage full or unavailable */ }
}

function saveCurrentConversation() {
  if (state.chatMessages.length === 0) return;
  const conversations = loadChatHistory();
  const firstUserMsg = state.chatMessages.find(m => m.role === 'user');
  const title = firstUserMsg ? firstUserMsg.content.slice(0, 80) : 'Untitled';

  if (state.chatConversationId) {
    // Update existing
    const idx = conversations.findIndex(c => c.id === state.chatConversationId);
    if (idx >= 0) {
      conversations[idx].messages = [...state.chatMessages];
      conversations[idx].updatedAt = new Date().toISOString();
      conversations[idx].title = title;
    }
  } else {
    // Create new
    state.chatConversationId = 'chat-' + Date.now();
    conversations.push({
      id: state.chatConversationId,
      title,
      messages: [...state.chatMessages],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      project: state.currentProject || 'global'
    });
  }
  saveChatHistory(conversations);
}

function startNewConversation() {
  saveCurrentConversation();
  state.chatMessages = [];
  state.chatConversationId = null;

  const container = document.getElementById('chat-messages');
  container.innerHTML = `
    <div class="chat-welcome">
      <div class="chat-welcome-icon">🧠</div>
      <div class="chat-welcome-title">Ask about your memories</div>
      <div class="chat-welcome-text">
        I can search through your coding sessions, tool usage, and stored knowledge to answer questions.
      </div>
    </div>
  `;
  switchChatTab('chat');
}

function loadConversation(id) {
  const conversations = loadChatHistory();
  const conv = conversations.find(c => c.id === id);
  if (!conv) return;

  // Save current first
  if (state.chatMessages.length > 0 && state.chatConversationId !== id) {
    saveCurrentConversation();
  }

  state.chatConversationId = conv.id;
  state.chatMessages = [...conv.messages];

  // Render messages
  const container = document.getElementById('chat-messages');
  container.innerHTML = '';
  for (const msg of conv.messages) {
    appendChatMessage(msg.role, msg.content);
  }

  switchChatTab('chat');
}

function deleteConversation(id, evt) {
  evt.stopPropagation();
  const conversations = loadChatHistory().filter(c => c.id !== id);
  saveChatHistory(conversations);
  if (state.chatConversationId === id) {
    state.chatMessages = [];
    state.chatConversationId = null;
    const container = document.getElementById('chat-messages');
    container.innerHTML = `
      <div class="chat-welcome">
        <div class="chat-welcome-icon">🧠</div>
        <div class="chat-welcome-title">Ask about your memories</div>
        <div class="chat-welcome-text">
          I can search through your coding sessions, tool usage, and stored knowledge to answer questions.
        </div>
      </div>
    `;
  }
  renderHistoryList();
}

function renderHistoryList() {
  const container = document.getElementById('chat-history-view');
  const conversations = loadChatHistory().reverse(); // newest first

  if (conversations.length === 0) {
    container.innerHTML = '<div class="chat-history-empty">No conversation history yet.</div>';
    return;
  }

  container.innerHTML = conversations.map(conv => {
    const date = new Date(conv.updatedAt || conv.createdAt);
    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const msgCount = conv.messages.length;
    const isActive = conv.id === state.chatConversationId;
    return `
      <div class="chat-history-item${isActive ? ' active' : ''}" onclick="loadConversation('${conv.id}')"
           style="${isActive ? 'border-color:var(--accent-primary);background:rgba(123,97,255,0.08);' : ''}">
        <div class="chat-history-item-title">${escapeHtml(conv.title)}</div>
        <div class="chat-history-item-meta">
          <span>${dateStr} &middot; ${msgCount} messages</span>
          <button class="chat-history-item-delete" onclick="deleteConversation('${conv.id}', event)" title="Delete">
            <i class="ri-delete-bin-line"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function switchChatTab(tab) {
  const msgContainer = document.getElementById('chat-messages');
  const historyContainer = document.getElementById('chat-history-view');
  const inputArea = document.querySelector('.chat-input-area');

  document.querySelectorAll('.chat-header-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.chatTab === tab);
  });

  if (tab === 'chat') {
    msgContainer.classList.remove('hidden');
    historyContainer.classList.remove('active');
    if (inputArea) inputArea.style.display = '';
  } else {
    msgContainer.classList.add('hidden');
    historyContainer.classList.add('active');
    if (inputArea) inputArea.style.display = 'none';
    renderHistoryList();
  }

  state.chatCurrentTab = tab;
}

function toggleChatPanel() {
  if (state.isChatOpen) {
    closeChatPanel();
  } else {
    openChatPanel();
  }
}

function openChatPanel() {
  const panel = document.getElementById('chat-panel');
  if (panel) {
    panel.classList.add('open');
    state.isChatOpen = true;
    updateChatProjectScope();
    setTimeout(() => {
      document.getElementById('chat-input')?.focus();
    }, 300);
  }
}

function closeChatPanel() {
  const panel = document.getElementById('chat-panel');
  if (panel) {
    panel.classList.remove('open');
    state.isChatOpen = false;
  }
  if (state.chatAbortController) {
    state.chatAbortController.abort();
    state.chatAbortController = null;
    state.isChatStreaming = false;
  }
  // Auto-save on close
  saveCurrentConversation();
}

function updateChatProjectScope() {
  const el = document.getElementById('chat-project-scope');
  if (!el) return;
  if (state.currentProject) {
    const proj = state.projects.find(p => p.hash === state.currentProject);
    el.textContent = `Scope: ${proj?.projectName || state.currentProject}`;
  } else {
    el.textContent = 'Scope: All (Global)';
  }
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;

  const memoryOnlyCommand = /^\/memory\s+/i.test(message);
  const requestMessage = memoryOnlyCommand ? message.replace(/^\/memory\s+/i, '').trim() : message;
  if (!requestMessage) return;

  input.value = '';
  input.style.height = 'auto';
  document.getElementById('chat-send-btn').disabled = true;

  // Add user message
  state.chatMessages.push({ role: 'user', content: message });
  appendChatMessage('user', message);

  // Remove welcome
  const welcome = document.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  // Show loading
  const loadingEl = appendChatLoading();

  state.isChatStreaming = true;
  state.chatAbortController = new AbortController();

  try {
    const response = await fetch(apiUrl(`${API_BASE}/chat`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: requestMessage,
        history: state.chatMessages.slice(-10),
        mode: memoryOnlyCommand ? 'memory-only' : 'assistant'
      }),
      signal: state.chatAbortController.signal
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(err.error || `Request failed: ${response.status}`);
    }

    loadingEl.remove();
    const msgEl = appendChatMessage('assistant', '', true);
    let fullContent = '';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let pendingEvent = 'message';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          pendingEvent = line.slice(7).trim() || 'message';
          continue;
        }

        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6);
          try {
            const data = JSON.parse(dataStr);
            if (pendingEvent === 'diagnostic' && data.mode === 'memory-only') {
              fullContent += `\n\n> Memory-only mode: Claude provider ${data.status || 'skipped'}; showing ${data.retrievedMemories || 0} retrieved memories.\n\n`;
              updateChatMessageContent(msgEl, fullContent);
            } else if (pendingEvent === 'provider_error') {
              fullContent += `\n\n> Provider diagnostic (${data.code || 'error'}): ${data.message || 'falling back to memory-only context'}\n\n`;
              updateChatMessageContent(msgEl, fullContent);
            } else if (data.content) {
              fullContent += data.content;
              updateChatMessageContent(msgEl, fullContent);
              scrollChatToBottom();
            }
            if (data.error) {
              fullContent += `\n\n**Error:** ${data.error}`;
              updateChatMessageContent(msgEl, fullContent);
            }
          } catch { /* skip */ }
          pendingEvent = 'message';
        }
      }
    }

    msgEl.classList.remove('streaming');
    if (fullContent) {
      state.chatMessages.push({ role: 'assistant', content: fullContent });
    }

    // Auto-save after each response
    saveCurrentConversation();

  } catch (err) {
    if (loadingEl.parentNode) loadingEl.remove();
    if (err.name !== 'AbortError') {
      appendChatMessage('assistant',
        `**Error:** ${err.message}\n\nMake sure the Claude CLI is installed and authenticated.`
      );
    }
  } finally {
    state.isChatStreaming = false;
    state.chatAbortController = null;
    const sendBtn = document.getElementById('chat-send-btn');
    const chatInput = document.getElementById('chat-input');
    if (sendBtn && chatInput) {
      sendBtn.disabled = !chatInput.value.trim();
    }
  }
}

function appendChatMessage(role, content, streaming = false) {
  const container = document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.className = `chat-msg ${role}${streaming ? ' streaming' : ''}`;

  if (role === 'assistant') {
    el.innerHTML = renderMarkdown(content);
  } else {
    el.textContent = content;
  }

  container.appendChild(el);
  scrollChatToBottom();
  return el;
}

function appendChatLoading() {
  const container = document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.className = 'chat-loading';
  el.innerHTML = `
    <div class="chat-loading-dot"></div>
    <div class="chat-loading-dot"></div>
    <div class="chat-loading-dot"></div>
  `;
  container.appendChild(el);
  scrollChatToBottom();
  return el;
}

function updateChatMessageContent(el, content) {
  el.innerHTML = renderMarkdown(content);
}

function scrollChatToBottom() {
  const container = document.getElementById('chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

function renderMarkdown(text) {
  if (!text) return '';

  let html = escapeHtml(text);

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<div style="font-weight:600;color:var(--text-primary);margin:12px 0 4px;">$1</div>');
  html = html.replace(/^## (.+)$/gm, '<div style="font-size:15px;font-weight:600;color:var(--text-primary);margin:12px 0 4px;">$1</div>');

  // Lists
  html = html.replace(/^- (.+)$/gm, '<div style="padding-left:16px;">&#8226; $1</div>');

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}

