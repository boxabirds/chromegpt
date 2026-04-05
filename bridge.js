#!/usr/bin/env node

// ChromeGPT Native Messaging Bridge
//
// Spawned by Chrome via native messaging. Bridges between:
//   Chrome (length-prefixed JSON on stdin/stdout)
//   Codex app-server (newline-delimited JSON on child stdio)
//
// This eliminates the need for WebSocket and the Origin-header proxy.

const { spawn } = require('child_process');
const path = require('path');

// ---------------------------------------------------------------------------
// Find codex binary
// ---------------------------------------------------------------------------

function findCodex() {
  const { execSync } = require('child_process');
  try {
    return execSync('which codex', { encoding: 'utf8' }).trim();
  } catch (_) {
    // Common install locations
    const candidates = [
      path.join(process.env.HOME || '', '.npm-global/bin/codex'),
      '/usr/local/bin/codex',
      path.join(process.env.HOME || '', '.local/bin/codex'),
    ];
    const fs = require('fs');
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chrome native messaging protocol (length-prefixed JSON)
// ---------------------------------------------------------------------------

function readFromChrome(callback) {
  let buf = Buffer.alloc(0);

  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    while (buf.length >= 4) {
      const msgLen = buf.readUInt32LE(0);
      if (buf.length < 4 + msgLen) break; // wait for more data

      const json = buf.slice(4, 4 + msgLen).toString('utf8');
      buf = buf.slice(4 + msgLen);

      try {
        callback(JSON.parse(json));
      } catch (e) {
        log(`bad JSON from Chrome: ${e.message}`);
      }
    }
  });

  process.stdin.on('end', () => {
    log('Chrome disconnected (stdin closed)');
    cleanup();
  });
}

function writeToChrome(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(header);
  process.stdout.write(json);
}

// ---------------------------------------------------------------------------
// Codex app-server child process (JSONL on stdio)
// ---------------------------------------------------------------------------

let codex = null;
let codexLineBuf = '';

function spawnCodex(codexPath) {
  codex = spawn(codexPath, ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  // Read JSONL from codex stdout → forward to Chrome
  codex.stdout.on('data', (chunk) => {
    codexLineBuf += chunk.toString('utf8');
    const lines = codexLineBuf.split('\n');
    codexLineBuf = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        writeToChrome(JSON.parse(line));
      } catch (e) {
        log(`bad JSON from codex: ${e.message}: ${line.slice(0, 200)}`);
      }
    }
  });

  codex.stderr.on('data', (chunk) => {
    log(`codex stderr: ${chunk.toString('utf8').trim()}`);
  });

  codex.on('close', (code) => {
    log(`codex exited with code ${code}`);
    cleanup();
  });

  codex.on('error', (err) => {
    log(`codex spawn error: ${err.message}`);
    cleanup();
  });
}

function writeToCodex(obj) {
  if (codex && codex.stdin.writable) {
    codex.stdin.write(JSON.stringify(obj) + '\n');
  }
}

// ---------------------------------------------------------------------------
// Logging (stderr — Chrome ignores it, visible in terminal for debugging)
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`[chromegpt-bridge] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup() {
  if (codex) {
    codex.kill();
    codex = null;
  }
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('exit', () => { if (codex) codex.kill(); });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const codexPath = findCodex();
if (!codexPath) {
  log('ERROR: codex CLI not found. Install it: npm install -g @openai/codex');
  // Send error to Chrome so the extension can display it
  writeToChrome({ error: 'codex CLI not found. Install: npm install -g @openai/codex' });
  process.exit(1);
}

log(`using codex at: ${codexPath}`);
spawnCodex(codexPath);

// Chrome → bridge → codex
readFromChrome((msg) => {
  writeToCodex(msg);
});

log('bridge started');
