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

export const PENDING_PATH = '/api/dsh-notify-kde/pending';
export const CONSUMED_PATH = '/api/dsh-notify-kde/consumed';
export const HELLO_PATH = '/api/dsh-notify-kde/hello';

function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

export function createOpener({ log = () => {}, spawnFn = spawn, ttlMs = 30000, focusCommand = 'xdg-open' } = {}) {
  /** @type {{sessionId: string, at: number} | null} */
  let pending = null;

  /** Bring the Electron window forward; a missing xdg-open only loses the raise. */
  function focusWindow() {
    try {
      const child = spawnFn(focusCommand, ['dsh://open'], { stdio: 'ignore', detached: true });
      child.on('error', (error) => log('warn', `could not focus DSH window: ${String(error?.message ?? error)}`));
      child.unref?.();
    } catch (error) {
      log('warn', `could not focus DSH window: ${String(error?.message ?? error)}`);
    }
  }

  /** Remember which session the user asked for, then raise the window. */
  function open(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    pending = { sessionId, at: Date.now() };
    log('info', `open requested: ${sessionId}`);
    focusWindow();
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
          writeJson(res, 200, { ok: true, sessionId: current() });
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
          writeJson(res, 200, { ok: true });
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
          writeJson(res, 200, { ok: true });
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

  return { open, current, consume, register, focusWindow };
}
