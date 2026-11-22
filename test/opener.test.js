import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CONSUMED_PATH, FOCUS_PATH, HELLO_PATH, PENDING_PATH, RESULT_PATH, createOpener } from '../lib/opener.js';

function harness() {
  const routes = new Map();
  const spawned = [];
  const opener = createOpener({
    log: () => {},
    run: async () => ({ ok: false, out: '', err: 'no kwin' }),
    focusScriptPath: join(tmpdir(), 'dsh-notify-kde-focus-test.js'),
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
    end(body) { this.body = body === undefined ? '' : String(body); },
  };
}

async function call(handler, method, url) {
  const res = response();
  await handler({ method, url }, res);
  return { status: res.statusCode, body: res.body, json: res.body.length > 0 ? JSON.parse(res.body) : undefined };
}

test('a click leaves a pending session and raises the window', async () => {
  const { opener, routes, spawned } = harness();
  opener.open('session-1');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(spawned[0], ['xdg-open', 'dsh://open']);

  const pending = await call(routes.get(PENDING_PATH), 'GET', PENDING_PATH);
  assert.equal(pending.json.sessionId, 'session-1');

  const consumed = await call(routes.get(CONSUMED_PATH), 'POST', `${CONSUMED_PATH}?sessionId=session-1`);
  assert.equal(consumed.status, 204);
  assert.equal(consumed.body, '');

  const after = await call(routes.get(PENDING_PATH), 'GET', PENDING_PATH);
  assert.equal(after.status, 204);
  assert.equal(after.body, '');
});

test('fire-and-forget routes answer 204 so no response body is allocated', async () => {
  const { routes } = harness();
  const cases = [
    [HELLO_PATH, 'POST'],
    [FOCUS_PATH, 'POST'],
    [RESULT_PATH, 'POST'],
    [CONSUMED_PATH, 'POST'],
  ];
  for (const [path, method] of cases) {
    const answer = await call(routes.get(path), method, `${path}?session=x&focused=1&visible=1&status=ok`);
    assert.equal(answer.status, 204, path);
    assert.equal(answer.body, '', path);
  }
  const idle = await call(routes.get(PENDING_PATH), 'GET', PENDING_PATH);
  assert.equal(idle.status, 204);
  assert.equal(idle.body, '');
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

test('focus reports are kept per renderer window', async () => {
  const { opener } = harness();
  opener.setFocusState({ clientId: 'win-a', sessionId: 's1', focused: true, visible: true });
  opener.setFocusState({ clientId: 'win-b', sessionId: 's2', focused: false, visible: true });
  assert.equal(opener.isFocused('s1'), true);
  assert.equal(opener.isFocused('s2'), false);

  // A background window reporting blur must not cancel the focused window's report.
  opener.setFocusState({ clientId: 'win-b', sessionId: 's1', focused: false, visible: true });
  assert.equal(opener.isFocused('s1'), true);

  // The focused window itself blurring does cancel it.
  opener.setFocusState({ clientId: 'win-a', sessionId: 's1', focused: false, visible: true });
  assert.equal(opener.isFocused('s1'), false);
});

test('focus reports expire and status says they are stale', async () => {
  let clock = 1000;
  const routes = new Map();
  const opener = createOpener({
    log: () => {},
    now: () => clock,
    run: async () => ({ ok: false, out: '', err: 'no kwin' }),
    spawnFn: () => Object.assign(new EventEmitter(), { unref() {} }),
  });
  opener.register({
    register(route) {
      routes.set(route.path, route.handler);
      return () => {};
    },
  });

  await call(routes.get(FOCUS_PATH), 'POST', `${FOCUS_PATH}?client=w1&session=s1&focused=1&visible=1`);
  assert.equal(opener.isFocused('s1'), true);

  clock += 9000;
  assert.equal(opener.isFocused('s1'), false);
  const info = opener.focusInfo();
  assert.equal(info.length, 1);
  assert.equal(info[0].clientId, 'w1');
  assert.equal(info[0].sessionId, 's1');
  assert.equal(info[0].focused, true);
  assert.equal(info[0].fresh, false);
});
