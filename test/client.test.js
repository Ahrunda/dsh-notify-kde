import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');

function loadClient(pending = { sessionId: 'session-1' }, pendingOk = true, pendingStatus) {
  let exported = null;
  const calls = [];
  const responses = [];
  const timers = [];
  const listeners = [];
  const signals = [];
  const window = {
    __ModuleLoader__: {
      load(definition) {
        exported = definition.factory();
      },
    },
    AbortSignal: {
      timeout(ms) {
        signals.push(ms);
        return { timeoutMs: ms };
      },
    },
    fetch: async (url, options) => {
      calls.push([url, options]);
      const isPending = url === '/api/dsh-notify-kde/pending';
      const status = isPending ? (pendingStatus ?? (pendingOk ? 200 : 500)) : 200;
      const response = {
        ok: status >= 200 && status < 300,
        status,
        consumed: false,
        cancelled: false,
        json: async () => {
          response.consumed = true;
          return isPending ? pending : { ok: true };
        },
        body: { cancel: async () => { response.cancelled = true; } },
      };
      responses.push({ url, response });
      return response;
    },
    setInterval: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearInterval: () => {},
    addEventListener: (type, fn) => { listeners.push([type, fn]); },
    removeEventListener: () => {},
  };
  vm.runInNewContext(source, { window, setInterval: window.setInterval, clearInterval: window.clearInterval });
  return { exported, calls, responses, timers, listeners, signals, window };
}

test('the browser half opens the pending session and consumes it', async () => {
  const { exported, calls, responses, signals } = loadClient();
  let opened = null;
  const disposers = [];
  const ctx = {
    get(name) {
      if (name === 'uiWorkspace') return { openSession: (id) => { opened = id; } };
      return undefined;
    },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
  };

  exported.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(opened, 'session-1');
  assert.ok(calls.some(([url, options]) => url === '/api/dsh-notify-kde/pending'));
  assert.ok(calls.some(([url, options]) => url.startsWith('/api/dsh-notify-kde/consumed?sessionId=session-1') && options.method === 'POST'));
  assert.equal(disposers.length, 1);
  for (const { url, response } of responses) {
    assert.ok(response.consumed || response.cancelled, `unreleased response body: ${url}`);
  }
  // Every tiny status request carries a deadline, so a stalled host cannot make
  // the heartbeat queue up in the renderer.
  assert.ok(signals.length >= responses.length);
  for (const [url, options] of calls) {
    assert.equal(options.signal?.timeoutMs, 5000, `no fetch deadline: ${url}`);
  }
});

test('opening a session in another workspace switches the workspace first', async () => {
  const { exported } = loadClient({ sessionId: 'session-2' });
  const order = [];
  const items = [
    { workspaceId: 'w1', sessionIds: ['session-1'] },
    { workspaceId: 'w2', sessionIds: ['session-2'] },
  ];
  let selected = 'session-1';
  const uiWorkspace = {
    selection: { getSnapshot: () => ({ sessionId: selected }) },
    openSession(id) { order.push(`session:${id}`); selected = id; },
    openWorkspace(id) { order.push(`workspace:${id}`); return Promise.resolve(); },
  };
  const ctx = {
    get(name) {
      if (name === 'uiWorkspace') return uiWorkspace;
      if (name === 'workspaces') return { list: { getSnapshot: () => ({ items }) } };
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: { 'session-2': {} } }) } };
      return undefined;
    },
    effect(factory) { factory(); },
  };

  exported.apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(order, ['workspace:w2', 'session:session-2']);
  assert.equal(selected, 'session-2');
});

test('repeated focus heartbeats release every response body', async () => {
  const { exported, responses, timers } = loadClient({ sessionId: null });
  exported.apply({ effect(factory) { factory(); } });
  const heartbeat = timers.find(({ delay }) => delay === 2000);
  assert.ok(heartbeat);
  for (let i = 0; i < 100; i++) heartbeat.callback();
  await new Promise(setImmediate);
  const focus = responses.filter(({ url }) => url.startsWith('/api/dsh-notify-kde/focus?'));
  assert.equal(focus.length, 101);
  assert.ok(focus.every(({ response }) => response.cancelled));
});

test('an unsuccessful pending poll releases its body without navigating', async () => {
  const { exported, responses } = loadClient({ sessionId: 'session-1' }, false);
  let opened = false;
  exported.apply({
    get() { return { openSession() { opened = true; } }; },
    effect(factory) { factory(); },
  });
  await new Promise(setImmediate);
  const pending = responses.find(({ url }) => url === '/api/dsh-notify-kde/pending');
  assert.equal(pending.response.cancelled, true);
  assert.equal(pending.response.consumed, false);
  assert.equal(opened, false);
});

test('a 204 pending answer is not parsed and does not navigate', async () => {
  const { exported, responses } = loadClient({ sessionId: null }, true, 204);
  let opened = false;
  exported.apply({
    get() { return { openSession() { opened = true; } }; },
    effect(factory) { factory(); },
  });
  await new Promise(setImmediate);
  const pending = responses.find(({ url }) => url === '/api/dsh-notify-kde/pending');
  assert.equal(pending.response.status, 204);
  assert.equal(pending.response.consumed, false);
  assert.equal(pending.response.cancelled, true);
  assert.equal(opened, false);
});

test('polling pauses while the page is hidden and resumes on visibilitychange', async () => {
  const { exported, responses, listeners, window } = loadClient({ sessionId: null });
  window.document = {
    visibilityState: 'hidden',
    hasFocus: () => false,
  };
  exported.apply({
    get() { return { openSession() {} }; },
    effect(factory) { factory(); },
  });
  await new Promise(setImmediate);
  const polling = () => responses.filter(({ url }) => url === '/api/dsh-notify-kde/pending').length;
  assert.equal(polling(), 0);

  window.document.visibilityState = 'visible';
  const onChange = listeners.filter(([type]) => type === 'visibilitychange').map(([, fn]) => fn)[0];
  assert.ok(onChange);
  onChange();
  await new Promise(setImmediate);
  assert.equal(polling(), 1);
});
