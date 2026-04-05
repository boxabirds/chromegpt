#!/usr/bin/env node

// ChromeGPT WebSocket Proxy
//
// The Codex app-server rejects any WebSocket request that includes an Origin
// header (hard-coded in its Rust transport layer). Chrome extensions always
// send Origin: chrome-extension://[id], so a direct connection is impossible.
//
// This proxy accepts connections from the extension, strips the Origin header,
// and forwards everything to the real app-server.
//
// Usage:
//   node proxy.js                          # defaults: listen 4501, upstream 4500
//   node proxy.js --port 4501 --upstream 4500

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const DEFAULT_PROXY_PORT = 4501;
const DEFAULT_UPSTREAM_PORT = 4500;

// Parse simple CLI args
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const PROXY_PORT = parseInt(flag('port', DEFAULT_PROXY_PORT), 10);
const UPSTREAM = `ws://127.0.0.1:${flag('upstream', DEFAULT_UPSTREAM_PORT)}`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('chromegpt proxy ok');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (client, req) => {
  const origin = req.headers.origin || '(none)';
  console.log(`[proxy] client connected (origin: ${origin})`);

  // Connect upstream WITHOUT the Origin header
  const upstream = new WebSocket(UPSTREAM);

  let clientAlive = true;
  let upstreamAlive = false;

  upstream.on('open', () => {
    upstreamAlive = true;
    console.log('[proxy] upstream connected');

    // Relay: client → upstream
    client.on('message', (data) => {
      if (upstreamAlive) upstream.send(data);
    });

    // Relay: upstream → client
    upstream.on('message', (data) => {
      if (clientAlive) client.send(data);
    });
  });

  upstream.on('close', (code, reason) => {
    upstreamAlive = false;
    console.log(`[proxy] upstream closed (${code})`);
    if (clientAlive) client.close(code, reason);
  });

  upstream.on('error', (err) => {
    console.error('[proxy] upstream error:', err.message);
    upstreamAlive = false;
    if (clientAlive) client.close(1011, 'upstream error');
  });

  client.on('close', (code, reason) => {
    clientAlive = false;
    console.log(`[proxy] client closed (${code})`);
    if (upstreamAlive) upstream.close(code, reason);
  });

  client.on('error', (err) => {
    console.error('[proxy] client error:', err.message);
    clientAlive = false;
    if (upstreamAlive) upstream.close();
  });
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`ChromeGPT WS proxy`);
  console.log(`  listening: ws://127.0.0.1:${PROXY_PORT}`);
  console.log(`  upstream:  ${UPSTREAM}`);
  console.log();
  console.log('Point the ChromeGPT extension at the proxy URL above.');
});
