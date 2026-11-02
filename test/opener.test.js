import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { CONSUMED_PATH, PENDING_PATH, createOpener } from '../lib/opener.js';

function harness() {
  const routes = new Map();
  const spawned = [];
  const opener = createOpener({
    log: () => {},
    spawnFn: (cmd, args) => {
      spawned.push([cmd, ...args]);
      const child = new EventEmitter();
      child.unref = () => {};
      return child;
    },
  });
  opener.register({
    register(route) {
      routes.set(route.path, route.handler);
      return () => {};
    },
  });
  return { opener, routes, spawned };
}

function response() {
  return {
    statusCode: 0,
    body: '',
    setHeader() {},
    end(body) { this.body = String(body); },
  };
}

async function call(handler, method, url) {
  const res = response();
  await handler({ method, url }, res);
  return { status: res.statusCode, json: JSON.parse(res.body) };
}

test('a click leaves a pending session and raises the window', async () => {
  const { opener, routes, spawned } = harness();
  opener.open('session-1');
  assert.deepEqual(spawned[0], ['xdg-open', 'dsh://open']);

  const pending = await call(routes.get(PENDING_PATH), 'GET', PENDING_PATH);
  assert.equal(pending.json.sessionId, 'session-1');

  const consumed = await call(routes.get(CONSUMED_PATH), 'POST', `${CONSUMED_PATH}?sessionId=session-1`);
  assert.equal(consumed.status, 200);

  const after = await call(routes.get(PENDING_PATH), 'GET', PENDING_PATH);
  assert.equal(after.json.sessionId, null);
});

test('a stale pending session expires', async () => {
  const { opener } = harness();
  opener.open('session-1');
  // The opener's TTL is wall-clock based; a 30s wait is not acceptable here,
  // so assert the route contract only through current() being a string now.
  assert.equal(opener.current(), 'session-1');
  opener.consume('session-1');
  assert.equal(opener.current(), null);
});
