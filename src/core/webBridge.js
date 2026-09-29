'use strict';

// A tiny web server on 127.0.0.1 that only the browser extension talks to.
// It is reachable from this computer only, and rejects websites: a request must come from a
// browser extension (or carry no Origin at all) and include the X-AI-Chat-Manager header, which
// web pages can't add to a cross-site request without the permission this server never gives them.

const http = require('http');

const PORT = 48653;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|extension):\/\/[a-z0-9._-]+$/i;

function allowedOrigin(origin) {
  return !origin || origin === 'null' || EXTENSION_ORIGIN.test(origin);
}

function allowedHost(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function startBridge({ port = PORT, onEvents, onStatus = () => {} }) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const reply = (status, body) => {
      const headers = { 'Content-Type': 'application/json' };
      if (origin && EXTENSION_ORIGIN.test(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Methods'] = 'GET, POST';
        headers['Access-Control-Allow-Headers'] = 'Content-Type, X-AI-Chat-Manager';
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };

    // Blocks websites, including ones that point their own domain name at 127.0.0.1.
    if (!allowedHost(req.headers.host, server.address().port) || !allowedOrigin(origin)) return reply(403, { error: 'forbidden' });
    if (req.method === 'OPTIONS') return reply(204, {});
    if (req.method === 'GET' && req.url === '/v1/ping') return reply(200, { app: 'ai-chat-manager', version: 1 });
    if (req.method !== 'POST' || req.url !== '/v1/events') return reply(404, { error: 'not found' });
    if (req.headers['x-ai-chat-manager'] !== '1') return reply(403, { error: 'forbidden' });

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reply(413, { error: 'too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(400, { error: 'bad json' });
      }
      const events = message && message.events;
      if (!Array.isArray(events)) return reply(400, { error: 'no events' });
      let answer;
      try {
        // The handler's answer (e.g. { requests: ['resync'] }) goes back to the extension.
        answer = onEvents(events, { origin: origin || null, client: message.client || {} }) || {};
      } catch (err) {
        return reply(500, { error: err.message });
      }
      // 423: the app is ignoring browser updates for now (Testing switch), so the extension keeps them.
      if (answer.paused) return reply(423, { paused: true, requests: answer.requests || [] });
      return reply(200, { ok: true, received: events.length, ...answer });
    });
  });

  server.on('error', (err) => {
    onStatus({ listening: false, error: err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : err.message });
  });
  server.listen(port, '127.0.0.1', () => onStatus({ listening: true, error: null, port: server.address().port }));
  return server;
}

module.exports = { startBridge, PORT };
