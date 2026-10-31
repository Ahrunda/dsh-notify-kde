#!/usr/bin/env node
/**
 * Add Aurabot's agent presets to notify-kde's ignore list.
 *
 * Aurabot runs a QQ chat session per contact on its own presets; every QQ
 * message can finish a long turn, and notifying the desktop for those is
 * noise. Run this once, then restart DSH so the new config is read:
 *
 *   node tools/ignore-aurabot.mjs
 */

import { configPath, loadConfig, saveOverride } from '../lib/config.js';

const PRESETS = ['aurabot-private', 'aurabot-private-long', 'aurabot-social'];
const current = loadConfig({}).config.ignoreAgentPresets;
const next = [...new Set([...current, ...PRESETS])];

saveOverride('ignoreAgentPresets', next);
console.log(`config: ${configPath()}`);
console.log(`ignore: ${next.join(', ')}`);
console.log('重启 DSH 后生效。');
