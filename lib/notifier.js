/**
 * notify-kde orchestration: turn the DSH session firehose into at most one
 * desktop notification (plus one phone ping) per moment that actually needs
 * the user.
 *
 * The notifier is deliberately separable from the plugin entry point: it takes
 * its clock, timers, command runner, environment probe and subagent counter as
 * dependencies, so the whole decision table is testable without booting DSH.
 *
 * @module dsh-notify-kde/notifier
 */

import { basename } from 'node:path';
import { configPath, loadConfig, projectLabel, saveOverride } from './config.js';
import {
  closeDesktopNotice,
  desktopNotify,
  hydrateSessionEnv,
  refreshAndRetry,
  supportedPlatform,
  tryPhone,
} from './delivery.js';
import {
  describeQuestion,
  fmtDuration,
  oneLine,
  reasonError,
  reasonKind,
  snippet,
  strings,
  textOf,
  truncatePhone,
} from './format.js';

const QUESTION_TOOLS = new Set(['ask_user_question', 'exit_plan_mode']);
const HANDLED_EVENTS = new Set(['turn/start', 'turn/end', 'tool/call', 'tool/result', 'approval/asked', 'approval/decided', 'user/message']);
const SUBAGENT_POLL_MS = 2000;

function sessionIdOf(session) {
  if (session === null || typeof session !== 'object') return '';
  return String(session.id ?? '');
}

/** Session header cwd, across the shapes DSH has used. */
function sessionCwd(session) {
  const header = session !== null && typeof session === 'object' ? session.header : undefined;
  return typeof header?.cwd === 'string' ? header.cwd : '';
}

/** Session log, preferring the public snapshot accessor. */
function sessionEvents(session) {
  try {
    if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents() ?? [];
    if (Array.isArray(session?.events)) return session.events;
  } catch {
    // A broken accessor must never break notification delivery.
  }
  return [];
}

/** Latest title: explicit header title, the last session/title event, or the cwd. */
export function sessionTitle(session) {
  const header = session !== null && typeof session === 'object' ? session.header : undefined;
  if (typeof header?.title === 'string' && header.title.trim().length > 0) return oneLine(header.title);
  const events = sessionEvents(session);
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== 'session/title') continue;
    const title = event.data?.title;
    if (typeof title === 'string' && title.trim().length > 0) return oneLine(title);
  }
  const cwd = sessionCwd(session);
  if (cwd) return oneLine(basename(cwd) || cwd);
  const id = sessionIdOf(session);
  return id ? `session-${id.slice(0, 8)}` : 'DSH';
}

/** Last assistant text of one turn, capped before display truncation. */
export function lastAssistantText(session, turn) {
  const events = sessionEvents(session);
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== 'assistant/message') continue;
    if (event.data?.turn !== turn) continue;
    const text = textOf(event.data.message);
    if (text.trim().length > 0) return text.slice(0, 4000);
  }
  return '';
}

/** `DSH · project · session`, omitting the session when it equals the project. */
export function notificationTitle(session, cfg) {
  const project = projectLabel(sessionCwd(session));
  const title = sessionTitle(session);
  const tail = title && title !== project ? `${project} · ${title}` : project;
  return cfg.titlePrefix ? `${cfg.titlePrefix} · ${tail}` : tail;
}

function clock(ms, locale) {
  return new Date(ms).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-US', { hour12: false });
}

/**
 * @param {object} options
 * @param {object} [options.patchConfig] - cordis.patch.yml `config` block.
 * @param {(level:string,message:string)=>void} [options.log]
 * @param {(command:string,args:string[],timeoutMs:number)=>Promise<{ok:boolean,out:string,err:string}>} [options.run]
 * @param {()=>number} [options.now]
 * @param {()=>boolean} [options.ensureEnv]
 * @param {(sessionId:string)=>Promise<number>} [options.countRunning]
 */
export function createNotifier({
  patchConfig = {},
  log = () => {},
  run,
  now = Date.now,
  ensureEnv = hydrateSessionEnv,
  countRunning,
  subagentPollMs = SUBAGENT_POLL_MS,
} = {}) {
  const startedAt = new Map();
  /** sessionId -> { timer, token } */
  const doneTimers = new Map();
  /** sessionId -> { timer, callId } */
  const promptTimers = new Map();
  /** approvalId -> { timer, sessionId } */
  const approvalTimers = new Map();
  /** sessionId -> last notify-send id */
  const noticeIds = new Map();
  let lastPhone;
  let lastConfigError;
  let disposed = false;

  const timerApi = {
    set: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    },
    clear: (timer) => {
      if (timer !== undefined && timer !== null) clearTimeout(timer);
    },
  };

  function logger(level, message) {
    try {
      log(level, `[dsh-notify-kde] ${message}`);
    } catch {
      // Logging must never break delivery.
    }
  }

  /** Reload configuration for every alert so edits apply without a restart. */
  function currentConfig() {
    const { config, error } = loadConfig(patchConfig);
    if (error && error !== lastConfigError) {
      lastConfigError = error;
      logger('warn', error);
    } else if (!error) {
      lastConfigError = undefined;
    }
    return config;
  }

  function clearEntry(map, key) {
    const entry = map.get(key);
    if (entry === undefined) return;
    timerApi.clear(entry.timer);
    map.delete(key);
  }

  function clearSessionTimers(sessionId) {
    clearEntry(doneTimers, sessionId);
    clearEntry(promptTimers, sessionId);
    for (const [approvalId, entry] of approvalTimers) {
      if (entry.sessionId === sessionId) clearEntry(approvalTimers, approvalId);
    }
  }

  /** Close the desktop bubble for one session. */
  async function dismiss(sessionId) {
    const id = noticeIds.get(sessionId);
    if (id === undefined) return { ok: true };
    noticeIds.delete(sessionId);
    if (!supportedPlatform()) return { ok: false };
    const result = await closeDesktopNotice(id, { run });
    if (!result.ok) logger('warn', `could not withdraw notification ${id}: ${result.error}`);
    return result;
  }

  /**
   * One alert. The desktop bubble goes out first so it is never delayed by a
   * slow phone probe; if the ping then fails, the same bubble is replaced with
   * a body that says so. The slow rescan runs afterwards, off this path.
   */
  async function dispatch({ sessionId, title, body, phoneText }) {
    if (disposed) return;
    const cfg = currentConfig();
    if (!cfg.enabled || !supportedPlatform()) return;
    if (!ensureEnv()) {
      logger('warn', 'no DBus session bus; cannot send notifications');
      return;
    }

    const s = strings(cfg.locale);
    let noticeId = cfg.coalesce ? noticeIds.get(sessionId) : undefined;

    if (cfg.desktop) {
      const sent = await desktopNotify(cfg, title, body, noticeId, { run });
      if (sent.ok) {
        logger('info', `desktop: sent${sent.id !== undefined ? ` (id ${sent.id})` : ''}`);
        if (sent.id !== undefined) {
          noticeIds.set(sessionId, sent.id);
          noticeId = sent.id;
        }
      } else {
        logger('warn', `notify-send failed: ${sent.error}`);
      }
    }

    let phone;
    if (cfg.kdeconnect) {
      try {
        phone = await tryPhone(cfg, truncatePhone(phoneText), { run });
      } catch (error) {
        phone = { ok: false, detail: String(error?.message ?? error), probed: [] };
      }
      lastPhone = { ...phone, at: now() };
      logger('info', phone.ok ? `phone: ${phone.detail}` : `phone not reached: ${phone.detail}`);

      if (cfg.desktop && cfg.annotatePhoneFailure && !phone.ok) {
        const annotated = `${body}\n${s.phoneNotReached(phone.detail)}`;
        const sent = await desktopNotify(cfg, title, annotated, noticeId, { run });
        if (sent.ok && sent.id !== undefined) noticeIds.set(sessionId, sent.id);
      }
    }

    const noneReachable = phone?.probed !== undefined && phone.probed.length === 0;
    if (cfg.kdeconnect && cfg.kdeconnectRefreshWhenOffline && noneReachable) {
      void recoverPhone(cfg, sessionId, phoneText, { title, body, noticeId });
    }
  }

  /** Background half of dispatch: rescan, poll, ping, correct the stale alert. */
  async function recoverPhone(cfg, sessionId, phoneText, alert) {
    try {
      const after = await refreshAndRetry(cfg, truncatePhone(phoneText), { run });
      if (after === undefined) {
        logger('info', 'phone still unreachable after refresh');
        return;
      }
      lastPhone = { ...after, at: now() };
      logger('info', after.ok ? `phone after refresh: ${after.detail}` : `phone still unreachable after refresh: ${after.detail}`);
      if (!after.ok) return;
      // Replace the warning line only if that exact bubble is still current.
      if (alert.noticeId !== undefined && noticeIds.get(sessionId) === alert.noticeId && cfg.desktop) {
        const sent = await desktopNotify(cfg, alert.title, alert.body, alert.noticeId, { run });
        if (sent.ok && sent.id !== undefined) noticeIds.set(sessionId, sent.id);
      }
    } catch (error) {
      logger('warn', `phone recovery failed: ${String(error?.message ?? error)}`);
    }
  }

  /**
   * Wait until the session's subagent tree settles, then announce the turn.
   * A new turn/start cancels the pending announcement (the work is ongoing).
   */
  function scheduleDone(sessionId, cfg, payload) {
    const deadline = now() + cfg.subagentWaitMs;
    const token = {};
    doneTimers.set(sessionId, { timer: undefined, token });

    const check = async () => {
      if (disposed || doneTimers.get(sessionId)?.token !== token) return;
      let running = 0;
      try {
        running = typeof countRunning === 'function' ? await countRunning(sessionId) : 0;
      } catch (error) {
        logger('warn', `cannot count running subagents: ${String(error?.message ?? error)}`);
      }
      if (disposed || doneTimers.get(sessionId)?.token !== token) return;
      if (running === 0 || now() >= deadline) {
        clearEntry(doneTimers, sessionId);
        void dispatch(payload).catch((error) => logger('warn', `done notification failed: ${String(error?.message ?? error)}`));
        return;
      }
      const entry = doneTimers.get(sessionId);
      if (entry === undefined || entry.token !== token) return;
      entry.timer = timerApi.set(() => void check(), subagentPollMs);
    };

    void check();
  }

  function onTurnEnd(session, event) {
    const sessionId = sessionIdOf(session);
    if (!sessionId) return;
    const cfg = currentConfig();
    const data = event.data ?? {};
    const kind = reasonKind(data.reason);
    const duration = startedAt.has(sessionId) ? now() - startedAt.get(sessionId) : 0;
    startedAt.delete(sessionId);

    clearSessionTimers(sessionId);

    if (!cfg.enabled) return;
    if (kind === 'forked') return;
    if (kind === 'aborted' && cfg.suppressWhenAborted) return;
    if (kind === 'completed' && !cfg.notifyOnDone) return;
    if (kind === 'error' && !cfg.notifyOnError) return;
    if ((kind === 'blocked' || kind === 'max-tokens') && !cfg.notifyOnBlocked) return;

    const isQuick = kind === 'completed';
    if (isQuick && duration < cfg.minDurationMs) return;

    const s = strings(cfg.locale);
    const title = notificationTitle(session, cfg);
    const head = kind === 'completed'
      ? s.done(fmtDuration(duration, cfg.locale))
      : kind === 'error'
        ? s.failed(fmtDuration(duration, cfg.locale))
        : s.blocked(kind === 'max-tokens' ? 'max tokens' : kind);

    const detail = kind === 'error' ? oneLine(reasonError(data.reason), 180) : '';
    const summary = cfg.includeSnippet ? snippet(lastAssistantText(session, data.turn), cfg.snippetChars) : '';
    const bodyParts = [head];
    if (detail) bodyParts.push(detail);
    if (summary) bodyParts.push(summary);

    const body = bodyParts.join('\n');
    const phoneText = `${title}: ${head}${summary ? ` · ${summary}` : ''}`;

    scheduleDone(sessionId, cfg, { sessionId, title, body, phoneText });
  }

  function onTurnStart(session) {
    const sessionId = sessionIdOf(session);
    if (!sessionId) return;
    startedAt.set(sessionId, now());
    // A new turn supersedes any pending "done" for the previous work.
    clearEntry(doneTimers, sessionId);
  }

  function onToolCall(session, event) {
    const sessionId = sessionIdOf(session);
    const name = event.data?.name;
    if (!sessionId || !QUESTION_TOOLS.has(name)) return;
    const cfg = currentConfig();
    if (!cfg.enabled || !cfg.notifyOnUiPrompt) return;

    clearEntry(promptTimers, sessionId);
    const s = strings(cfg.locale);
    const title = notificationTitle(session, cfg);
    const what = describeQuestion(name, event.data?.arguments);
    const body = s.waiting(what);
    const phoneText = `${title}: ⏳ ${what}`;
    const callId = String(event.data?.callId ?? '');

    const fire = () => {
      promptTimers.delete(sessionId);
      if (disposed) return;
      void dispatch({ sessionId, title, body, phoneText }).catch((error) => logger('warn', `prompt notification failed: ${String(error?.message ?? error)}`));
    };

    if (cfg.uiPromptDelayMs === 0) {
      fire();
      return;
    }
    promptTimers.set(sessionId, {
      callId,
      timer: timerApi.set(fire, cfg.uiPromptDelayMs),
    });
  }

  function onToolResult(session, event) {
    const sessionId = sessionIdOf(session);
    const pending = promptTimers.get(sessionId);
    if (pending === undefined) return;
    const callId = String(event.data?.message?.toolCallId ?? event.data?.callId ?? '');
    if (callId && pending.callId && callId !== pending.callId) return;
    clearEntry(promptTimers, sessionId);
  }

  function onApprovalAsked(session, event) {
    const sessionId = sessionIdOf(session);
    const approvalId = String(event.data?.id ?? '');
    if (!sessionId || !approvalId) return;
    const cfg = currentConfig();
    if (!cfg.enabled || !cfg.notifyOnApproval) return;

    clearEntry(approvalTimers, approvalId);
    const s = strings(cfg.locale);
    const title = notificationTitle(session, cfg);
    const tool = String(event.data?.toolName ?? 'tool');
    const reason = oneLine(event.data?.reason ?? '', 100);
    const body = s.approval(tool, reason);
    const phoneText = `${title}: ⏳ ${tool}${reason ? ` — ${reason}` : ''}`;

    const fire = () => {
      approvalTimers.delete(approvalId);
      if (disposed) return;
      void dispatch({ sessionId, title, body, phoneText }).catch((error) => logger('warn', `approval notification failed: ${String(error?.message ?? error)}`));
    };

    if (cfg.approvalDelayMs === 0) {
      fire();
      return;
    }
    approvalTimers.set(approvalId, {
      sessionId,
      timer: timerApi.set(fire, cfg.approvalDelayMs),
    });
  }

  function onApprovalDecided(event) {
    const approvalId = String(event.data?.id ?? '');
    if (approvalId) clearEntry(approvalTimers, approvalId);
  }

  function onUserMessage(session, event) {
    const sessionId = sessionIdOf(session);
    if (!sessionId) return;
    const source = event.data?.source;
    const kind = typeof source === 'object' && source !== null ? source.kind : source;
    if (kind !== 'user') return;
    const cfg = currentConfig();
    if (!cfg.enabled || !cfg.dismissOnReturn) return;
    void dismiss(sessionId).catch((error) => logger('warn', `could not dismiss notification: ${String(error?.message ?? error)}`));
  }

  function onSessionEvent(session, event) {
    if (disposed || event === null || typeof event !== 'object') return;
    if (!HANDLED_EVENTS.has(event.type)) return;
    try {
      const header = session?.header;
      const preset = typeof header?.agentPreset === 'string' ? header.agentPreset : '';
      const cfg = currentConfig();
      // IM bridges (Aurabot/QQ, Telegram, ...) run their own long sessions; the
      // desktop user is not the one waiting for those turns.
      if (preset && cfg.ignoreAgentPresets.includes(preset)) return;
      // A subagent's own session is a step of the parent turn: its completion
      // is covered by the parent's tree-settled alert, and its questions are
      // answered by the orchestrator. Alerting per child is pure noise.
      if (event.type !== 'turn/start' && header?.origin === 'subagent' && cfg.suppressSubagentSessions) {
        return;
      }
      switch (event.type) {
        case 'turn/start':
          onTurnStart(session);
          break;
        case 'turn/end':
          onTurnEnd(session, event);
          break;
        case 'tool/call':
          onToolCall(session, event);
          break;
        case 'tool/result':
          onToolResult(session, event);
          break;
        case 'approval/asked':
          onApprovalAsked(session, event);
          break;
        case 'approval/decided':
          onApprovalDecided(event);
          break;
        case 'user/message':
          onUserMessage(session, event);
          break;
        default:
          break;
      }
    } catch (error) {
      logger('warn', `session event ${String(event.type)} failed: ${String(error?.message ?? error)}`);
    }
  }

  function onSessionDisposed(session) {
    const sessionId = sessionIdOf(session);
    if (!sessionId) return;
    clearSessionTimers(sessionId);
    startedAt.delete(sessionId);
    noticeIds.delete(sessionId);
  }

  async function test() {
    const cfg = currentConfig();
    const title = `${cfg.titlePrefix ? `${cfg.titlePrefix} · ` : ''}notify-kde 测试`;
    const body = `${strings(cfg.locale).testBody}\n${new Date(now()).toLocaleString(cfg.locale === 'zh' ? 'zh-CN' : 'en-US')}`;
    await dispatch({ sessionId: '__notify_kde_test__', title, body, phoneText: `${title}: ${strings(cfg.locale).testBody}` });
    return { config: cfg, phone: lastPhone };
  }

  /**
   * Add or remove ignored agent presets, persisting the new list.
   * `/notify-kde ignore aurabot-private` is the user-facing entry point.
   */
  function updateIgnorePresets({ add = [], remove = [] } = {}) {
    const cfg = currentConfig();
    const next = new Set(cfg.ignoreAgentPresets);
    for (const name of add) {
      if (typeof name === 'string' && name.trim().length > 0) next.add(name.trim());
    }
    for (const name of remove) next.delete(name);
    const values = [...next];
    saveOverride('ignoreAgentPresets', values);
    return values;
  }

  function status() {
    const cfg = currentConfig();
    const s = strings(cfg.locale);
    const lines = [
      `notify-kde ${cfg.enabled ? s.enabled : s.disabled} · 阈值 ${cfg.minDurationMs}ms · 提问延迟 ${cfg.uiPromptDelayMs}ms`,
      `桌面 ${cfg.desktop ? '开' : '关'}（${cfg.desktopTimeoutMs}ms） · 手机 ${cfg.kdeconnect ? '开' : '关'}`,
      `忽略 preset：${cfg.ignoreAgentPresets.length ? cfg.ignoreAgentPresets.join(', ') : '无'}`,
      `config: ${configPath()}`,
      lastPhone ? s.lastAt(clock(lastPhone.at, cfg.locale), lastPhone.ok, lastPhone.detail) : s.lastNever,
    ];
    if (!ensureEnv()) lines.push(s.noDbus);
    if (!supportedPlatform()) lines.push(`unsupported platform: ${process.platform}`);
    return { config: cfg, text: lines.join('\n') };
  }

  function toggle(enabled) {
    const file = saveOverride('enabled', Boolean(enabled));
    return { enabled: Boolean(enabled), file };
  }

  function dispose() {
    disposed = true;
    for (const map of [doneTimers, promptTimers, approvalTimers]) {
      for (const entry of map.values()) timerApi.clear(entry.timer);
      map.clear();
    }
    startedAt.clear();
    noticeIds.clear();
  }

  return {
    onSessionEvent,
    onSessionDisposed,
    dismiss,
    dispose,
    status,
    test,
    toggle,
    updateIgnorePresets,
    lastPhone: () => lastPhone,
  };
}
