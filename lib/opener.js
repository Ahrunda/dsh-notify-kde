/**
 * "Open that session" handoff.
 *
 * A notification click happens in the host process (notify-send writes the
 * chosen action back to us). The browser half cannot be called from there
 * directly, so the host leaves a short-lived pending session id on an HTTP
 * route the client plugin polls; the client then calls
 * `uiWorkspace.openSession(sessionId)`.
 *
 * Raising the window is separate: the desktop app registers `dsh://` and
 * `dsh://open` focuses the primary window.
 *
 * @module dsh-notify-kde/opener
 */

import { spawn } from 'node:child_process';
import { dshHome } from './config.js';
import { runCommand } from './delivery.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PENDING_PATH = '/api/dsh-notify-kde/pending';
export const CONSUMED_PATH = '/api/dsh-notify-kde/consumed';
export const HELLO_PATH = '/api/dsh-notify-kde/hello';
export const RESULT_PATH = '/api/dsh-notify-kde/result';
export const FOCUS_PATH = '/api/dsh-notify-kde/focus';

function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

/**
 * Answer with no payload at all. The browser half posts a heartbeat every two
 * seconds and polls for a pending clue every few hundred milliseconds; each
 * `{"ok":true}` body is a Chromium shared-memory buffer, and an unread one
 * keeps its file descriptor. 204 means the client never allocates a body (nor
 * can a future client forget to release it).
 */
function writeEmpty(res) {
  res.statusCode = 204;
  res.setHeader('cache-control', 'no-store');
  res.end();
}

export function createOpener({
  log = () => {},
  spawnFn = spawn,
  run = runCommand,
  ttlMs = 30000,
  focusCommand = 'xdg-open',
  focusScriptPath = join(dshHome(), 'notify-kde-focus.js'),
} = {}) {
  /** @type {{sessionId: string, at: number} | null} */
  let pending = null;
  /** Latest browser focus report: which session is selected and whether the window is active. */
  let focusState = { sessionId: '', focused: false, visible: false, at: 0 };

  /**
   * KWin can activate the DSH window directly; this is the only reliable raise
   * on Wayland (a `dsh://open` second instance often exits without focusing).
   * The script is exact about the app id so a browser tab titled "DeepSeek" is
   * never mistaken for DSH.
   */
  async function focusViaKWin() {
    if (process.platform !== 'linux') return false;
    const script = `var wins = (typeof workspace.windowList === 'function') ? workspace.windowList() : workspace.windowList;
var target = null;
for (var i = 0; i < wins.length; i++) {
  var w = wins[i];
  var cls = String(w.resourceClass || '');
  var desk = String(w.desktopFileName || '');
  if (cls === 'deepseek-ai-dsh-desktop' || desk === 'deepseek-ai-dsh-desktop') { target = w; break; }
}
if (target) {
  try { target.minimized = false; } catch (e) {}
  workspace.activeWindow = target;
}
`;
    try {
      mkdirSync(dirname(focusScriptPath), { recursive: true });
      writeFileSync(focusScriptPath, script, 'utf8');
    } catch (error) {
      log('warn', `could not write KWin focus script: ${String(error?.message ?? error)}`);
      return false;
    }

    const qdbus = existsSync('/usr/bin/qdbus6') ? '/usr/bin/qdbus6' : 'qdbus6';
    const call = (method, ...args) => run(qdbus, ['org.kde.KWin', '/Scripting', `org.kde.kwin.Scripting.${method}`, ...args], 3000);
    try {
      await call('unloadScript', 'dsh-notify-kde-focus');
      const loaded = await call('loadScript', focusScriptPath, 'dsh-notify-kde-focus');
      if (!loaded.ok) return false;
      // loadScript acknowledges before KWin has registered the script; starting
      // immediately can run nothing at all.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const started = await call('start');
      if (!started.ok) return false;
      setTimeout(() => {
        void call('unloadScript', 'dsh-notify-kde-focus').catch(() => {});
      }, 1200).unref?.();
      log('info', 'focused via kwin');
      return true;
    } catch (error) {
      log('warn', `KWin focus failed: ${String(error?.message ?? error)}`);
      return false;
    }
  }

  /** Bring the DSH window forward; the protocol launch is the non-KDE fallback. */
  async function focusWindow() {
    if (await focusViaKWin()) return true;
    try {
      const child = spawnFn(focusCommand, ['dsh://open'], { stdio: 'ignore', detached: true });
      child.on('error', (error) => log('warn', `could not focus DSH window: ${String(error?.message ?? error)}`));
      child.unref?.();
      log('info', 'focused via xdg-open');
    } catch (error) {
      log('warn', `could not focus DSH window: ${String(error?.message ?? error)}`);
    }
    return false;
  }

  /** Remember which session the user asked for, then raise the window. */
  function open(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    pending = { sessionId, at: Date.now() };
    log('info', `open requested: ${sessionId}`);
    void focusWindow();
  }

  /** The pending id, or null after the TTL. Does not consume. */
  function current() {
    if (pending === null) return null;
    if (Date.now() - pending.at > ttlMs) {
      pending = null;
      return null;
    }
    return pending.sessionId;
  }

  /** Clear the pending id once the client navigated. */
  function consume(sessionId) {
    if (pending !== null && pending.sessionId === sessionId) {
      pending = null;
      log('info', `open consumed: ${sessionId}`);
    }
  }

  /** Receive the browser half's focus truth. */
  function setFocusState({ sessionId = '', focused = false, visible = false } = {}) {
    focusState = {
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      focused: focused === true,
      visible: visible === true,
      at: Date.now(),
    };
  }

  /** True only for the session currently selected in an active, visible DSH window. */
  function isFocused(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    if (Date.now() - focusState.at > 30000) return false;
    return focusState.focused && focusState.visible && focusState.sessionId === sessionId;
  }

  function routes() {
    return [
      {
        kind: 'exact',
        path: PENDING_PATH,
        handler: (req, res) => {
          if (String(req.method ?? 'GET').toUpperCase() !== 'GET') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          const sessionId = current();
          if (sessionId === null) {
            writeEmpty(res);
            return;
          }
          writeJson(res, 200, { ok: true, sessionId });
        },
      },
      {
        kind: 'exact',
        path: RESULT_PATH,
        handler: (req, res) => {
          if (String(req.method ?? 'POST').toUpperCase() !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          let params;
          try {
            params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
          } catch {
            params = new URLSearchParams();
          }
          log('info', `navigate result: session=${params.get('session') ?? ''} current=${params.get('current') ?? ''} status=${params.get('status') ?? ''} known=${params.get('known') ?? ''} error=${params.get('error') ?? ''}`);
          if (params.get('status') === 'ok') void focusWindow();
          writeEmpty(res);
        },
      },
      {
        kind: 'exact',
        path: FOCUS_PATH,
        handler: (req, res) => {
          if (String(req.method ?? 'POST').toUpperCase() !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          let params;
          try {
            params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
          } catch {
            params = new URLSearchParams();
          }
          setFocusState({
            sessionId: params.get('session') ?? '',
            focused: params.get('focused') === '1',
            visible: params.get('visible') === '1',
          });
          writeEmpty(res);
        },
      },
      {
        kind: 'exact',
        path: HELLO_PATH,
        handler: (req, res) => {
          const method = String(req.method ?? 'GET').toUpperCase();
          if (method !== 'GET' && method !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          log('info', 'client connected');
          writeEmpty(res);
        },
      },
      {
        kind: 'exact',
        path: CONSUMED_PATH,
        handler: (req, res) => {
          if (String(req.method ?? 'POST').toUpperCase() !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          let sessionId = '';
          try {
            sessionId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId') ?? '';
          } catch {
            sessionId = '';
          }
          consume(sessionId);
          writeEmpty(res);
        },
      },
    ];
  }

  /** Register both routes; returns one disposer. */
  function register(webServer) {
    const disposers = routes().map((entry) => webServer.register(entry));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  return { open, current, consume, register, focusWindow, setFocusState, isFocused };
}
