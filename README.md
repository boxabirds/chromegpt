# ChromeGPT

A Chrome Extension that connects to the [Codex app-server](https://developers.openai.com/codex/app-server) to browse, search, and interact with web pages using AI.

The Codex agent drives an iterative tool-use loop — extracting page content via the accessibility tree, clicking links, filling forms, navigating — the same pattern as Claude Code with filesystem tools, but for the browser.

## Setup

```bash
npm install -g @openai/codex
codex login
```

1. Go to `chrome://extensions`, enable **Developer Mode**, click **Load unpacked**, select this directory
2. Click the ChromeGPT icon — the side panel will prompt you to run `./install-host.sh`
3. Restart Chrome

That's it. From then on, clicking Connect in the side panel spawns the Codex app-server automatically. No terminals, no servers to manage.

### Why `install-host.sh`?

Chrome requires a one-line JSON manifest in a system directory to allow native messaging. The extension cannot write this file itself ([Chromium issue #40342154](https://issues.chromium.org/40342154), open since 2013). The script copies one file to `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.

### Why native messaging instead of WebSocket?

The Codex app-server [unconditionally rejects](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/transport/websocket.rs) any WebSocket connection with an `Origin` header. Chrome extensions always send `Origin: chrome-extension://[id]` — there is no way to suppress it. Native messaging uses stdio, bypassing HTTP entirely. This is also how the VS Code extension connects to the app-server.

## Architecture

```
Chrome Extension (side panel UI + CDP browser control)
    ↕ native messaging (length-prefixed JSON)
bridge.js (protocol translation)
    ↕ stdio (newline-delimited JSON)
codex app-server (AI agent + tool loop)
```

The extension registers CDP browser operations as Codex [dynamic tools](https://developers.openai.com/codex/app-server). The agent calls them iteratively:

| Tool | What it does |
|---|---|
| `browser_extract_page` | Accessibility tree of the current page |
| `browser_click` | Click an element by `[N]` ID |
| `browser_type` | Type into a form field |
| `browser_navigate` | Go to a URL |
| `browser_back` | Browser back |
| `browser_scroll` | Scroll the page |
| `browser_select` | Select a dropdown option |
| `browser_screenshot` | Capture a viewport screenshot |

Example: "find the pricing page" → agent extracts page → finds nav links → clicks "Pricing" → extracts new page → reports findings.

## How it works

1. User asks a question in the side panel
2. Extension attaches to the tab via `chrome.debugger` (CDP)
3. Question goes to Codex via `turn/start` over the native messaging bridge
4. The agent calls browser tools in a loop — extract, click, type, navigate — observing results between each step
5. Text responses stream back to the side panel with inline tool-call indicators

### Page extraction

Pages are read via `Accessibility.getFullAXTree` (CDP), which returns the browser's own semantic representation — roles, names, states — not raw HTML. This is much more compact and already filters to meaningful content. Interactive elements get `[N]` IDs that map to `backendDOMNodeId` for action execution.

### Browser actions

Actions use CDP input simulation: `DOM.scrollIntoViewIfNeeded` → `DOM.getBoxModel` → `Input.dispatchMouseEvent` (move/press/release). This is the same approach Puppeteer uses — real mouse events that work through shadow DOM, overlays, and framework event handlers.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 config — sidePanel, debugger, nativeMessaging permissions |
| `background.js` | Service worker — JSON-RPC 2.0 client, dynamic tool dispatcher |
| `cdp.js` | CDP helpers — accessibility tree extraction, input simulation |
| `bridge.js` | Native messaging host — translates Chrome ↔ Codex stdio protocols |
| `install-host.sh` | One-time setup — registers the native messaging host with Chrome |
| `sidepanel/` | Chat UI — streaming responses, tool-call display, setup prompt |

## Caveats

- The yellow "ChromeGPT is debugging this tab" bar is expected — it's the CDP debugger attachment
- The JSON-RPC protocol (method names, param shapes, dynamic tools API) was built from documentation research, not yet validated against a running server. Expect some debugging on first connection.

## License

Apache 2.0
