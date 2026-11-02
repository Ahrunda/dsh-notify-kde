import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8');

function loadClient() {
  let exported = null;
  const calls = [];
  const window = {
    __ModuleLoader__: {
      load(definition) {
        exported = definition.factory();
      },
    },
    fetch: async (url, options) => {
      calls.push([url, options]);
      if (url === '/api/dsh-notify-kde/pending') {
        return { ok: true, json: async () => ({ sessionId: 'session-1' }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    },
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  vm.runInNewContext(source, { window, setInterval: window.setInterval, clearInterval: window.clearInterval });
  return { exported, calls };
}

test('the browser half opens the pending session and consumes it', async () => {
  const { exported, calls } = loadClient();
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
});
