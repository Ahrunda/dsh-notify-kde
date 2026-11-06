# dsh-notify-kde — 项目约定与实测事实

面向 DSH 的 KDE 桌面通知 + KDE Connect 手机推送插件。移植自
[`pi-notify-kde`](https://github.com/Ahrunda/pi-notify-kde)（MIT，同作者）。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | DSH 插件入口：注册 `session/event`、`session/disposed`、`/notify-kde` |
| `lib/config.js` | 默认值、校验、`$DSH_HOME/notify-kde.json` 覆盖 |
| `lib/format.js` | 纯函数：文案、时长、摘要、`notify-send`/`kdeconnect-cli` argv |
| `lib/delivery.js` | 真正执行 `notify-send` / `gdbus` / `kdeconnect-cli` |
| `lib/notifier.js` | 决策表：完成/提问/审批、节流、合并、撤回、手机重试 |
| `lib/log.js` | `$DSH_HOME/notify-kde.log` |
| `lib/opener.js` | 点击通知后的 pending session + `/api/dsh-notify-kde/*` 路由 |
| `lib/client.js` | 网页端轮询 pending，调用 `uiWorkspace.openSession` |
| `assets/icon.png` | 通知图标 |
| `tools/smoke.mjs` | 不经过 DSH 的真实链路冒烟 |

宿主侧插件，刻意不 import 任何 `@deepseek-ai/*`：配置、日志、子进程全部用 `node:*`，
这样 profile 的 node_modules 布局变了也不会加载失败。

## 实测事实（2026-10-25，本机）

- DSH `0.2.1-rc.2`，桌面 profile 由 Electron 独占管理；`dsh plugin --profile desktop ...`
  会被拒绝。本地插件要在**侧栏「插件」→ 安装**里填绝对路径安装。
- `notify-send -p` 在本机 Plasma 返回真实 id（实测 53、58）；`-t 4000` 能自动消失。
- `gdbus ... CloseNotification <id>` 能撤回；本机通知服务有 `body`、`actions` 等能力。
- `kdeconnect-cli 26.08.2`，本机手机已配对；`-a --id-only` 能列出设备 id；
  `--ping-msg` 实测送达。
- KDE Connect 的 `org.kde.kdeconnect.device.notifications` **只有**
  `activeNotifications` / `sendAction` / `sendReply`，没有“发送通知”方法。手机方向只能用
  `--ping-msg`（通知 + 震动），这不是缺陷，是它的接口就这样。
- `--refresh` 很快返回（只让 kdeconnectd 重扫），设备几秒后才出现，所以必须**轮询**
  `-a --id-only`，不能 refresh 完只查一次。`pollDelays()` 就是为此存在。
- DSH 的 `session/event` 是 `(session, event)` 两参数；`session.header.cwd` 可用，
  子代理会话带 `header.origin === 'subagent'` 与 `parentSession`。
- 事件形状：`turn/end` 的 `data.reason` 是 `{kind, error?}`；提问是
  `tool/call` 的 `data.name === 'ask_user_question'` / `'exit_plan_mode'`；
  审批是 `approval/asked` / `approval/decided`。
- IM 桥接（Aurabot/QQ）的会话带 `header.agentPreset = aurabot-private |
  aurabot-private-long | aurabot-social`。这些会话一轮常超过 30 秒，会被当成“跑完了”；
  用 `ignoreAgentPresets` 按 preset 整体跳过，不要靠提高 minDurationMs 去抑制。
- 可点击通知：`notify-send 0.8.9` 支持 `-A default=...` + `--id-fd` / `--selected-action-fd`，
  实测能拿到 id（26）且通知超时后进程自行退出，不留 notify-send。
- 客户端跳会话用 `ctx.get('uiWorkspace').openSession(sessionId)`；`sessions.open` 是旧版回退。
  客户端 bundle 放在 `lib/client.js`，用 `window.__ModuleLoader__.load` 的 lazy-CJS 壳，
  `dsh.client.platform = web`，`dsh.client.inject` 里列 `@deepseek-ai/dsh-client-ui-workspace`。
- 抬窗最终用 KWin 脚本：精确匹配 `resourceClass` / `desktopFileName` =
  `deepseek-ai-dsh-desktop`，再 `workspace.activeWindow = target`。KWin 6.8 的窗口对象**没有**
  `activate()` 方法（调用会 TypeError），只能用 activeWindow setter。
- `loadScript` 返回后要等 ~150ms 再 `start()`，否则脚本可能还没注册、`start` 什么也不跑；
  启动后 1.2s 再 `unloadScript`。实测 Chrome 在前台时能把活动窗口切回 DSH。
- 客户端跨 workspace 时先 `uiWorkspace.openWorkspace(workspaceId)`，Promise 完成后
  `openSession(sessionId)`；否则只换选中项、主界面仍停在旧 workspace。用 `navigating`
  标志防止重复切换。

## 集成测试（不碰真实 `~/.dsh`）

在隔离的 `DSH_HOME` 里建 headless profile，手动 symlink 插件，跑一轮真任务：

```sh
SM=$PWD/.tmp/dsh-smoke
DSH_HOME=$SM dsh smoke --from-default-profile headless
ln -s "$PWD" "$SM/profiles/smoke/node_modules/dsh-notify-kde"
cp ~/.dsh/.credentials.yaml "$SM/.credentials.yaml"
# 在 profile 的 cordis.patch.yml 里：enable credentials、指向 opencode-go、插入 notify-kde
DSH_HOME=$SM dsh --profile smoke "Reply with OK"
cat "$SM/notify-kde.log"   # 应出现 desktop: sent (id N)
```

注意：headless 模板默认 `credentials` 行是 `disabled: true`，且默认模型是
`deepseek-official`（本机没有这个 key）。测试 profile 里要显式启用 credentials，
把 `agent-default-model` 指到 `opencode-go`，并在 `llm-pi-ai` 里声明
`opencode-go.apiKeyEnv = OPENCODE_GO_API_KEY`。

## 测试纪律

- `node --test`（当前 44 条）。纯函数、notifier 决策表、入口接线都要有测试。
- 每个修过的 bug 留一条**区分性断言**：bug 回来测试就红。
- 真机链路用 `node tools/smoke.mjs --no-phone` / `--no-desktop` 分别验证，
  不要把“单测过”当成“通知真的弹了”。
- 会真的弹通知、真的震手机；跑之前想清楚是不是必须跑。

## 约束

- 默认 **不要** 用 `urgency: critical`：Plasma 对 critical 通知不自动过期，违背“几秒消失”。
- 不要截用户的桌面来“验证通知”；用 `notify-kde.log`、`notify-send` 退出码和
  `dbus-monitor` 验证。
- 不要把 `.credentials.yaml`、API key、设备 id 以外的隐私写进日志或 README。
- 手机不可达时不要静默失败：桌面正文要注明，日志要留一行。
- 改 `lib/config.js` 的默认值时同步 README 表格与 `cordis.patch.yml` 注释。

## 已知未做

- 没有设置页（DSH 设置 UI）；配置走 patch + JSON。
- 点击通知已能切 workspace/会话，并用 KWin 脚本抬窗；非 KDE 桌面退回 `dsh://open`。
- Windows/macOS 后端未实现，`supportedPlatform()` 直接返回 false。
