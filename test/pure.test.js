import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULTS, configPath, dshHome, loadConfig, normalize, saveOverride } from '../lib/config.js';
import {
  brief,
  buildCloseArgs,
  buildNotifyArgs,
  buildPingArgs,
  describeQuestion,
  fmtDuration,
  oneLine,
  pollDelays,
  reasonError,
  reasonKind,
  snippet,
  strings,
  truncatePhone,
} from '../lib/format.js';

test('buildNotifyArgs keeps the -- terminator and adds replace id', () => {
  const args = buildNotifyArgs({ urgency: 'normal', desktopTimeoutMs: 8000, icon: 'utilities-terminal' }, '-title', '-body', 7);
  assert.equal(args[0], '-a');
  assert.ok(args.includes('--'));
  assert.equal(args[args.indexOf('--') + 1], '-title');
  assert.equal(args[args.indexOf('--') + 2], '-body');
  assert.deepEqual(args.slice(args.indexOf('-r'), args.indexOf('-r') + 2), ['-r', '7']);
  assert.deepEqual(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2), ['-t', '8000']);
});

test('buildCloseArgs targets CloseNotification with the id last', () => {
  const args = buildCloseArgs(42);
  assert.equal(args[0], 'call');
  assert.equal(args.at(-1), '42');
  assert.ok(args.includes('org.freedesktop.Notifications.CloseNotification'));
});

test('buildPingArgs carries the message and device id', () => {
  assert.deepEqual(buildPingArgs('abc', 'hello'), ['--ping-msg', 'hello', '-d', 'abc']);
});

test('pollDelays stays within budget and grows then caps', () => {
  const delays = pollDelays(8000);
  assert.ok(delays.length > 0);
  assert.ok(delays.reduce((sum, delay) => sum + delay, 0) <= 8000);
  assert.ok(delays.at(-1) <= 1000);
  assert.ok(delays[1] > delays[0]);
});

test('fmtDuration is localized and handles minutes', () => {
  assert.equal(fmtDuration(4200, 'zh'), '4秒');
  assert.equal(fmtDuration(252000, 'zh'), '4分 12秒');
  assert.equal(fmtDuration(252000, 'en'), '4m 12s');
  assert.equal(fmtDuration(3720000, 'zh'), '1小时 2分');
});

test('snippet collapses markdown and truncates', () => {
  assert.equal(snippet('## 标题\n- 第一行\n\n```js\nx\n```\n正文', 40), '标题 第一行 [code] 正文');
  assert.equal(snippet('abcdefghij', 5), 'abcd…');
  assert.equal(snippet('', 10), '');
});

test('oneLine strips control characters and truncates', () => {
  assert.equal(oneLine('a\u0000b\nc'), 'a b c');
  assert.equal(oneLine('abcdef', 4), 'abc…');
});

test('describeQuestion reads structured ask_user_question arguments', () => {
  assert.equal(describeQuestion('ask_user_question', JSON.stringify({ questions: [{ question: '选哪个？' }] })), '选哪个？');
  assert.equal(describeQuestion('ask_user_question', { questions: [{ header: '范围' }] }), '范围');
  assert.equal(describeQuestion('ask_user_question', '{}'), '有问题等你回答');
  assert.equal(describeQuestion('exit_plan_mode', '{}'), '方案待你确认');
});

test('reason helpers accept both shapes', () => {
  assert.equal(reasonKind('completed'), 'completed');
  assert.equal(reasonKind({ kind: 'error' }), 'error');
  assert.equal(reasonKind({}), 'unknown');
  assert.equal(reasonError({ kind: 'error', error: { message: 'boom' } }), 'boom');
  assert.equal(reasonError({ kind: 'completed' }), '');
});

test('truncatePhone and brief cap their output', () => {
  assert.equal(truncatePhone('x'.repeat(10), 5), 'xxxx…');
  assert.equal(brief('first\nsecond', 20), 'first');
});

test('strings has both locales', () => {
  assert.match(strings('zh').done('4秒'), /跑完了/);
  assert.match(strings('en').done('4s'), /Done/);
});

test('normalize clamps numbers and drops unknown keys', () => {
  const config = normalize({ minDurationMs: -1, uiPromptDelayMs: 999999, kdeconnectDevices: [' a ', 2, ''], bogus: true });
  assert.equal(config.minDurationMs, 0);
  assert.equal(config.uiPromptDelayMs, 300000);
  assert.deepEqual(config.kdeconnectDevices, ['a']);
  assert.equal(Object.hasOwn(config, 'bogus'), false);
  assert.equal(config.titlePrefix, DEFAULTS.titlePrefix);
});

test('loadConfig lets the user JSON override the patch, without creating a file', () => {
  const home = mkdtempSync(join(tmpdir(), 'notify-kde-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    assert.equal(dshHome(), home);
    assert.equal(configPath(), join(home, 'notify-kde.json'));
    const patched = loadConfig({ minDurationMs: 1000, kdeconnect: false });
    assert.equal(patched.config.minDurationMs, 1000);
    assert.equal(patched.config.kdeconnect, false);

    writeFileSync(configPath(), JSON.stringify({ minDurationMs: 5000, enabled: false }));
    const merged = loadConfig({ minDurationMs: 1000 });
    assert.equal(merged.config.minDurationMs, 5000);
    assert.equal(merged.config.enabled, false);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('saveOverride backs up the previous file and keeps other keys', () => {
  const home = mkdtempSync(join(tmpdir(), 'notify-kde-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    writeFileSync(configPath(), JSON.stringify({ minDurationMs: 1234 }));
    saveOverride('enabled', false);
    const saved = JSON.parse(readFileSync(configPath(), 'utf8'));
    assert.deepEqual(saved, { minDurationMs: 1234, enabled: false });
    const backup = JSON.parse(readFileSync(`${configPath()}.bak`, 'utf8'));
    assert.deepEqual(backup, { minDurationMs: 1234 });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('normalize keeps a clean ignoreAgentPresets list', () => {
  const config = normalize({ ignoreAgentPresets: [' aurabot-private ', 2, ''] });
  assert.deepEqual(config.ignoreAgentPresets, ['aurabot-private']);
});
