/**
 * notify-kde configuration: defaults, validation, and the on-disk override file.
 *
 * Precedence, lowest to highest:
 *   built-in defaults  <  cordis.patch.yml `config`  <  $DSH_HOME/notify-kde.json
 *
 * The JSON file only ever holds keys the user changed (the `/notify-kde on|off`
 * command writes just `enabled`), so an untouched file never shadows the
 * profile's patch values.
 *
 * @module dsh-notify-kde/config
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** Where DSH keeps its profile data. Mirrors @deepseek-ai/dsh-home-paths. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  return join(homedir(), '.dsh');
}

/** The user-owned override file. */
export function configPath() {
  return join(dshHome(), 'notify-kde.json');
}

/** Human-readable settings for the `/notify-kde` command. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  locale: 'zh',

  // Completion
  notifyOnDone: true,
  notifyOnError: true,
  notifyOnBlocked: true,
  minDurationMs: 30000,
  suppressWhenAborted: true,
  suppressSubagentSessions: true,
  subagentWaitMs: 600000,

  // Waiting for the user
  notifyOnUiPrompt: true,
  notifyOnApproval: true,
  uiPromptDelayMs: 8000,
  approvalDelayMs: 0,

  // Desktop notification
  desktop: true,
  desktopTimeoutMs: 8000,
  urgency: 'normal',
  icon: 'utilities-terminal',
  coalesce: true,
  dismissOnReturn: true,
  includeSnippet: true,
  snippetChars: 140,
  titlePrefix: 'DSH',

  // Phone (KDE Connect)
  kdeconnect: true,
  kdeconnectDevices: [],
  kdeconnectTimeoutMs: 5000,
  kdeconnectRefreshWhenOffline: true,
  kdeconnectRefreshTimeoutMs: 8000,
  annotatePhoneFailure: true,
});

const LOCALES = new Set(['en', 'zh']);
const URGENCIES = new Set(['low', 'normal', 'critical']);

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function finiteInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function string(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Merge one raw object over a base config and validate every field.
 *
 * Unknown keys are dropped (so a typo is visible in `/notify-kde status`
 * instead of silently changing nothing), and every bound is enforced here:
 * the delivery path may trust the returned object.
 *
 * @param {object} raw
 * @param {object} base - already-validated values to start from.
 * @returns {object}
 */
export function normalize(raw, base = DEFAULTS) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const out = { ...base };

  if (Object.hasOwn(input, 'enabled')) out.enabled = bool(input.enabled, base.enabled);
  if (Object.hasOwn(input, 'locale')) {
    out.locale = LOCALES.has(input.locale) ? input.locale : base.locale;
  }

  for (const key of ['notifyOnDone', 'notifyOnError', 'notifyOnBlocked', 'suppressWhenAborted', 'suppressSubagentSessions', 'notifyOnUiPrompt', 'notifyOnApproval', 'desktop', 'coalesce', 'dismissOnReturn', 'includeSnippet', 'kdeconnect', 'kdeconnectRefreshWhenOffline', 'annotatePhoneFailure']) {
    if (Object.hasOwn(input, key)) out[key] = bool(input[key], base[key]);
  }

  if (Object.hasOwn(input, 'minDurationMs')) out.minDurationMs = finiteInt(input.minDurationMs, base.minDurationMs, 0, 3600000);
  if (Object.hasOwn(input, 'subagentWaitMs')) out.subagentWaitMs = finiteInt(input.subagentWaitMs, base.subagentWaitMs, 0, 3600000);
  if (Object.hasOwn(input, 'uiPromptDelayMs')) out.uiPromptDelayMs = finiteInt(input.uiPromptDelayMs, base.uiPromptDelayMs, 0, 300000);
  if (Object.hasOwn(input, 'approvalDelayMs')) out.approvalDelayMs = finiteInt(input.approvalDelayMs, base.approvalDelayMs, 0, 300000);
  if (Object.hasOwn(input, 'desktopTimeoutMs')) out.desktopTimeoutMs = finiteInt(input.desktopTimeoutMs, base.desktopTimeoutMs, 0, 120000);
  if (Object.hasOwn(input, 'snippetChars')) out.snippetChars = finiteInt(input.snippetChars, base.snippetChars, 20, 2000);
  if (Object.hasOwn(input, 'kdeconnectTimeoutMs')) out.kdeconnectTimeoutMs = finiteInt(input.kdeconnectTimeoutMs, base.kdeconnectTimeoutMs, 500, 60000);
  if (Object.hasOwn(input, 'kdeconnectRefreshTimeoutMs')) out.kdeconnectRefreshTimeoutMs = finiteInt(input.kdeconnectRefreshTimeoutMs, base.kdeconnectRefreshTimeoutMs, 500, 120000);

  if (Object.hasOwn(input, 'urgency')) {
    out.urgency = URGENCIES.has(input.urgency) ? input.urgency : base.urgency;
  }
  if (Object.hasOwn(input, 'icon')) out.icon = string(input.icon, base.icon);
  if (Object.hasOwn(input, 'titlePrefix')) out.titlePrefix = string(input.titlePrefix, base.titlePrefix);

  if (Object.hasOwn(input, 'kdeconnectDevices')) {
    out.kdeconnectDevices = Array.isArray(input.kdeconnectDevices)
      ? input.kdeconnectDevices.filter((id) => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
      : base.kdeconnectDevices;
  }

  return out;
}

/**
 * Read the JSON override file. A broken file is reported, never fatal: the
 * notification path must keep working with the last known good values.
 *
 * @returns {{ values: object, error?: string }}
 */
export function readOverrides() {
  const file = configPath();
  if (!existsSync(file)) return { values: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { values: {}, error: `${file} 不是一个 JSON 对象` };
    }
    return { values: parsed };
  } catch (error) {
    return { values: {}, error: `${file} 读取失败：${String(error && error.message ? error.message : error)}` };
  }
}

/**
 * Compose the effective config.
 *
 * @param {object} patch - the profile's `config` block for this plugin.
 * @returns {{ config: object, error?: string, file: string }}
 */
export function loadConfig(patch = {}) {
  const { values, error } = readOverrides();
  const config = normalize(values, normalize(patch, DEFAULTS));
  return { config, error, file: configPath() };
}

/**
 * Persist one override key, backing the previous file up first.
 *
 * @param {string} key
 * @param {unknown} value
 */
export function saveOverride(key, value) {
  const file = configPath();
  const { values } = readOverrides();
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    try {
      copyFileSync(file, `${file}.bak`);
    } catch {
      // A missing backup must not block the actual write.
    }
  }
  const next = { ...values, [key]: value };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return file;
}

/** Short label for a workspace path, used in notification titles. */
export function projectLabel(cwd) {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) return 'DSH';
  return basename(cwd) || 'DSH';
}
