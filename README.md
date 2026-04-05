# ChromeGPT

A Chrome Extension that connects to the [Codex app-server](https://developers.openai.com/codex/app-server) to browse, search, and interact with web pages using AI. The Codex agent drives an iterative tool-use loop — extracting page content via the accessibility tree, clicking links, filling forms, navigating — just like Claude Code does with filesystem tools, but for the browser.

## Status: Blocked by Origin header rejection

The Codex app-server unconditionally rejects any WebSocket connection that includes an `Origin` header ([source](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/transport/websocket.rs)). Chrome extensions always send `Origin: chrome-extension://[id]` on WebSocket connections — there is no way to suppress it.

**Until the app-server accepts connections with an `Origin` header (e.g. via an `--allow-origin` flag), this is a 3-component solution:**

1. `codex app-server` — the AI backend
2. `proxy.js` — a Node.js WebSocket proxy that strips the `Origin` header
3. The Chrome extension itself

This makes the setup impractical for casual use. A proper fix would be either:
- OpenAI adding `--allow-origin` or `--ws-allow-browser` to the app-server
- Switching to [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) to spawn the app-server over stdio (how VS Code connects), eliminating WebSocket entirely

## Architecture

```
Chrome Extension (side panel UI)
    ↕ chrome.debugger (CDP)
    ↕ WebSocket JSON-RPC 2.0
Node proxy (strips Origin header)
    ↕ WebSocket
Codex app-server (AI agent + tool loop)
```

The extension registers browser operations as **dynamic tools** with the Codex agent:

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

The agent calls these iteratively to accomplish goals — e.g. "find the pricing page on this site" triggers: extract page → find nav links → click "Pricing" → extract new page → report findings.

## Setup

```bash
# 1. Install Codex CLI
npm install -g @openai/codex

# 2. Log in
codex login

# 3. Start the app-server
codex app-server --listen ws://127.0.0.1:4500

# 4. Install proxy dependency and start proxy
cd /path/to/chromegpt
npm install ws
node proxy.js

# 5. Load extension
# chrome://extensions → Developer Mode → Load unpacked → select this directory
```

The extension defaults to `ws://127.0.0.1:4501` (the proxy port). Configurable via the gear icon in the side panel.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 extension config — sidePanel, debugger, tabs permissions |
| `background.js` | Service worker — WebSocket/JSON-RPC client, tool dispatcher |
| `cdp.js` | Chrome DevTools Protocol — accessibility tree extraction, input simulation |
| `proxy.js` | WebSocket proxy that strips the `Origin` header |
| `sidepanel/` | Chat UI — streaming responses, tool-call display, settings |

## How it works

1. User asks a question in the side panel
2. Extension attaches to the tab via `chrome.debugger` (CDP)
3. Question is sent to Codex via `turn/start`
4. The Codex agent calls browser tools iteratively:
   - `browser_extract_page` → returns the accessibility tree (semantic roles, names, `[N]` IDs)
   - `browser_click` → resolves `[N]` to a DOM node via `backendDOMNodeId`, dispatches real mouse events
   - `browser_type` → clicks to focus, then `Input.insertText` (works with React/Vue)
   - etc.
5. Agent streams text responses between tool calls
6. Side panel shows the conversation with inline tool-call indicators

## Notes

- The yellow "ChromeGPT is debugging this tab" bar is expected — it's the CDP debugger attachment
- One conversation thread per tab, preserved across questions
- The accessibility tree is much more compact than raw DOM — uses semantic roles (button, link, heading) not HTML tags
- CDP gives real browser control: actual mouse events, keyboard input, works through shadow DOM

## License

Apache 2.0
