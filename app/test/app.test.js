'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createServer, setReady, resetState } = require('../src/app');

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));
beforeEach(() => resetState());

test('GET /healthz returns ok', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('GET /readyz reflects readiness state', async () => {
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  setReady(false);
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
});

test('GET /api/info exposes runtime metadata', async () => {
  const info = await (await fetch(`${base}/api/info`)).json();
  for (const key of ['appName', 'environment', 'version', 'gitSha', 'pod', 'uptimeSeconds']) {
    assert.ok(key in info, `missing ${key}`);
  }
});

test('task CRUD lifecycle', async () => {
  const created = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Ship it' }),
  });
  assert.equal(created.status, 201);
  const task = await created.json();
  assert.equal(task.title, 'Ship it');
  assert.equal(task.done, false);

  const toggled = await (await fetch(`${base}/api/tasks/${task.id}`, { method: 'PATCH' })).json();
  assert.equal(toggled.done, true);

  assert.equal((await fetch(`${base}/api/tasks/${task.id}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(await (await fetch(`${base}/api/tasks`)).json(), []);
});

test('POST /api/tasks validates input', async () => {
  const bad = await fetch(`${base}/api/tasks`, { method: 'POST', body: '{"title":""}' });
  assert.equal(bad.status, 400);
  const notJson = await fetch(`${base}/api/tasks`, { method: 'POST', body: 'nope' });
  assert.equal(notJson.status, 400);
});

test('unknown routes return 404', async () => {
  assert.equal((await fetch(`${base}/does-not-exist`)).status, 404);
  assert.equal((await fetch(`${base}/api/tasks/999`, { method: 'PATCH' })).status, 404);
});

test('GET /metrics returns Prometheus text format', async () => {
  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /app_requests_total \d+/);
});

test('GET / serves the UI', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});
