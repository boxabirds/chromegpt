# ChromeGPT

A Chrome Extension that connects to the [Codex app-server](https://developers.openai.com/codex/app-server) to browse, search, and interact with web pages using AI. The Codex agent drives an iterative tool-use loop — extracting page content via the accessibility tree, clicking links, filling forms, navigating — like how Claude Code works with filesystem tools, but for the browser.

## Architecture

```
Chrome Extension (side panel UI + CDP browser control)
    ↕ native messaging (length-prefixed JSON)
bridge.js (protocol translation)
    ↕ stdio (newline-delimited JSON)
codex app-server (AI agent + tool loop)
```

The extension spawns the Codex app-server automatically via Chrome's native messaging — no terminals, no servers to start manually.

### Why native messaging instead of WebSocket?

The Codex app-server [unconditionally rejects](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/transport/websocket.rs) any WebSocket request with an `Origin` header. Chrome extensions always send `Origin: chrome-extension://[id]` — there is no way to suppress it. Native messaging (stdio) avoids HTTP entirely, which is also how the VS Code extension connects.

## Setup

```bash
# 1. Install Codex CLI
npm install -g @openai/codex

# 2. Log in
codex login

# 3. Load the extension in Chrome
#    chrome://extensions → Developer Mode → Load unpacked → select this directory
#    Note the extension ID shown under the extension name

# 4. Install the native messaging host (one-time, needs your extension ID)
./install-host.sh <extension-id>

# 5. Restart Chrome
```

After restarting Chrome, click the ChromeGPT icon to open the side panel. Click "Connect" — the extension spawns the Codex app-server automatically.

## Browser tools

The extension registers these as Codex [dynamic tools](https://developers.openai.com/codex/app-server) — the agent calls them iteratively to accomplish goals:

| Tool | Description |
|---|---|
| `browser_extract_page` | Get the accessibility tree of the current page |
| `browser_click` | Click an element by its `[N]` ID |
| `browser_type` | Type into a form field |
| `browser_navigate` | Go to a URL |
| `browser_back` | Browser back |
| `browser_scroll` | Scroll the page |
| `browser_select` | Select a dropdown option |
| `browser_screenshot` | Capture a viewport screenshot |

Example: "find the pricing page on this site" triggers the agent to: extract page → find nav links → click "Pricing" → extract new page → report findings.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 extension — sidePanel, debugger, nativeMessaging |
| `background.js` | Service worker — JSON-RPC client, tool dispatcher |
| `cdp.js` | Chrome DevTools Protocol — accessibility tree, input simulation |
| `bridge.js` | Native messaging host — bridges Chrome ↔ Codex stdio |
| `install-host.sh` | One-time setup — installs the native messaging manifest |
| `sidepanel/` | Chat UI — streaming responses, tool-call display |

## How it works

1. User asks a question in the side panel
2. Extension attaches to the tab via `chrome.debugger` (CDP)
3. Question is sent to Codex via `turn/start` over the native messaging bridge
4. The Codex agent calls browser tools iteratively:
   - `browser_extract_page` → accessibility tree (semantic roles, names, `[N]` IDs)
   - `browser_click` → resolves `[N]` via `backendDOMNodeId`, dispatches real mouse events
   - `browser_type` → clicks to focus, then `Input.insertText` (works with React/Vue)
5. Agent streams text responses between tool calls
6. Side panel shows the conversation with inline tool-call indicators

## Notes

- The yellow "ChromeGPT is debugging this tab" bar is the CDP debugger — expected
- One conversation thread per tab
- The accessibility tree is much more compact than raw DOM — semantic roles, not HTML
- CDP gives real browser control: mouse events, keyboard input, works through shadow DOM

## Caveats

The JSON-RPC protocol implementation (method names, param shapes, dynamic tools API) was built from documentation research, not tested against a running server. Expect debugging when first connecting. See the commit history for context.

## License

Apache 2.0
