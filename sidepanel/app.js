// ChromeGPT Side Panel UI

const messagesEl    = document.getElementById('messages');
const questionEl    = document.getElementById('question');
const sendBtn       = document.getElementById('send-btn');
const statusEl      = document.getElementById('status');
const settingsBtn   = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const modelInput    = document.getElementById('model');
const saveBtn       = document.getElementById('save-settings');
const connectBtn    = document.getElementById('connect-btn');
const newThreadBtn  = document.getElementById('new-thread-btn');

let port = null;
let currentAssistantEl = null;
let streaming = false;

// ---------------------------------------------------------------------------
// Port connection to background service worker
// ---------------------------------------------------------------------------

function connectPort() {
  port = chrome.runtime.connect({ name: 'sidepanel' });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'connectionState':
        setConnectionState(msg.state);
        break;
      case 'config':
        modelInput.value = msg.config.model || '';
        break;
      case 'turnStart':
        startAssistantMessage();
        break;
      case 'delta':
        appendDelta(msg.text);
        break;
      case 'turnComplete':
        finishAssistantMessage();
        break;
      case 'error':
        addMessage('error', msg.error);
        setStreaming(false);
        break;
      case 'setupRequired':
        showSetupPrompt();
        break;
      case 'toolCall':
        showToolCall(msg.tool, msg.args);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    setTimeout(connectPort, 500);
  });

  port.postMessage({ type: 'getConfig' });
  // Auto-connect when side panel opens
  port.postMessage({ type: 'connect' });
}

connectPort();

// ---------------------------------------------------------------------------
// UI state helpers
// ---------------------------------------------------------------------------

const STATE_LABELS = {
  disconnected: 'Disconnected',
  connecting:   'Connecting\u2026',
  connected:    'Connected',
  error:        'Error',
};

function setConnectionState(state) {
  statusEl.className = state;
  statusEl.textContent = STATE_LABELS[state] || state;

  const guide = document.getElementById('setup-guide');
  if (guide) {
    guide.classList.toggle('hidden', state === 'connected');
  }
}

function setStreaming(on) {
  streaming = on;
  sendBtn.disabled = on;
  questionEl.disabled = on;
}

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

function addMessage(type, text) {
  const el = document.createElement('div');
  el.className = `message ${type}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function startAssistantMessage() {
  setStreaming(true);
  currentAssistantEl = document.createElement('div');
  currentAssistantEl.className = 'message assistant';
  currentAssistantEl.innerHTML = '<span class="cursor"></span>';
  messagesEl.appendChild(currentAssistantEl);
  scrollToBottom();
}

function appendDelta(text) {
  if (!currentAssistantEl) return;
  const cursor = currentAssistantEl.querySelector('.cursor');
  if (cursor) cursor.remove();

  currentAssistantEl.appendChild(document.createTextNode(text));

  const newCursor = document.createElement('span');
  newCursor.className = 'cursor';
  currentAssistantEl.appendChild(newCursor);
  scrollToBottom();
}

function finishAssistantMessage() {
  if (currentAssistantEl) {
    const cursor = currentAssistantEl.querySelector('.cursor');
    if (cursor) cursor.remove();
  }
  currentAssistantEl = null;
  setStreaming(false);
}

// ---------------------------------------------------------------------------
// Tool-call display
// ---------------------------------------------------------------------------

const TOOL_LABELS = {
  browser_extract_page: 'Extracting page',
  browser_click:        'Clicking',
  browser_type:         'Typing',
  browser_navigate:     'Navigating',
  browser_back:         'Going back',
  browser_scroll:       'Scrolling',
  browser_select:       'Selecting',
  browser_screenshot:   'Taking screenshot',
};

function showToolCall(tool, args) {
  if (currentAssistantEl) {
    const cursor = currentAssistantEl.querySelector('.cursor');
    if (cursor) cursor.remove();
    currentAssistantEl = null;
  }

  const el = document.createElement('div');
  el.className = 'message system';

  const label = TOOL_LABELS[tool] || tool;
  const detail = formatToolArgs(tool, args);
  el.innerHTML = `<span class="action-tag">${escapeHtml(label)}${detail ? ' ' + escapeHtml(detail) : ''}</span>`;

  messagesEl.appendChild(el);
  scrollToBottom();

  startAssistantMessage();
}

function formatToolArgs(tool, args) {
  if (!args) return '';
  if (args.id != null) {
    let s = `[${args.id}]`;
    if (args.value) s += ` "${args.value}"`;
    return s;
  }
  if (args.url) return args.url;
  if (args.direction) return `${args.direction} ${args.pixels || 500}px`;
  return '';
}

// ---------------------------------------------------------------------------
// First-run setup prompt
// ---------------------------------------------------------------------------

function showSetupPrompt() {
  // Hide the default setup guide
  const guide = document.getElementById('setup-guide');
  if (guide) guide.classList.add('hidden');

  // Get the install command with the absolute path
  const extensionUrl = chrome.runtime.getURL('install-host.sh');
  // chrome-extension://id/install-host.sh → extract the file path
  // For load-unpacked, the actual path is the extension directory
  const extDir = chrome.runtime.getURL('').replace('chrome-extension://', '').replace(/\/$/, '');

  const el = document.createElement('div');
  el.className = 'setup-prompt';
  el.innerHTML = `
    <div class="setup-title">One-time setup</div>
    <p>Run this in your terminal, then restart Chrome:</p>
    <div class="setup-cmd" id="setup-cmd"></div>
    <button class="setup-copy" id="copy-cmd">Copy</button>
    <p class="setup-hint">This registers the native messaging bridge so Chrome can launch the Codex agent.</p>
  `;
  messagesEl.appendChild(el);

  // We need the real filesystem path. For load-unpacked extensions,
  // chrome.runtime.getURL gives us the extension URL, not the filesystem path.
  // The install-host.sh is in the extension directory, which the user knows.
  const cmdEl = el.querySelector('#setup-cmd');
  cmdEl.textContent = chrome.runtime.getURL('install-host.sh')
    .replace(/^chrome-extension:\/\/[^/]+/, '.');

  // Actually, we can't know the absolute path from inside the extension.
  // Show a relative hint instead.
  cmdEl.textContent = './install-host.sh';

  el.querySelector('#copy-cmd').addEventListener('click', () => {
    navigator.clipboard.writeText('./install-host.sh').then(() => {
      el.querySelector('#copy-cmd').textContent = 'Copied!';
      setTimeout(() => { el.querySelector('#copy-cmd').textContent = 'Copy'; }, 2000);
    });
  });

  scrollToBottom();
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Sending questions
// ---------------------------------------------------------------------------

async function sendQuestion() {
  const text = questionEl.value.trim();
  if (!text || streaming) return;

  addMessage('user', text);
  questionEl.value = '';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  port.postMessage({ type: 'ask', question: text, tabId: tab?.id });
}

sendBtn.addEventListener('click', sendQuestion);

questionEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendQuestion();
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

saveBtn.addEventListener('click', () => {
  const cfg = {};
  if (modelInput.value) cfg.model = modelInput.value;
  port.postMessage({ type: 'updateConfig', config: cfg });
  settingsPanel.classList.add('hidden');
});

connectBtn.addEventListener('click', () => {
  port.postMessage({ type: 'connect' });
});

newThreadBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) port.postMessage({ type: 'newThread', tabId: tab.id });
  messagesEl.innerHTML = '';
  addMessage('system', 'New conversation started.');
});
