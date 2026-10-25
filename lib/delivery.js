/**
 * Delivery primitives: notify-send (desktop) and kdeconnect-cli (phone).
 *
 * Every function is best-effort and returns a result instead of throwing.
 * A notifier must never take the host down or surface an error into a turn.
 *
 * @module dsh-notify-kde/delivery
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCloseArgs,
  buildNotifyArgs,
  buildPingArgs,
  pollDelays,
} from './format.js';

/** Upper bound on the pre-flight phone probe, so the desktop alert is not held up. */
export const QUICK_PROBE_MS = 3000;

/** True on the only platform this plugin implements: a Linux KDE session. */
export function supportedPlatform() {
  return process.platform === 'linux';
}

/**
 * The DSH desktop app can be started from a launcher that never exported the
 * session bus address. Rebuild it the way the session manager would.
 */
export function hydrateSessionEnv() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!process.env.XDG_RUNTIME_DIR && uid !== undefined && existsSync(`/run/user/${uid}`)) {
    process.env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
  }
  if (!process.env.DBUS_SESSION_BUS_ADDRESS && process.env.XDG_RUNTIME_DIR) {
    const socket = join(process.env.XDG_RUNTIME_DIR, 'bus');
    if (existsSync(socket)) process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${socket}`;
  }
  return typeof process.env.DBUS_SESSION_BUS_ADDRESS === 'string' && process.env.DBUS_SESSION_BUS_ADDRESS.length > 0;
}

/**
 * Run one command, capturing stdout/stderr. Errors become `{ok:false}`.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{ok:boolean,out:string,err:string}>}
 */
export function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '');
        const err = String(stderr ?? '');
        if (error) {
          resolve({ ok: false, out, err: err.trim() || String(error.code ?? error.message ?? error) });
          return;
        }
        resolve({ ok: true, out, err });
      },
    );
  });
}

/**
 * Send one desktop notification.
 *
 * @param {object} cfg
 * @param {string} title
 * @param {string} body
 * @param {number|undefined} replaceId
 * @param {{run: typeof runCommand}} deps
 * @returns {Promise<{ok:boolean,id?:number,error?:string}>}
 */
export async function desktopNotify(cfg, title, body, replaceId, { run = runCommand } = {}) {
  if (!supportedPlatform()) return { ok: false, error: `unsupported platform: ${process.platform}` };
  const result = await run('notify-send', buildNotifyArgs(cfg, title, body, replaceId), 15000);
  if (!result.ok) return { ok: false, error: result.err };
  const id = Number.parseInt(result.out.trim().split('\n')[0] ?? '', 10);
  return Number.isInteger(id) && id > 0 ? { ok: true, id } : { ok: true };
}

/** Withdraw a notification previously sent by us. */
export async function closeDesktopNotice(id, { run = runCommand } = {}) {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'no notification id' };
  const result = await run('gdbus', buildCloseArgs(id), 3000);
  return { ok: result.ok, error: result.ok ? undefined : result.err };
}

/** Reachable, paired device ids. */
export async function listReachable(cfg, timeoutMs = cfg.kdeconnectTimeoutMs, { run = runCommand } = {}) {
  const listed = await run('kdeconnect-cli', ['-a', '--id-only'], timeoutMs);
  if (!listed.ok && listed.out.trim().length === 0) {
    return { ok: false, ids: [], error: listed.err };
  }
  const ids = listed.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/\s/.test(line));
  return { ok: true, ids };
}

/** Ping every id; all must succeed for the attempt to count as delivered. */
export async function pingIds(cfg, ids, text, { run = runCommand } = {}) {
  if (ids.length === 0) {
    return { ok: false, detail: 'no device', probed: [] };
  }
  const results = await Promise.all(ids.map((id) => run('kdeconnect-cli', buildPingArgs(id, text), cfg.kdeconnectTimeoutMs)));
  const failed = results.filter((result) => !result.ok).map((result) => result.err || 'failed');
  if (failed.length > 0) {
    return { ok: false, detail: failed.join('; '), probed: ids };
  }
  return { ok: true, detail: `sent to ${ids.length}`, probed: ids };
}

/**
 * First phone attempt. A pinned device list skips discovery; an empty list
 * means "every paired device that is reachable right now".
 */
export async function tryPhone(cfg, text, { run = runCommand } = {}) {
  if (cfg.kdeconnectDevices.length > 0) {
    return pingIds(cfg, cfg.kdeconnectDevices, text, { run });
  }
  const listed = await listReachable(cfg, Math.min(cfg.kdeconnectTimeoutMs, QUICK_PROBE_MS), { run });
  if (listed.ids.length === 0) {
    return { ok: false, detail: listed.error ?? 'no reachable device', probed: [] };
  }
  return pingIds(cfg, listed.ids, text, { run });
}

/**
 * Ask kdeconnectd to rescan and poll until a device appears or the budget runs out.
 * Returns `undefined` when the budget expired without finding one.
 */
export async function refreshAndRetry(cfg, text, { run = runCommand, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  await run('kdeconnect-cli', ['--refresh'], cfg.kdeconnectRefreshTimeoutMs);
  for (const delay of pollDelays(cfg.kdeconnectRefreshTimeoutMs)) {
    await sleep(delay);
    const listed = await listReachable(cfg, cfg.kdeconnectTimeoutMs, { run });
    if (listed.ids.length > 0) {
      return pingIds(cfg, listed.ids, text, { run });
    }
  }
  return undefined;
}
