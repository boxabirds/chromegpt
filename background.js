// ChromeGPT Background Service Worker
// Connects to Codex app-server and exposes CDP browser tools as dynamic tools.
// The agent drives an iterative tool-use loop — extract page, click, type,
// navigate — just like Claude Code does with filesystem tools.

importScripts('cdp.js');

const DEFAULT_WS_URL = 'ws://127.0.0.1:4501';
const DEFAULT_MODEL = 'o3';
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

let ws = null;
let rpcId = 0;
let pendingRequests = new Map(); // id -> {resolve, reject}
let connectionState = 'disconnected';
let reconnectAttempt = 0;
let threads = new Map(); // tabId -> threadId
let activePort = null;
let config = { wsUrl: DEFAULT_WS_URL, model: DEFAULT_MODEL };
let currentTurnText = '';
let currentTabId = null; // tab the current turn operates on

// ---------------------------------------------------------------------------
// Dynamic tool definitions — registered with Codex so the agent can call them
// ---------------------------------------------------------------------------

const DYNAMIC_TOOLS = [
  {
    name: 'browser_extract_page',
    description:
      'Get the accessibility tree of the current web page. Returns semantic roles, ' +
      'text content, and interactive elements tagged with [N] IDs. Call this first ' +
      'to see what is on the page, and again after any navigation or page change.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description:
      'Click an interactive element by its [N] ID from the accessibility tree. ' +
      'Works for links, buttons, checkboxes, tabs, etc. After clicking a link, ' +
      'call browser_extract_page to see the new page.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Element [N] ID' } },
      required: ['id'],
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into a form field (textbox, searchbox) by its [N] ID. ' +
      'Clears the existing value first, then inserts the new text.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Element [N] ID' },
        value: { type: 'string', description: 'Text to type' },
      },
      required: ['id', 'value'],
    },
  },
  {
    name: 'browser_navigate',
    description:
      'Navigate the browser to a URL. After navigation completes, ' +
      'call browser_extract_page to see the new page.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to navigate to' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_back',
    description:
      'Go back to the previous page in browser history. ' +
      'Call browser_extract_page afterward to see the page.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_scroll',
    description:
      'Scroll the page up or down. Call browser_extract_page afterward ' +
      'to see newly visible content.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        pixels: { type: 'integer', description: 'Pixels to scroll (default 500)' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'browser_select',
    description: 'Select an option in a dropdown/combobox by its [N] ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Element [N] ID' },
        value: { type: 'string', description: 'Option value to select' },
      },
      required: ['id', 'value'],
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture a JPEG screenshot of the current viewport. Returns an image. ' +
      'Use when you need visual context the accessibility tree cannot convey.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ---------------------------------------------------------------------------
// Chrome Extension wiring
// ---------------------------------------------------------------------------

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;

  activePort = port;
  port.postMessage({ type: 'connectionState', state: connectionState });

  port.onMessage.addListener(async (msg) => {
    switch (msg.type) {
      case 'ask':
        await handleAsk(msg.question, msg.tabId);
        break;
      case 'connect':
        reconnectAttempt = 0;
        await connect();
        break;
      case 'disconnect':
        disconnect();
        break;
      case 'updateConfig':
        config = { ...config, ...msg.config };
        chrome.storage.local.set({ config });
        break;
      case 'getConfig':
        port.postMessage({ type: 'config', config });
        break;
      case 'newThread':
        threads.delete(msg.tabId);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    activePort = null;
  });
});

// Load saved config and auto-connect
chrome.storage.local.get('config', (result) => {
  if (result.config) config = { ...config, ...result.config };
  connect();
});

// Clean up when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  threads.delete(tabId);
  cdpDetach(tabId);
});

// ---------------------------------------------------------------------------
// Panel messaging helpers
// ---------------------------------------------------------------------------

function sendToPanel(msg) {
  if (!activePort) return;
  try { activePort.postMessage(msg); } catch (_) { /* port closed */ }
}

function broadcastState() {
  sendToPanel({ type: 'connectionState', state: connectionState });
}

// ---------------------------------------------------------------------------
// WebSocket / JSON-RPC 2.0
// ---------------------------------------------------------------------------

async function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  connectionState = 'connecting';
  broadcastState();

  try {
    ws = new WebSocket(config.wsUrl);

    ws.onopen = async () => {
      reconnectAttempt = 0;
      connectionState = 'connected';
      broadcastState();
      await initialize();
    };

    ws.onmessage = (event) => {
      try {
        handleRpcMessage(JSON.parse(event.data));
      } catch (_) {
        for (const line of event.data.split('\n').filter(Boolean)) {
          try { handleRpcMessage(JSON.parse(line)); }
          catch (e) { console.error('[chromegpt] bad RPC line', e, line); }
        }
      }
    };

    ws.onclose = () => {
      ws = null;
      const wasConnected = connectionState === 'connected';
      connectionState = 'disconnected';
      broadcastState();
      if (wasConnected) scheduleReconnect();
    };

    ws.onerror = () => {
      connectionState = 'error';
      broadcastState();
      sendToPanel({
        type: 'error',
        error: `Cannot reach app-server at ${config.wsUrl}`,
      });
    };
  } catch (_) {
    connectionState = 'error';
    broadcastState();
    scheduleReconnect();
  }
}

function disconnect() {
  reconnectAttempt = MAX_RECONNECT_ATTEMPTS;
  if (ws) ws.close();
  ws = null;
  pendingRequests.forEach(({ reject }) => reject(new Error('Disconnected')));
  pendingRequests.clear();
  connectionState = 'disconnected';
  broadcastState();
}

function scheduleReconnect() {
  if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) return;
  const delay = RECONNECT_DELAYS_MS[reconnectAttempt++];
  setTimeout(() => connect(), delay);
}

function sendRpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected to Codex app-server'));
      return;
    }
    const id = rpcId++;
    pendingRequests.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, id, params }));
  });
}

function sendRpcNotification(method, params) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
}

function respondToServer(id, result) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function handleRpcMessage(msg) {
  if ('id' in msg && pendingRequests.has(msg.id)) {
    const { resolve, reject } = pendingRequests.get(msg.id);
    pendingRequests.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error)))
              : resolve(msg.result);
    return;
  }

  if (msg.method && !('id' in msg)) {
    handleServerNotification(msg.method, msg.params);
    return;
  }

  if (msg.method && 'id' in msg) {
    handleServerRequest(msg.id, msg.method, msg.params);
  }
}

// ---------------------------------------------------------------------------
// Initialization — opt into experimental API for dynamic tools
// ---------------------------------------------------------------------------

async function initialize() {
  await sendRpc('initialize', {
    clientInfo: { name: 'chromegpt', title: 'ChromeGPT', version: '0.2.0' },
    capabilities: { experimentalApi: true },
  });
  sendRpcNotification('initialized');
}

// ---------------------------------------------------------------------------
// Thread management — register dynamic tools on thread creation
// ---------------------------------------------------------------------------

async function getOrCreateThread(tabId) {
  if (threads.has(tabId)) return threads.get(tabId);

  const result = await sendRpc('thread/start', {
    model: config.model,
    cwd: '/tmp',
    dynamicTools: DYNAMIC_TOOLS,
    developerInstructions: DEVELOPER_INSTRUCTIONS,
  });

  const threadId = result.threadId || result.id;
  threads.set(tabId, threadId);
  return threadId;
}

// ---------------------------------------------------------------------------
// Turn handling — send the user's question, agent drives the tool loop
// ---------------------------------------------------------------------------

async function handleAsk(question, tabId) {
  try {
    if (connectionState !== 'connected') {
      await connect();
      await new Promise((r) => setTimeout(r, 1500));
      if (connectionState !== 'connected') {
        sendToPanel({
          type: 'error',
          error: 'Not connected. Run:\n  codex app-server --listen ws://127.0.0.1:4500',
        });
        return;
      }
    }

    // Attach debugger now so tools are ready when the agent calls them
    currentTabId = tabId;
    try {
      await ensureAttached(tabId);
    } catch (e) {
      sendToPanel({ type: 'error', error: `Cannot attach debugger: ${e.message}` });
      return;
    }

    const threadId = await getOrCreateThread(tabId);
    currentTurnText = '';

    // Give the agent the current URL for orientation — full extraction is
    // left to the browser_extract_page tool so the agent controls when to read.
    const tab = await chrome.tabs.get(tabId);
    const input = [
      { type: 'text', text: `User is on: ${tab.url} ("${tab.title}")\n\n${question}` },
    ];

    sendToPanel({ type: 'turnStart' });

    await sendRpc('turn/start', { threadId, input, model: config.model });
  } catch (e) {
    sendToPanel({ type: 'error', error: e.message });
  }
}

// ---------------------------------------------------------------------------
// Server notifications
// ---------------------------------------------------------------------------

function handleServerNotification(method, params) {
  switch (method) {
    case 'item/agentMessage/delta':
      currentTurnText += params.delta || '';
      sendToPanel({ type: 'delta', text: params.delta || '' });
      break;

    case 'item/started':
      if (params?.item?.type === 'dynamicToolCall') {
        sendToPanel({
          type: 'toolCall',
          tool: params.item.tool,
          args: params.item.arguments,
        });
      }
      break;

    case 'turn/completed':
      sendToPanel({ type: 'turnComplete', fullText: currentTurnText });
      currentTurnText = '';
      break;

    case 'error':
      sendToPanel({ type: 'error', error: params?.message || 'Unknown server error' });
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Server requests — dynamic tool execution + approval auto-accept
// ---------------------------------------------------------------------------

function handleServerRequest(id, method, params) {
  switch (method) {
    case 'item/tool/call':
      handleToolCall(id, params).catch((e) => {
        respondToServer(id, {
          contentItems: [{ type: 'inputText', text: `Internal error: ${e.message}` }],
          success: false,
        });
      });
      break;
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'item/permissions/requestApproval':
      respondToServer(id, { approved: true });
      break;
    case 'item/tool/requestUserInput':
      respondToServer(id, { input: '' });
      break;
    default:
      respondToServer(id, {});
      break;
  }
}

// ---------------------------------------------------------------------------
// Dynamic tool dispatcher — the agent calls these via the Codex protocol
// ---------------------------------------------------------------------------

async function handleToolCall(rpcId, params) {
  const { tool, arguments: args } = params;
  const tabId = currentTabId;

  if (!tabId) {
    respondToServer(rpcId, {
      contentItems: [{ type: 'inputText', text: 'No active tab' }],
      success: false,
    });
    return;
  }

  try {
    let contentItems;

    switch (tool) {
      case 'browser_extract_page': {
        const tree = await extractAccessibilityTree(tabId);
        contentItems = [{ type: 'inputText', text: tree }];
        break;
      }

      case 'browser_click': {
        await cdpClick(tabId, args.id);
        await waitForPageSettle(tabId);
        contentItems = [{ type: 'inputText', text: `Clicked [${args.id}]. Use browser_extract_page to see the current state.` }];
        break;
      }

      case 'browser_type': {
        await cdpType(tabId, args.id, args.value);
        contentItems = [{ type: 'inputText', text: `Typed "${args.value}" into [${args.id}].` }];
        break;
      }

      case 'browser_navigate': {
        await cdpNavigate(tabId, args.url);
        await waitForPageSettle(tabId);
        const tab = await chrome.tabs.get(tabId);
        contentItems = [{ type: 'inputText', text: `Navigated to ${tab.url} ("${tab.title}"). Use browser_extract_page to see the page.` }];
        break;
      }

      case 'browser_back': {
        await cdpBack(tabId);
        await waitForPageSettle(tabId);
        const tab = await chrome.tabs.get(tabId);
        contentItems = [{ type: 'inputText', text: `Went back to ${tab.url} ("${tab.title}"). Use browser_extract_page to see the page.` }];
        break;
      }

      case 'browser_scroll': {
        await cdpScroll(tabId, args.direction, args.pixels);
        contentItems = [{ type: 'inputText', text: `Scrolled ${args.direction} ${args.pixels || 500}px.` }];
        break;
      }

      case 'browser_select': {
        await cdpSelect(tabId, args.id, args.value);
        contentItems = [{ type: 'inputText', text: `Selected "${args.value}" in [${args.id}].` }];
        break;
      }

      case 'browser_screenshot': {
        const b64 = await cdpScreenshot(tabId);
        contentItems = [{ type: 'inputImage', imageUrl: `data:image/jpeg;base64,${b64}` }];
        break;
      }

      default:
        respondToServer(rpcId, {
          contentItems: [{ type: 'inputText', text: `Unknown tool: ${tool}` }],
          success: false,
        });
        return;
    }

    respondToServer(rpcId, { contentItems, success: true });
  } catch (e) {
    respondToServer(rpcId, {
      contentItems: [{ type: 'inputText', text: `Error: ${e.message}` }],
      success: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Developer instructions
// ---------------------------------------------------------------------------

const DEVELOPER_INSTRUCTIONS = `You are ChromeGPT, a browser assistant that helps users search, navigate, and interact with web pages.

You have browser tools to observe and control the current tab. Typical workflow:
1. Call browser_extract_page to read the accessibility tree of the current page.
2. Interactive elements are tagged with [N] IDs — use these with browser_click, browser_type, browser_select.
3. After clicking a link or navigating, call browser_extract_page again to see the new page.
4. Use browser_screenshot when you need visual layout context the text tree cannot convey.

Important:
- Always extract the page before acting so you have current [N] IDs.
- After any navigation or page-changing action, re-extract to get updated IDs.
- Think step by step. Explore methodically. Report findings clearly.
- Do NOT use file-system tools or run shell commands — you operate in a browser context only.`;
