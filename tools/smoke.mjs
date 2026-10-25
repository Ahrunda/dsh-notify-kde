#!/usr/bin/env node
/**
 * Real-machine smoke test: send one desktop notification and/or one KDE
 * Connect ping through exactly the code the plugin uses.
 *
 *   node tools/smoke.mjs                 # desktop + phone
 *   node tools/smoke.mjs --no-phone      # desktop only
 *   node tools/smoke.mjs --no-desktop    # phone only
 *   node tools/smoke.mjs --config <file> # use a specific config JSON
 *
 * Exit code 0 only when every enabled channel succeeded.
 */

import { existsSync } from 'node:fs';
import { configPath, loadConfig } from '../lib/config.js';
import { desktopNotify, listReachable, refreshAndRetry, supportedPlatform, tryPhone } from '../lib/delivery.js';

const args = new Set(process.argv.slice(2));
const wantDesktop = !args.has('--no-desktop');
const wantPhone = !args.has('--no-phone');

if (!supportedPlatform()) {
  console.error(`unsupported platform: ${process.platform} (this plugin targets Linux/KDE)`);
  process.exit(2);
}

const { config, error } = loadConfig({});
if (error) console.warn(error);

const smoke = {
  ...config,
  desktopTimeoutMs: 4000,
  kdeconnectTimeoutMs: 5000,
  kdeconnectRefreshWhenOffline: false,
  annotatePhoneFailure: false,
};

const title = 'DSH · notify-kde 冒烟测试';
const body = `如果你看到这条，桌面通知链路是通的。\n${new Date().toLocaleString('zh-CN')}`;
const phoneText = `DSH: 🔔 冒烟测试 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;

let failed = false;

if (wantDesktop) {
  const sent = await desktopNotify(smoke, title, body, undefined);
  if (sent.ok) {
    console.log(`desktop: ok${sent.id !== undefined ? ` (notification id ${sent.id})` : ''} — 应在 ${smoke.desktopTimeoutMs}ms 后自动消失`);
  } else {
    failed = true;
    console.error(`desktop: FAILED — ${sent.error}`);
  }
}

if (wantPhone) {
  const listed = await listReachable(smoke);
  console.log(`kdeconnect: ${listed.ids.length} 台可达${listed.ids.length ? `（${listed.ids.join(', ')}）` : ''}`);
  let outcome = await tryPhone(smoke, phoneText);
  if (!outcome.ok && outcome.probed?.length === 0 && smoke.kdeconnectRefreshWhenOffline) {
    console.log('kdeconnect: 没有可达设备，重扫网络中…');
    outcome = (await refreshAndRetry(smoke, phoneText)) ?? outcome;
  }
  if (outcome.ok) {
    console.log(`phone: ok — ${outcome.detail}`);
  } else {
    failed = true;
    console.error(`phone: FAILED — ${outcome.detail}`);
  }
}

if (existsSync(configPath())) {
  console.log(`config: ${configPath()}`);
}

process.exit(failed ? 1 : 0);
