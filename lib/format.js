/**
 * Pure formatting helpers and argv builders for notify-kde.
 *
 * Nothing in this module touches the filesystem, the clock, or a child
 * process, so every rule here is unit-testable in isolation.
 *
 * @module dsh-notify-kde/format
 */

/** Collapse a markdown reply into one notification-sized line. */
export function snippet(text, max = 140) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return '';
  return cleaned.length > max ? `${cleaned.slice(0, Math.max(1, max - 1))}…` : cleaned;
}

/** First non-empty line, flattened and truncated. */
export function brief(text, max = 100) {
  if (typeof text !== 'string') return '';
  const line = (text.split('\n').find((item) => item.trim().length > 0) ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Flatten an assistant message into plain text (string content or text parts). */
export function textOf(message) {
  const content = message !== null && typeof message === 'object' ? message.content : undefined;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/** Human duration, localized. */
export function fmtDuration(ms, locale = 'zh') {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const zh = locale === 'zh';
  const sec = zh ? '秒' : 's';
  const min = zh ? '分' : 'm';
  const hour = zh ? '小时' : 'h';
  if (total < 60) return `${total}${sec}`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s ? `${m}${min} ${s}${sec}` : `${m}${min}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}${hour} ${rm}${min}` : `${h}${hour}`;
}

/** One-line session label: the title, or the workspace directory name. */
export function oneLine(text, max = 48) {
  const value = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
}

/** Keep the phone-side text within what a notification can show. */
export function truncatePhone(text, max = 300) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * notify-send argv.
 *
 * `--` is load-bearing: without it notify-send parses a title or body that
 * starts with `-` as one of its own options and the whole call fails.
 */
export function buildNotifyArgs(cfg, title, body, replaceId) {
  const args = ['-a', 'DSH', '-u', cfg.urgency, '-t', String(cfg.desktopTimeoutMs), '-p'];
  if (replaceId !== undefined && replaceId !== null) args.push('-r', String(replaceId));
  if (cfg.icon) args.push('-i', cfg.icon);
  args.push('--', title, body);
  return args;
}

/** gdbus argv that withdraws a notification we sent earlier. */
export function buildCloseArgs(id) {
  return [
    'call',
    '--session',
    '--dest',
    'org.freedesktop.Notifications',
    '--object-path',
    '/org/freedesktop/Notifications',
    '--method',
    'org.freedesktop.Notifications.CloseNotification',
    String(id),
  ];
}

/** kdeconnect-cli argv for one ping. */
export function buildPingArgs(deviceId, text) {
  return ['--ping-msg', text, '-d', deviceId];
}

/**
 * Delays between polls of `kdeconnect-cli -a`, growing geometrically.
 *
 * `kdeconnect-cli --refresh` returns in milliseconds because it only asks
 * kdeconnectd to rescan; the device appears seconds later. Polling is the
 * whole point of this function.
 */
export function pollDelays(timeoutMs, start = 250, factor = 1.6, cap = 1000) {
  const out = [];
  let delay = start;
  let total = 0;
  while (total + delay <= timeoutMs) {
    out.push(Math.round(delay));
    total += delay;
    delay = Math.min(delay * factor, cap);
  }
  return out;
}

/** `reason` shapes seen on turn/end: a string, or `{kind, error}`. */
export function reasonKind(reason) {
  if (typeof reason === 'string') return reason;
  if (reason !== null && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind;
  return 'unknown';
}

/** Error text carried by an `{kind:'error', error:{message}}` turn reason. */
export function reasonError(reason) {
  if (reason === null || typeof reason !== 'object') return '';
  const failure = reason.error;
  if (typeof failure === 'string') return failure;
  if (failure !== null && typeof failure === 'object' && typeof failure.message === 'string') return failure.message;
  if (typeof reason.message === 'string') return reason.message;
  return '';
}

/** Parse the raw tool-call `arguments` field (JSON string or already-parsed object). */
export function parseToolArguments(raw) {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Short description of what a blocking tool call is asking for.
 *
 * `ask_user_question` carries structured questions; `exit_plan_mode` is the
 * plan-review question. Anything else falls back to the tool name.
 */
export function describeQuestion(toolName, rawArguments) {
  const args = parseToolArguments(rawArguments);
  if (toolName === 'ask_user_question') {
    const question = Array.isArray(args?.questions) ? args.questions[0] : undefined;
    const text = question?.header ?? question?.question ?? question?.id;
    if (typeof text === 'string' && text.trim().length > 0) return oneLine(text, 80);
    return '有问题等你回答';
  }
  if (toolName === 'exit_plan_mode') return '方案待你确认';
  return toolName ? `等你处理 ${toolName}` : '在等你回答';
}

/** Localized notification wording. */
const STRINGS = {
  en: {
    done: (duration) => `✅ Done · ${duration}`,
    failed: (duration) => `⚠️ Failed · ${duration}`,
    blocked: (reason) => `⏸ Stopped · ${reason}`,
    waiting: (what) => `⏳ DSH is waiting for you · ${what}`,
    approval: (tool, reason) => `⏳ Approval needed · ${tool}${reason ? ` — ${reason}` : ''}`,
    phoneNotReached: (detail) => `⚠️ Phone not reached (${detail})`,
    noDevice: 'no paired device is reachable',
    pingFailed: (detail) => `ping failed: ${detail}`,
    sentToOne: 'sent to the phone',
    sentToMany: (count) => `sent to ${count} devices`,
    testHead: '🔔 Test notification',
    testBody: 'If you can see this, the chain works',
    enabled: 'enabled',
    disabled: 'disabled',
    noDbus: 'no session DBus (notifications cannot be sent)',
    lastNever: 'last phone delivery: none yet in this session',
    lastAt: (clock, ok, detail) => `last phone delivery: ${clock} ${ok ? '✅ delivered' : `❌ ${detail}`}`,
    switched: (on) => `notifications ${on ? 'enabled' : 'disabled'}`,
    testSent: (desktop, phone) => `test notification sent (desktop ${desktop ? 'on' : 'off'}, phone ${phone ? 'on' : 'off'})`,
    unreadable: (message) => `config problem: ${message}`,
  },
  zh: {
    done: (duration) => `✅ 跑完了 · ${duration}`,
    failed: (duration) => `⚠️ 出错了 · ${duration}`,
    blocked: (reason) => `⏸ 停下来了 · ${reason}`,
    waiting: (what) => `⏳ DSH 挂着等你 · ${what}`,
    approval: (tool, reason) => `⏳ 等你批准 · ${tool}${reason ? ` — ${reason}` : ''}`,
    phoneNotReached: (detail) => `⚠️ 手机未送达（${detail}）`,
    noDevice: '无在线且已配对的设备',
    pingFailed: (detail) => `ping 失败：${detail}`,
    sentToOne: '已推送到手机',
    sentToMany: (count) => `已推送到 ${count} 台设备`,
    testHead: '🔔 测试通知',
    testBody: '看到就说明桌面通知和手机推送的链路通了',
    enabled: '启用',
    disabled: '停用',
    noDbus: '⚠️ 无 DBus（提醒不会发）',
    lastNever: '上次手机投递：本次会话还没有发过',
    lastAt: (clock, ok, detail) => `上次手机投递：${clock} ${ok ? '✅ 已送达' : `❌ ${detail}`}`,
    switched: (on) => `通知已${on ? '开启' : '停用'}`,
    testSent: (desktop, phone) => `测试通知已发（桌面 ${desktop ? '开' : '关'} / 手机 ${phone ? '开' : '关'}）`,
    unreadable: (message) => `配置有问题：${message}`,
  },
};

/** Pick the string table for a locale. */
export function strings(locale) {
  return STRINGS[locale] ?? STRINGS.zh;
}
