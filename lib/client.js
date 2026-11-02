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
      function navigate(ctx, sessionId) {
        try { global.focus(); } catch (error) {}
        var workspace = lookup(ctx, 'uiWorkspace');
        if (workspace && typeof workspace.openSession === 'function') {
          try {
            workspace.openSession(sessionId);
            return 'ok';
          } catch (error) {
            return 'failed';
          }
        }
        var sessions = lookup(ctx, 'sessions');
        if (sessions && typeof sessions.open === 'function') {
          try {
            sessions.open(sessionId);
            return 'ok';
          } catch (error) {
            return 'failed';
          }
        }
        return 'wait';
      }

      function apply(ctx) {
        var disposed = false;
        var inflight = false;
        var timer = null;

        function poll() {
          if (disposed || inflight) return;
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
                var state = navigate(ctx, body.sessionId);
                // A missing service is retried; a rejected/stale session is not.
                if (state === 'ok' || state === 'failed') consume(body.sessionId);
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
