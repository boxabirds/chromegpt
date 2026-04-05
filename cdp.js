// ChromeGPT CDP Module
// Chrome DevTools Protocol helpers loaded via importScripts in the service worker.
// All exports are globals consumed by background.js.

const CDP_VERSION = '1.3';
const MAX_AX_CHARS = 60000;
const MAX_AX_DEPTH = 12;
const MAX_INTERACTIVE = 200;
const MAX_NAME_LEN = 200;
const FOCUS_SETTLE_MS = 50;

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox',
  'checkbox', 'radio', 'slider', 'spinbutton', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'treeitem', 'option',
]);

const STRUCTURAL_ROLES = new Set([
  'banner', 'navigation', 'main', 'contentinfo', 'complementary',
  'form', 'region', 'article', 'heading', 'list', 'listitem',
  'table', 'row', 'cell', 'columnheader', 'rowheader',
  'group', 'toolbar', 'tablist', 'tabpanel', 'tree',
  'dialog', 'alertdialog', 'alert', 'status', 'log',
  'paragraph', 'blockquote', 'figure',
]);

// ---------------------------------------------------------------------------
// Per-tab debugger session state
// ---------------------------------------------------------------------------

const tabSessions = new Map(); // tabId → { attached, axNodeMap<compactId, backendDOMNodeId> }

// ---------------------------------------------------------------------------
// Low-level CDP helpers
// ---------------------------------------------------------------------------

function cdpSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Debugger lifecycle
// ---------------------------------------------------------------------------

async function ensureAttached(tabId) {
  const session = tabSessions.get(tabId);
  if (session?.attached) return;

  // Attempt to attach
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message;
        // "already attached" is fine — another DevTools window or prior session
        if (/already/.test(msg)) { resolve(); return; }
        reject(new Error(msg));
      } else {
        resolve();
      }
    });
  });

  // Enable the CDP domains we need
  await cdpSend(tabId, 'Accessibility.enable');
  await cdpSend(tabId, 'DOM.enable');
  await cdpSend(tabId, 'Page.enable');

  tabSessions.set(tabId, { attached: true, axNodeMap: new Map() });
}

async function cdpDetach(tabId) {
  const session = tabSessions.get(tabId);
  if (!session?.attached) { tabSessions.delete(tabId); return; }

  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
  tabSessions.delete(tabId);
}

// User dismissed the yellow debugger bar
chrome.debugger.onDetach.addListener((source, _reason) => {
  if (source.tabId != null) {
    const s = tabSessions.get(source.tabId);
    if (s) s.attached = false;
  }
});

// Navigation invalidates backendDOMNodeIds
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    const s = tabSessions.get(tabId);
    if (s) s.axNodeMap.clear();
  }
});

// ---------------------------------------------------------------------------
// Accessibility-tree extraction
// ---------------------------------------------------------------------------

async function extractAccessibilityTree(tabId) {
  await ensureAttached(tabId);

  const tab = await chrome.tabs.get(tabId);
  const { nodes } = await cdpSend(tabId, 'Accessibility.getFullAXTree');

  // Index nodes by AX nodeId
  const byId = new Map();
  for (const n of nodes) byId.set(n.nodeId, n);

  const root = nodes.find(
    (n) => n.role?.value === 'RootWebArea' || n.role?.value === 'WebArea',
  ) || nodes[0];

  if (!root) return '(Empty accessibility tree)';

  // Reset compact-ID map for this tab
  const session = tabSessions.get(tabId);
  session.axNodeMap = new Map();
  let nextCid = 1;

  const interactiveList = [];

  // Recursive serialiser
  function walk(nodeId, depth) {
    if (depth > MAX_AX_DEPTH) return '';
    const node = byId.get(nodeId);
    if (!node || node.ignored) return '';

    const role = node.role?.value || '';
    const name = node.name?.value || '';

    // Skip noise
    if (role === 'none' || role === 'presentation') return '';
    if (role === 'InlineTextBox') return '';

    // Generic wrappers without names — just pass children through
    if (role === 'generic' && !name) {
      let c = '';
      for (const cid of node.childIds || []) c += walk(cid, depth);
      return c;
    }

    const isInteractive = INTERACTIVE_ROLES.has(role);
    let compactId = null;

    if (isInteractive && interactiveList.length < MAX_INTERACTIVE && node.backendDOMNodeId) {
      compactId = nextCid++;
      session.axNodeMap.set(compactId, node.backendDOMNodeId);
      interactiveList.push({ id: compactId, role, name: _trunc(name, 80), props: _propsStr(node) });
    }

    // Recurse children
    let childText = '';
    for (const cid of node.childIds || []) childText += walk(cid, depth + 1);

    const indent = '  '.repeat(depth);
    const tName = _trunc(name, MAX_NAME_LEN);

    // --- Interactive element ---
    if (compactId) {
      const ps = _propsStr(node);
      const inner = childText.trim();
      // Show child text only if it adds info beyond the name
      if (inner && inner !== tName) {
        return `${indent}[${compactId}:${role}] "${tName}"${ps}\n${childText}`;
      }
      return `${indent}[${compactId}:${role}] "${tName}"${ps}\n`;
    }

    // --- Static text leaf ---
    if (role === 'StaticText' || role === 'text') {
      return name ? `${indent}${tName}\n` : '';
    }

    // --- Structural role ---
    if (STRUCTURAL_ROLES.has(role)) {
      const inner = childText.trim();
      if (!inner && !name) return '';
      if (role === 'heading') {
        const lvl = _prop(node, 'level');
        return `${indent}<heading${lvl ? ' level=' + lvl : ''}> ${name || inner}\n`;
      }
      if (name) return `${indent}<${role} "${tName}">\n${childText}${indent}</${role}>\n`;
      return `${indent}<${role}>\n${childText}${indent}</${role}>\n`;
    }

    // --- Anything else: pass through ---
    if (childText) return childText;
    if (name) return `${indent}${tName}\n`;
    return '';
  }

  const structure = walk(root.nodeId, 0);

  // Assemble output
  let out = `URL: ${tab.url || '(unknown)'}\nTitle: ${tab.title || '(untitled)'}\n\n`;
  out += '--- INTERACTIVE ELEMENTS ---\n';
  for (const el of interactiveList) {
    out += `[${el.id}] ${el.role} "${el.name}"${el.props}\n`;
  }
  out += '\n--- PAGE STRUCTURE ---\n';
  out += structure;

  if (out.length > MAX_AX_CHARS) {
    out = out.slice(0, MAX_AX_CHARS)
      + `\n… (truncated — ${interactiveList.length} interactive elements found)`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// AX-node property helpers
// ---------------------------------------------------------------------------

function _propsStr(node) {
  const parts = [];
  if (node.value?.value) parts.push(`value="${_trunc(node.value.value, 50)}"`);
  for (const p of node.properties || []) {
    const v = p.value?.value;
    switch (p.name) {
      case 'disabled': if (v) parts.push('disabled');   break;
      case 'checked':  if (v) parts.push('checked');    break;
      case 'expanded': parts.push(`expanded=${v}`);     break;
      case 'required': if (v) parts.push('required');   break;
      case 'readonly': if (v) parts.push('readonly');   break;
      case 'url':      parts.push(`href="${_trunc(v || '', 100)}"`); break;
    }
  }
  if (node.description?.value) {
    parts.push(`desc="${_trunc(node.description.value, 80)}"`);
  }
  return parts.length ? ' (' + parts.join(', ') + ')' : '';
}

function _prop(node, name) {
  const p = (node.properties || []).find((x) => x.name === name);
  return p?.value?.value;
}

function _trunc(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ---------------------------------------------------------------------------
// Action execution via CDP
// ---------------------------------------------------------------------------

function _backendId(tabId, compactId) {
  const session = tabSessions.get(tabId);
  if (!session) throw new Error('No debugger session — page may have reloaded');
  const id = session.axNodeMap.get(compactId);
  if (id == null) throw new Error(`Element [${compactId}] not found — page may have changed`);
  return id;
}

async function cdpClick(tabId, compactId) {
  const backendNodeId = _backendId(tabId, compactId);

  // Ensure element is in the viewport
  await cdpSend(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });

  // Resolve coordinates from the content quad
  const { model } = await cdpSend(tabId, 'DOM.getBoxModel', { backendNodeId });
  const q = model.content; // [x1,y1, x2,y2, x3,y3, x4,y4]
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;

  // Puppeteer-style move → press → release
  await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdpSend(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await cdpSend(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });
}

async function cdpType(tabId, compactId, value) {
  // Focus the field by clicking it
  await cdpClick(tabId, compactId);
  await new Promise((r) => setTimeout(r, FOCUS_SETTLE_MS));

  // Clear existing value via DOM
  const backendNodeId = _backendId(tabId, compactId);
  const { object } = await cdpSend(tabId, 'DOM.resolveNode', { backendNodeId });
  await cdpSend(tabId, 'Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: `function() {
      this.value = '';
      this.dispatchEvent(new Event('input', { bubbles: true }));
    }`,
  });

  // Insert new text (triggers beforeinput / input events like real typing)
  await cdpSend(tabId, 'Input.insertText', { text: value });
}

async function cdpNavigate(tabId, url) {
  await ensureAttached(tabId);
  await cdpSend(tabId, 'Page.navigate', { url });
}

async function cdpScroll(tabId, direction, pixels = 500) {
  await ensureAttached(tabId);
  const delta = direction === 'up' ? -pixels : pixels;
  await cdpSend(tabId, 'Runtime.evaluate', {
    expression: `window.scrollBy({top:${delta},behavior:'smooth'})`,
  });
}

async function cdpSelect(tabId, compactId, value) {
  const backendNodeId = _backendId(tabId, compactId);
  const { object } = await cdpSend(tabId, 'DOM.resolveNode', { backendNodeId });
  await cdpSend(tabId, 'Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: `function(v) {
      this.value = v;
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }`,
    arguments: [{ value }],
  });
}

// ---------------------------------------------------------------------------
// Browser history
// ---------------------------------------------------------------------------

async function cdpBack(tabId) {
  await ensureAttached(tabId);
  await cdpSend(tabId, 'Runtime.evaluate', { expression: 'history.back()' });
}

// ---------------------------------------------------------------------------
// Page-settle helper (wait for navigation to finish after click/navigate)
// ---------------------------------------------------------------------------

const PAGE_SETTLE_MS = 500;
const PAGE_LOAD_TIMEOUT_MS = 2000;

async function waitForPageSettle(tabId) {
  await new Promise((r) => setTimeout(r, PAGE_SETTLE_MS));
  try {
    const { result } = await cdpSend(tabId, 'Runtime.evaluate', {
      expression: 'document.readyState',
    });
    if (result.value !== 'complete') {
      await new Promise((r) => setTimeout(r, PAGE_LOAD_TIMEOUT_MS));
    }
  } catch (_) {
    // Page mid-navigation — DOM not ready yet, give it time
    await new Promise((r) => setTimeout(r, PAGE_LOAD_TIMEOUT_MS));
  }
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

async function cdpScreenshot(tabId) {
  await ensureAttached(tabId);
  const { data } = await cdpSend(tabId, 'Page.captureScreenshot', {
    format: 'jpeg', quality: 60,
  });
  return data; // base64
}
