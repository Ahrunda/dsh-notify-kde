/**
 * dsh-notify-kde — KDE desktop bubble plus a KDE Connect phone ping when DSH
 * needs you: a turn finished, an approval is waiting, or the model asked a
 * question and is blocked on your answer.
 *
 * Host-side on purpose: the DSH desktop app keeps running (and keeps this
 * listener alive) even when its window is minimized or closed to the tray, so
 * the alert does not depend on a browser tab being visible.
 *
 * @module dsh-notify-kde
 */

import { appendLog } from './lib/log.js';
import { createNotifier } from './lib/notifier.js';

/** The plugin's package name; it must match package.json. */
export const name = 'dsh-notify-kde';

/** The durable session firehose only exists once a SessionStore is composed. */
export const inject = ['sessions'];

/**
 * Count live agents still running in one session's descendant subagent tree.
 *
 * The `subagents` service is the authoritative listing; the agents registry is
 * the fallback for hosts that do not expose it. Both are optional so the
 * plugin keeps loading on a slimmer profile.
 *
 * @param {import('cordis').Context} ctx
 * @param {string} sessionId
 * @returns {Promise<number>}
 */
export async function countRunningSubagents(ctx, sessionId) {
  const agents = ctx.get('agents', false);
  if (agents === undefined || typeof agents.get !== 'function') return 0;
  const owner = agents.get(sessionId);
  if (owner === undefined) return 0;

  const subagents = ctx.get('subagents', false);
  let ids = [];
  let listed = false;
  if (subagents !== undefined && typeof subagents.listDescendants === 'function') {
    try {
      const rows = await subagents.listDescendants(sessionId);
      ids = rows
        .filter((row) => row?.kind === undefined || row.kind === 'child')
        .map((row) => row.id)
        .filter((id) => typeof id === 'string' && id !== sessionId);
      listed = true;
    } catch {
      // Listing unavailable: fall back to the live registry below.
    }
  }
  if (!listed) {
    if (typeof agents.list !== 'function' || typeof agents.isOwnedBy !== 'function') return 0;
    ids = agents
      .list()
      .filter((candidate) => candidate !== owner && agents.isOwnedBy(candidate.id, owner))
      .map((candidate) => candidate.id);
  }

  let running = 0;
  for (const id of ids) {
    const agent = agents.get(id);
    if (agent !== undefined && agent.status === 'running') running++;
  }
  return running;
}

/**
 * Mount the plugin.
 *
 * @param {import('cordis').Context} ctx
 * @param {object} config - this row's `config` from cordis.patch.yml.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger;
  const log = (level, message) => {
    appendLog(level, message);
    const sink = logger !== undefined && typeof logger[level] === 'function' ? logger[level].bind(logger) : undefined;
    if (sink !== undefined) {
      sink(message);
      return;
    }
    if (level === 'warn' || level === 'error') console.warn(message);
    else console.log(message);
  };

  const notifier = createNotifier({
    patchConfig: config !== null && typeof config === 'object' ? config : {},
    log,
    countRunning: (sessionId) => countRunningSubagents(ctx, sessionId),
  });

  ctx.on('session/event', (session, event) => notifier.onSessionEvent(session, event));
  ctx.on('session/disposed', (session) => notifier.onSessionDisposed(session));

  // The command surface is optional: headless profiles compose no command UI.
  const commands = ctx.get('commands', false);
  if (commands !== undefined && typeof commands.register === 'function') {
    ctx.effect(() => commands.register({
      name: 'notify-kde',
      description: 'notify-kde: 桌面通知 + KDE Connect 手机推送（status | test | on | off | ignore）',
      input: { hint: 'status | test | on | off | ignore <preset...>' },
      async handler({ rawInput }) {
        const sub = String(rawInput ?? '').trim().toLowerCase();
        if (sub === 'on' || sub === 'off') {
          const enabled = sub === 'on';
          const result = notifier.toggle(enabled);
          return { kind: 'success', text: `notify-kde 已${enabled ? '开启' : '停用'}（${result.file}）` };
        }
        const parts = sub.split(/\s+/).filter(Boolean);
        if (parts[0] === 'ignore' || parts[0] === 'unignore') {
          const names = parts.slice(1);
          if (names.length === 0) {
            return { kind: 'error', text: '用法：/notify-kde ignore <preset...> 或 /notify-kde unignore <preset...>' };
          }
          const next = notifier.updateIgnorePresets(parts[0] === 'ignore' ? { add: names } : { remove: names });
          return {
            kind: 'success',
            text: `已忽略 preset：${next.length ? next.join(', ') : '（无）'}`,
          };
        }
        if (sub === 'test') {
          const result = await notifier.test();
          const phone = result.phone;
          const phoneText = phone === undefined
            ? '手机：未尝试'
            : phone.ok
              ? `手机：${phone.detail}`
              : `手机：未送达（${phone.detail}）`;
          return {
            kind: phone !== undefined && !phone.ok ? 'error' : 'success',
            text: `测试通知已发送 · 桌面：${result.config.desktop ? '开' : '关'} · ${phoneText}`,
          };
        }
        const status = notifier.status();
        return { kind: 'success', text: status.text };
      },
    }), 'dsh-notify-kde: /notify-kde');
  }

  ctx.effect(() => () => notifier.dispose(), 'dsh-notify-kde: delivery timers');
}
