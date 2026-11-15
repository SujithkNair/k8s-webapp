'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const startedAt = Date.now();

// In-memory task store. Each pod has its own copy — fine for a demo,
// and it makes load-balancing across replicas visible in the UI.
const tasks = [];
let nextId = 1;

const metrics = { requests_total: 0, errors_total: 0 };
let ready = true;

function config() {
  return {
    appName: process.env.APP_NAME || 'K8s CI/CD Demo',
    environment: process.env.APP_ENV || 'local',
    version: process.env.APP_VERSION || 'dev',
    gitSha: process.env.GIT_SHA || 'unknown',
  };
}

function send(res, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  metrics.requests_total++;
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  // --- Kubernetes probes -------------------------------------------------
  if (route === 'GET /healthz') return send(res, 200, { status: 'ok' });
  if (route === 'GET /readyz') {
    return ready
      ? send(res, 200, { status: 'ready' })
      : send(res, 503, { status: 'not-ready' });
  }

  // --- Prometheus-style metrics -----------------------------------------
  if (route === 'GET /metrics') {
    const lines = [
      '# TYPE app_requests_total counter',
      `app_requests_total ${metrics.requests_total}`,
      '# TYPE app_errors_total counter',
      `app_errors_total ${metrics.errors_total}`,
      '# TYPE app_tasks gauge',
      `app_tasks ${tasks.length}`,
      '# TYPE app_uptime_seconds gauge',
      `app_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
    ];
    return send(res, 200, lines.join('\n') + '\n', 'text/plain; version=0.0.4');
  }

  // --- API ---------------------------------------------------------------
  if (route === 'GET /api/info') {
    return send(res, 200, {
      ...config(),
      pod: process.env.POD_NAME || os.hostname(),
      node: process.env.NODE_NAME || 'n/a',
      namespace: process.env.POD_NAMESPACE || 'n/a',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  }

  if (route === 'GET /api/tasks') return send(res, 200, tasks);

  if (route === 'POST /api/tasks') {
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (err) {
      return send(res, err.status || 400, { error: err.status ? err.message : 'Invalid JSON' });
    }
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    if (!title || title.length > 200) {
      return send(res, 400, { error: 'title is required (1-200 chars)' });
    }
    const task = { id: nextId++, title, done: false, createdAt: new Date().toISOString() };
    tasks.push(task);
    return send(res, 201, task);
  }

  const match = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (match) {
    const idx = tasks.findIndex((t) => t.id === Number(match[1]));
    if (idx === -1) return send(res, 404, { error: 'task not found' });
    if (req.method === 'PATCH') {
      tasks[idx].done = !tasks[idx].done;
      return send(res, 200, tasks[idx]);
    }
    if (req.method === 'DELETE') {
      tasks.splice(idx, 1);
      res.writeHead(204).end();
      return;
    }
  }

  // --- Static UI ---------------------------------------------------------
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    return send(res, 200, html, 'text/html; charset=utf-8');
  }

  return send(res, 404, { error: 'not found' });
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      metrics.errors_total++;
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    });
  });
}

function setReady(value) {
  ready = value;
}

function resetState() {
  tasks.length = 0;
  nextId = 1;
  ready = true;
}

module.exports = { createServer, setReady, resetState };
