/**
 * dsh-notify-kde — browser half.
 *
 * A notification click happens in the host process, which leaves a short-lived
 * pending session id on `/api/dsh-notify-kde/pending`. This module polls that
 * route (and re-checks on window focus) and then asks the client workspace
 * service to make that session current. It never raises the window: the host
 * already did that with `dsh://open`.
 *
 * Loaded by dsh-client-modules as a lazy-CJS bundle, same shape as the shipped
 * ui-* packages.
 */
(function (global) {
  'use strict';
  if (!global || !global.__ModuleLoader__) return;

  global.__ModuleLoader__.load({
    id: 'dsh-notify-kde',
    factory: function () {
      var module = { exports: {} };
      var exports = module.exports;

      var POLL_MS = 700;
      var PENDING = '/api/dsh-notify-kde/pending';
      var CONSUMED = '/api/dsh-notify-kde/consumed';
      var HELLO = '/api/dsh-notify-kde/hello';
      var RESULT = '/api/dsh-notify-kde/result';
      var FOCUS = '/api/dsh-notify-kde/focus';

      function lookup(ctx, name) {
        var service = null;
        try {
          if (ctx && typeof ctx.get === 'function') service = ctx.get(name) || null;
        } catch (error) {
          service = null;
        }
        if (service) return service;
        try {
          if (ctx && ctx.reflect && typeof ctx.reflect.get === 'function') service = ctx.reflect.get(name) || null;
        } catch (error) {
          service = null;
        }
        if (service) return service;
        try {
          if (ctx && name in ctx) service = ctx[name] || null;
        } catch (error) {
          service = null;
        }
        return service;
      }

      /** Deadline for the tiny status requests; a stalled host must not queue them. */
      var FETCH_TIMEOUT_MS = 5000;

      /**
       * Release a response body we never read. Chromium keeps the shared-memory
       * file descriptor of an unread `no-store` body, and a heartbeat that leaks
       * one buffer per tick eventually exhausts the renderer's fd limit.
       */
      function discardResponse(response) {
        if (!response || !response.body) return undefined;
        try {
          return Promise.resolve(response.body.cancel()).catch(function () {});
        } catch (error) {
          return undefined;
        }
      }

      /** Abort a request the host cannot answer, instead of letting it pile up. */
      function abortSignal(ms) {
        try {
          if (global.AbortSignal && typeof global.AbortSignal.timeout === 'function') {
            return global.AbortSignal.timeout(ms);
          }
        } catch (error) {}
        return undefined;
      }

      function consume(sessionId) {
        try {
          global.fetch(CONSUMED + '?sessionId=' + encodeURIComponent(sessionId), {
            method: 'POST',
            cache: 'no-store',
            signal: abortSignal(FETCH_TIMEOUT_MS),
          }).then(discardResponse).catch(function () {});
        } catch (error) {
          // The host may be older than this client half; navigation still happened.
        }
      }

      /**
       * Make the session current. `uiWorkspace.openSession` is the 0.1.6+ verb;
       * `sessions.open` is the older one. Returns false while neither service
       * is available yet, so the pending id is retried instead of consumed.
       */
      function knownSession(ctx, sessionId) {
        var sessions = lookup(ctx, 'sessions');
        try {
          var snapshot = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined;
          return snapshot && snapshot.byId && snapshot.byId[sessionId] ? 'yes' : 'no';
        } catch (error) {
          return 'unknown';
        }
      }

      function report(sessionId, result, ctx) {
        // Visible from outside without DevTools: the DSH desktop keeps
        // localStorage in a LevelDB file, so a failed navigation leaves a trace.
        try {
          global.localStorage.setItem('dsh.notify.last-navigation', JSON.stringify({
            sessionId: sessionId,
            status: result.state,
            current: result.current || '',
            known: knownSession(ctx, sessionId),
            error: result.error || '',
            at: Date.now(),
          }));
        } catch (error) {}
        try {
          var query = '?session=' + encodeURIComponent(sessionId)
            + '&current=' + encodeURIComponent(result.current || '')
            + '&status=' + encodeURIComponent(result.state)
            + '&known=' + encodeURIComponent(knownSession(ctx, sessionId))
            + '&error=' + encodeURIComponent(result.error || '');
          global.fetch(RESULT + query, {
            method: 'POST',
            cache: 'no-store',
            signal: abortSignal(FETCH_TIMEOUT_MS),
          }).then(discardResponse).catch(function () {});
        } catch (error) {}
      }

      function selectionOf(workspace) {
        try {
          var selection = workspace && workspace.selection;
          return selection && typeof selection.getSnapshot === 'function' ? selection.getSnapshot().sessionId : '';
        } catch (error) {
          return '';
        }
      }

      function workspaceList(ctx) {
        try {
          var workspaces = lookup(ctx, 'workspaces');
          var snapshot = workspaces && workspaces.list && typeof workspaces.list.getSnapshot === 'function' ? workspaces.list.getSnapshot() : undefined;
          return snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
        } catch (error) {
          return [];
        }
      }

      /**
       * Open the session. A session in another workspace must switch that
       * workspace first; `openSession` alone only moves the selection and the
       * main view stays on the old workspace.
       */
      function navigate(ctx, sessionId) {
        try { global.focus(); } catch (error) {}
        var workspace = lookup(ctx, 'uiWorkspace');
        if (!workspace || typeof workspace.openSession !== 'function') {
          var sessions = lookup(ctx, 'sessions');
          if (sessions && typeof sessions.open === 'function') {
            try {
              sessions.open(sessionId);
              return Promise.resolve({ state: 'ok-fallback', current: '' });
            } catch (error) {
              return Promise.resolve({ state: 'failed', error: String(error && error.message ? error.message : error) });
            }
          }
          return Promise.resolve({ state: 'wait' });
        }

        var items = workspaceList(ctx);
        var currentId = selectionOf(workspace);
        var currentWorkspace = items.find(function (item) { return (item.sessionIds || []).indexOf(currentId) >= 0; });
        var targetWorkspace = items.find(function (item) { return (item.sessionIds || []).indexOf(sessionId) >= 0; });

        var open = function () {
          try {
            workspace.openSession(sessionId);
            return { state: 'ok', current: selectionOf(workspace) };
          } catch (error) {
            return { state: 'failed', error: String(error && error.message ? error.message : error) };
          }
        };

        if (targetWorkspace && currentWorkspace && targetWorkspace.workspaceId !== currentWorkspace.workspaceId && typeof workspace.openWorkspace === 'function') {
          try {
            var switched = workspace.openWorkspace(targetWorkspace.workspaceId);
            return Promise.resolve(switched).then(open, function (error) {
              return { state: 'failed', error: String(error && error.message ? error.message : error) };
            });
          } catch (error) {
            return Promise.resolve({ state: 'failed', error: String(error && error.message ? error.message : error) });
          }
        }
        return Promise.resolve(open());
      }

      function apply(ctx) {
        var disposed = false;
        var inflight = false;
        var navigating = false;
        var timer = null;
        var focusTimer = null;
        var unsubscribeSelection = null;

        function reportFocus() {
          if (disposed) return;
          try {
            var workspace = lookup(ctx, 'uiWorkspace');
            var selection = workspace && workspace.selection && typeof workspace.selection.getSnapshot === 'function' ? workspace.selection.getSnapshot() : undefined;
            var sessionId = selection && typeof selection.sessionId === 'string' ? selection.sessionId : '';
            var focused = global.document && typeof global.document.hasFocus === 'function' ? global.document.hasFocus() : false;
            var visible = global.document ? global.document.visibilityState !== 'hidden' : false;
            global.fetch(FOCUS + '?session=' + encodeURIComponent(sessionId) + '&focused=' + (focused ? '1' : '0') + '&visible=' + (visible ? '1' : '0'), {
              method: 'POST',
              cache: 'no-store',
              signal: abortSignal(FETCH_TIMEOUT_MS),
            }).then(discardResponse).catch(function () {});
          } catch (error) {}
        }

        function poll() {
          if (disposed || inflight || navigating) return;
          // A hidden window cannot show the result of a click handoff; polling it
          // only churns response buffers. `visibilitychange` resumes immediately.
          if (global.document && global.document.visibilityState === 'hidden') return;
          inflight = true;
          try {
            global.fetch(PENDING, { cache: 'no-store', signal: abortSignal(FETCH_TIMEOUT_MS) })
              .then(function (response) {
                if (!response) return null;
                // The host answers 204 when nothing is pending: no body to release.
                if (!response.ok || response.status === 204) {
                  return Promise.resolve(discardResponse(response)).then(function () { return null; });
                }
                return response.json();
              })
              .then(function (body) {
                inflight = false;
                if (disposed || !body || typeof body.sessionId !== 'string' || body.sessionId.length === 0) return;
                navigating = true;
                var navigated;
                try {
                  navigated = navigate(ctx, body.sessionId);
                } catch (error) {
                  navigated = { state: 'failed', error: String(error && error.message ? error.message : error) };
                }
                // The guard is reset in `finally`: a stuck flag would silently stop
                // every later click handoff until the page reloads.
                Promise.resolve(navigated).then(function (result) {
                  if (!result) return;
                  // A missing service is retried; a rejected/stale session is not.
                  if (result.state === 'ok' || result.state === 'ok-fallback' || result.state === 'failed') {
                    report(body.sessionId, result, ctx);
                    consume(body.sessionId);
                  }
                }).catch(function () {
                  // Navigation failure must never wedge the poll loop.
                }).finally(function () {
                  navigating = false;
                });
              })
              .catch(function () {
                inflight = false;
              });
          } catch (error) {
            inflight = false;
          }
        }

        // A one-shot heartbeat: the host log then says whether this half loaded.
        try {
          global.fetch(HELLO, {
            method: 'POST',
            cache: 'no-store',
            signal: abortSignal(FETCH_TIMEOUT_MS),
          }).then(discardResponse).catch(function () {});
        } catch (error) {}

        var onFocus = function () { poll(); reportFocus(); };
        var onVisibility = function () {
          reportFocus();
          // Back from hidden/minimized: resume the handoff poll right away.
          if (!global.document || global.document.visibilityState !== 'hidden') poll();
        };
        timer = global.setInterval(poll, POLL_MS);
        focusTimer = global.setInterval(reportFocus, 2000);
        try { global.addEventListener('focus', onFocus); } catch (error) {}
        try { global.addEventListener('blur', reportFocus); } catch (error) {}
        try { global.addEventListener('visibilitychange', onVisibility); } catch (error) {}
        try {
          var workspace = lookup(ctx, 'uiWorkspace');
          if (workspace && workspace.selection && typeof workspace.selection.subscribe === 'function') {
            unsubscribeSelection = workspace.selection.subscribe(reportFocus);
          }
        } catch (error) {}

        var dispose = function () {
          disposed = true;
          if (timer !== null) global.clearInterval(timer);
          if (focusTimer !== null) global.clearInterval(focusTimer);
          try { global.removeEventListener('focus', onFocus); } catch (error) {}
          try { global.removeEventListener('blur', reportFocus); } catch (error) {}
          try { global.removeEventListener('visibilitychange', onVisibility); } catch (error) {}
          try { if (typeof unsubscribeSelection === 'function') unsubscribeSelection(); } catch (error) {}
        };
        try {
          if (ctx && typeof ctx.effect === 'function') ctx.effect(function () { return dispose; }, 'dsh-notify-kde: open-session poll');
          else dispose();
        } catch (error) {
          dispose();
        }

        poll();
        reportFocus();
      }

      exports.inject = [];
      exports.apply = apply;
      return module.exports;
    },
  });
})(typeof window !== 'undefined' ? window : null);
