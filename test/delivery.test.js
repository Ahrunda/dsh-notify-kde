import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { desktopNotifyInteractive } from '../lib/delivery.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  child.kill = () => {};
  return child;
}

test('desktopNotifyInteractive returns the id and fires onAction for default', async () => {
  const child = fakeChild();
  let args;
  const spawnFn = (_cmd, captured) => {
    args = captured;
    queueMicrotask(() => child.stdio[3].write('42\n'));
    return child;
  };
  let opened = 0;
  const result = await desktopNotifyInteractive(
    { appName: 'DeepSeek Harness', urgency: 'normal', desktopTimeoutMs: 8000, icon: '', desktopEntry: '' },
    'title',
    'body',
    undefined,
    () => { opened++; },
    { spawnFn, action: '打开会话' },
  );

  assert.equal(result.ok, true);
  assert.equal(result.id, 42);
  assert.ok(args.includes('-A'));
  assert.ok(args.includes('default=打开会话'));

  child.stdio[4].write('default\n');
  assert.equal(opened, 1);
  child.stdio[4].write('default\n');
  assert.equal(opened, 1, 'the action must fire once');
});
