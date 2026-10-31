import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply, countRunningSubagents, name as pluginName } from '../index.js';

function fakeContext() {
  const handlers = new Map();
  const commands = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    effect(factory) {
      return factory();
    },
    get(service) {
      if (service === 'commands') {
        return {
          register(definition) {
            commands.push(definition);
            return () => {};
          },
        };
      }
      return undefined;
    },
  };
  return { ctx, handlers, commands };
}

test('apply wires the session firehose and registers /notify-kde', () => {
  const { ctx, handlers, commands } = fakeContext();
  apply(ctx, { desktop: false, kdeconnect: false });
  assert.equal(pluginName, 'dsh-notify-kde');
  assert.equal(typeof handlers.get('session/event'), 'function');
  assert.equal(typeof handlers.get('session/disposed'), 'function');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'notify-kde');
  assert.equal(typeof commands[0].handler, 'function');
});

test('/notify-kde status returns the effective configuration', async () => {
  const { ctx, commands } = fakeContext();
  apply(ctx, { desktop: false, kdeconnect: false, minDurationMs: 1234 });
  const result = await commands[0].handler({ rawInput: 'status' });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /notify-kde/);
  assert.match(result.text, /1234ms/);
});

test('countRunningSubagents is safe without an agents service', async () => {
  const { ctx } = fakeContext();
  assert.equal(await countRunningSubagents(ctx, 's1'), 0);
});

test('/notify-kde ignore persists the preset list', async () => {
  const home = mkdtempSync(join(tmpdir(), 'notify-kde-cmd-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { ctx, commands } = fakeContext();
    apply(ctx, { desktop: false, kdeconnect: false });
    const result = await commands[0].handler({ rawInput: 'ignore aurabot-private aurabot-social' });
    assert.equal(result.kind, 'success');
    const saved = JSON.parse(readFileSync(join(home, 'notify-kde.json'), 'utf8'));
    assert.deepEqual(saved.ignoreAgentPresets, ['aurabot-private', 'aurabot-social']);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});
