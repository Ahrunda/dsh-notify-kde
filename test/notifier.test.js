import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createNotifier } from '../lib/notifier.js';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'notify-kde-notifier-'));

const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function session(events = []) {
  return {
    id: 's1',
    header: { cwd: '/home/u/Project/demo' },
    snapshotEvents: () => events,
  };
}

function createRun({ notifyId = 42, devices = 'device-1', pingOk = true } = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'notify-send') return { ok: true, out: `${notifyId}\n`, err: '' };
    if (cmd === 'gdbus') return { ok: true, out: '', err: '' };
    if (cmd === 'kdeconnect-cli') {
      if (args[0] === '-a') return { ok: true, out: devices, err: '' };
      if (args[0] === '--refresh') return { ok: true, out: '', err: '' };
      if (args[0] === '--ping-msg') return pingOk ? { ok: true, out: '', err: '' } : { ok: false, out: '', err: 'offline' };
    }
    return { ok: true, out: '', err: '' };
  };
  return { calls, run };
}

const BASE = {
  minDurationMs: 0,
  uiPromptDelayMs: 0,
  approvalDelayMs: 0,
  kdeconnect: true,
  desktop: true,
  coalesce: true,
  includeSnippet: true,
  annotatePhoneFailure: true,
  kdeconnectRefreshWhenOffline: false,
  desktopTimeoutMs: 6000,
};

function makeNotifier({ patch = {}, run = createRun().run, countRunning = async () => 0, clock = { now: 0 } } = {}) {
  const fake = typeof run === 'function' ? { run } : run;
  const notifier = createNotifier({
    patchConfig: { ...BASE, ...patch },
    run: fake.run,
    now: () => clock.now,
    ensureEnv: () => true,
    countRunning,
    subagentPollMs: 10,
    log: () => {},
  });
  return { notifier, clock };
}

function notifyCalls(calls) {
  return calls.filter((call) => call.cmd === 'notify-send');
}

function pingCalls(calls) {
  return calls.filter((call) => call.cmd === 'kdeconnect-cli' && call.args[0] === '--ping-msg');
}

test('completed turn announces once, with duration, snippet and a phone ping', async () => {
  const events = [{ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '把 token 刷新路径改了，并补了测试。' }] } } }];
  const fake = createRun();
  const { notifier, clock } = makeNotifier({ run: fake.run });
  const s = session(events);

  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  clock.now = 5000;
  notifier.onSessionEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await wait();

  const sent = notifyCalls(fake.calls);
  assert.equal(sent.length, 1);
  const [title, body] = sent[0].args.slice(sent[0].args.indexOf('--') + 1);
  assert.equal(title, 'DSH · demo');
  assert.match(body, /✅ 跑完了 · 5秒/);
  assert.match(body, /token 刷新路径/);
  assert.equal(pingCalls(fake.calls).length, 1);
  assert.equal(pingCalls(fake.calls)[0].args[3], 'device-1');
});

test('a turn shorter than minDurationMs stays silent', async () => {
  const fake = createRun();
  const { notifier, clock } = makeNotifier({ run: fake.run, patch: { minDurationMs: 30000 } });
  const s = session();

  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  clock.now = 1000;
  notifier.onSessionEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await wait();

  assert.equal(notifyCalls(fake.calls).length, 0);
  assert.equal(pingCalls(fake.calls).length, 0);
});

test('an aborted turn stays silent when suppression is on', async () => {
  const fake = createRun();
  const { notifier, clock } = makeNotifier({ run: fake.run });
  const s = session();

  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  clock.now = 5000;
  notifier.onSessionEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } });
  await wait();

  assert.equal(notifyCalls(fake.calls).length, 0);
});

test('a blocked turn is reported even below the completed threshold', async () => {
  const fake = createRun();
  const { notifier } = makeNotifier({ run: fake.run, patch: { minDurationMs: 30000 } });
  const s = session();

  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  notifier.onSessionEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } });
  await wait();

  const sent = notifyCalls(fake.calls);
  assert.equal(sent.length, 1);
  assert.match(sent[0].args.at(-1), /停下来了/);
});

test('a question is announced only after uiPromptDelayMs', async () => {
  const fake = createRun();
  const { notifier } = makeNotifier({ run: fake.run, patch: { uiPromptDelayMs: 20 } });
  const s = session();

  notifier.onSessionEvent(s, {
    type: 'tool/call',
    data: { turn: 1, callId: 'c1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ question: '选哪个方案？' }] }) },
  });
  await wait(5);
  assert.equal(notifyCalls(fake.calls).length, 0);

  await wait(40);
  const sent = notifyCalls(fake.calls);
  assert.equal(sent.length, 1);
  assert.match(sent[0].args.at(-1), /等你/);
  assert.match(sent[0].args.at(-1), /选哪个方案？/);
});

test('a question answered before the delay never notifies', async () => {
  const fake = createRun();
  const { notifier } = makeNotifier({ run: fake.run, patch: { uiPromptDelayMs: 30 } });
  const s = session();

  notifier.onSessionEvent(s, { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'ask_user_question', arguments: '{}' } });
  notifier.onSessionEvent(s, { type: 'tool/result', data: { turn: 1, message: { toolCallId: 'c1' } } });
  await wait(60);

  assert.equal(notifyCalls(fake.calls).length, 0);
});

test('an approval is announced immediately, and a decided approval cancels a delayed one', async () => {
  const fake = createRun();
  const { notifier } = makeNotifier({ run: fake.run });
  const s = session();

  notifier.onSessionEvent(s, { type: 'approval/asked', data: { id: 'a1', toolName: 'Bash', reason: 'rm -rf build' } });
  await wait();
  assert.equal(notifyCalls(fake.calls).length, 1);
  assert.match(notifyCalls(fake.calls)[0].args.at(-1), /等你批准 · Bash — rm -rf build/);

  const sink = createRun();
  const delayed = makeNotifier({ run: sink.run, patch: { approvalDelayMs: 30 } });
  delayed.notifier.onSessionEvent(s, { type: 'approval/asked', data: { id: 'a2', toolName: 'Write', reason: '' } });
  delayed.notifier.onSessionEvent(s, { type: 'approval/decided', data: { id: 'a2', outcome: 'allowed-once' } });
  await wait(60);
  assert.equal(notifyCalls(sink.calls).length, 0);
});

test('a user message withdraws the current bubble', async () => {
  const fake = createRun();
  const { notifier, clock } = makeNotifier({ run: fake.run });
  const s = session();

  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  clock.now = 5000;
  notifier.onSessionEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await wait();

  notifier.onSessionEvent(s, { type: 'user/message', data: { source: { kind: 'user' }, content: [] } });
  await wait();

  const close = fake.calls.find((call) => call.cmd === 'gdbus');
  assert.ok(close);
  assert.equal(close.args.at(-1), '42');
});

test('coalescing replaces the previous notification id', async () => {
  const fake = createRun();
  const { notifier, clock } = makeNotifier({ run: fake.run });
  const s = session();

  for (const turn of [1, 2]) {
    notifier.onSessionEvent(s, { type: 'turn/start', data: { turn } });
    clock.now += 5000;
    notifier.onSessionEvent(s, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
    await wait();
  }

  const sent = notifyCalls(fake.calls);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].args[sent[1].args.indexOf('-r') + 1], '42');
});

test('an unreachable phone is named in the desktop body', async () => {
  const fake = createRun({ devices: '' });
  const { notifier, clock } = makeNotifier({ run: fake.run });
  const s = session();

  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  clock.now = 5000;
  notifier.onSessionEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(60);

  const sent = notifyCalls(fake.calls);
  assert.ok(sent.length >= 2);
  assert.match(sent.at(-1).args.at(-1), /手机未送达/);
});

test('a pinned device list skips discovery', async () => {
  const fake = createRun();
  const { notifier, clock } = makeNotifier({ run: fake.run, patch: { kdeconnectDevices: ['pinned-device'] } });
  const s = session();

  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  clock.now = 5000;
  notifier.onSessionEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await wait();

  assert.equal(fake.calls.some((call) => call.cmd === 'kdeconnect-cli' && call.args[0] === '-a'), false);
  const ping = pingCalls(fake.calls)[0];
  assert.equal(ping.args[3], 'pinned-device');
});

test('a pending subagent tree delays the done alert until it settles', async () => {
  const fake = createRun();
  let running = 1;
  const { notifier, clock } = makeNotifier({ run: fake.run, countRunning: async () => running, patch: { subagentWaitMs: 1000 } });
  const s = session();

  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  clock.now = 5000;
  notifier.onSessionEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(30);
  assert.equal(notifyCalls(fake.calls).length, 0);

  running = 0;
  await wait(60);
  assert.equal(notifyCalls(fake.calls).length, 1);
});

test('a new turn cancels a pending done alert', async () => {
  const fake = createRun();
  const { notifier, clock } = makeNotifier({ run: fake.run, countRunning: async () => 1, patch: { subagentWaitMs: 1000 } });
  const s = session();

  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  clock.now = 5000;
  notifier.onSessionEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await wait(10);
  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 2 } });
  await wait(60);

  assert.equal(notifyCalls(fake.calls).length, 0);
});

test('a subagent session does not alert on its own', async () => {
  const fake = createRun();
  const { notifier, clock } = makeNotifier({ run: fake.run });
  const s = {
    id: 'child',
    header: { cwd: '/home/u/Project/demo', origin: 'subagent', parentSession: 's1' },
    snapshotEvents: () => [],
  };

  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  clock.now = 5000;
  notifier.onSessionEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await wait();

  assert.equal(notifyCalls(fake.calls).length, 0);
});

test('a turn that errors bypasses the duration threshold and names the error', async () => {
  const fake = createRun();
  const { notifier } = makeNotifier({ run: fake.run, patch: { minDurationMs: 30000 } });
  const s = session();

  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  notifier.onSessionEvent(s, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { message: 'provider stream ended early' } } },
  });
  await wait();

  const sent = notifyCalls(fake.calls);
  assert.equal(sent.length, 1);
  const body = sent[0].args.at(-1);
  assert.match(body, /出错了/);
  assert.match(body, /provider stream ended early/);
});

test('an interrupted turn is reported, unlike an explicit abort', async () => {
  const fake = createRun();
  const { notifier } = makeNotifier({ run: fake.run });
  const s = session();

  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  notifier.onSessionEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } });
  await wait();

  const sent = notifyCalls(fake.calls);
  assert.equal(sent.length, 1);
  assert.match(sent[0].args.at(-1), /停下来了/);
});

test('a session on an ignored agent preset never alerts', async () => {
  const fake = createRun();
  const { notifier, clock } = makeNotifier({ run: fake.run, patch: { ignoreAgentPresets: ['aurabot-private'] } });
  const s = {
    id: 'qq-1',
    header: { cwd: '/home/u/Project/demo', agentPreset: 'aurabot-private' },
    snapshotEvents: () => [],
  };

  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  clock.now = 60000;
  notifier.onSessionEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await wait();

  assert.equal(notifyCalls(fake.calls).length, 0);
  assert.equal(pingCalls(fake.calls).length, 0);
});

test('a normal session still alerts while Aurabot presets are ignored', async () => {
  const fake = createRun();
  const { notifier, clock } = makeNotifier({ run: fake.run, patch: { ignoreAgentPresets: ['aurabot-private'] } });
  const s = session();

  notifier.onSessionEvent(s, { type: 'turn/start', data: { turn: 1 } });
  clock.now = 60000;
  notifier.onSessionEvent(s, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await wait();

  assert.equal(notifyCalls(fake.calls).length, 1);
});
