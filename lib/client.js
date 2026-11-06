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

      function consume(sessionId) {
        try {
          global.fetch(CONSUMED + '?sessionId=' + encodeURIComponent(sessionId), {
            method: 'POST',
            cache: 'no-store',
          }).catch(function () {});
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
          global.fetch(RESULT + query, { method: 'POST', cache: 'no-store' }).catch(function () {});
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

        function poll() {
          if (disposed || inflight || navigating) return;
          inflight = true;
          try {
            global.fetch(PENDING, { cache: 'no-store' })
              .then(function (response) {
                if (!response || !response.ok) return null;
                return response.json();
              })
              .then(function (body) {
                inflight = false;
                if (disposed || !body || typeof body.sessionId !== 'string' || body.sessionId.length === 0) return;
                navigating = true;
                Promise.resolve(navigate(ctx, body.sessionId)).then(function (result) {
                  if (!result) return;
                  // A missing service is retried; a rejected/stale session is not.
                  if (result.state === 'ok' || result.state === 'ok-fallback' || result.state === 'failed') {
                    report(body.sessionId, result, ctx);
                    consume(body.sessionId);
                  }
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
          global.fetch(HELLO, { method: 'POST', cache: 'no-store' }).catch(function () {});
        } catch (error) {}

        var onFocus = function () { poll(); };
        timer = global.setInterval(poll, POLL_MS);
        try { global.addEventListener('focus', onFocus); } catch (error) {}

        var dispose = function () {
          disposed = true;
          if (timer !== null) global.clearInterval(timer);
          try { global.removeEventListener('focus', onFocus); } catch (error) {}
        };
        try {
          if (ctx && typeof ctx.effect === 'function') ctx.effect(function () { return dispose; }, 'dsh-notify-kde: open-session poll');
          else dispose();
        } catch (error) {
          dispose();
        }

        poll();
      }

      exports.inject = [];
      exports.apply = apply;
      return module.exports;
    },
  });
})(typeof window !== 'undefined' ? window : null);
