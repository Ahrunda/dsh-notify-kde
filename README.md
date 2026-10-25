# dsh-notify-kde

DSH 需要你的时候，弹一条 **KDE 桌面通知**，同时通过 **KDE Connect** 把同一条消息推到手机。

这是 [`pi-notify-kde`](https://github.com/Ahrunda/pi-notify-kde) 的 DSH 移植版：触发时机、文案、
节流和手机重试逻辑都沿用原版，只把 pi 的事件换成了 DSH 的会话事件。

## 什么时候提醒

| 时机 | 默认行为 |
|---|---|
| 一整轮真正跑完（含子代理树全部落定） | 弹「✅ 跑完了 · 4 分 12 秒」+ 最后回复摘要 |
| 出错 / 被阻塞 / 达到 token 上限 | 弹「⚠️ 出错了」或「⏸ 停下来了」，错误不受 30 秒阈值限制 |
| 模型提问（`ask_user_question`）或方案待确认（`exit_plan_mode`） | 等 8 秒还没答才提醒，避免你正在打字时被震 |
| 工具调用等你批准 | 立即提醒「⏳ 等你批准 · Bash — 原因」 |
| 你回来打字 | 把当前会话那条桌面通知撤回 |

子代理自己的会话不单独提醒：它的完成由父会话的「树落定」统一播报，避免一个任务响很多次。

桌面通知默认 **8 秒后自动消失**（`notify-send -t`），同一会话的新通知会替换旧的（`-r`）。
手机收到的是 `kdeconnect-cli --ping-msg`：一条通知 + 震动。KDE Connect 没有「推送任意通知」
的 DBus 接口，`ping` 就是它的等价物。

## 依赖

| 依赖 | 用途 |
|---|---|
| Linux + KDE Plasma（有会话 DBus） | 桌面通知 |
| `notify-send` / `gdbus`（libnotify） | 弹通知 / 撤回通知 |
| `kdeconnect-cli` + 手机端 KDE Connect | 推手机；手机需已配对且此刻可达 |

没有 `kdeconnect-cli` 或手机不可达时，桌面通知照发，正文里会注明「手机未送达」。

## 安装

### 从 GitHub（无需 npm 账号）

```sh
dsh plugin --profile web add github:Ahrunda/dsh-notify-kde
```

桌面端：侧栏 **插件** → **安装**，输入：

```
https://github.com/Ahrunda/dsh-notify-kde
```

安装后**重启 DSH**，在任意会话里发：

```
/notify-kde test
```

桌面应弹出一条 8 秒通知，手机会同时震一下。

### 从 npm（如果以后发布到 npm）

```sh
dsh plugin --profile web add dsh-notify-kde
```

桌面端在插件页输入包名 `dsh-notify-kde`。

### 从本地目录（开发/未发布）

1. 打开 DSH 侧栏 **插件** → **安装**。
2. 在安装输入框里填本目录的绝对路径（例如 `/path/to/DSHPlugin`）；
   如果输入框只收文件，就填打包生成的 `dsh-notify-kde-0.1.0.tgz`。
3. 安装后确认 `notify-kde` 是启用状态，然后**重启 DSH**。
4. 发 `/notify-kde test` 验证。

> 桌面 profile 由 Electron 应用独占管理，`dsh plugin --profile desktop add ...` 会被拒绝；
> 本地路径安装要通过插件页完成。

## 配置

配置分两层，后者覆盖前者：

1. `cordis.patch.yml` 里这一行的 `config`（部署默认值）；
2. `$DSH_HOME/notify-kde.json`（用户覆盖；`/notify-kde on|off` 只写 `enabled` 这一个键）。

常用键：

```json
{
  "enabled": true,
  "locale": "zh",
  "minDurationMs": 30000,
  "uiPromptDelayMs": 8000,
  "approvalDelayMs": 0,
  "desktopTimeoutMs": 8000,
  "kdeconnect": true,
  "kdeconnectDevices": [],
  "includeSnippet": true,
  "snippetChars": 140,
  "suppressWhenAborted": true,
  "suppressSubagentSessions": true
}
```

| 键 | 默认 | 说明 |
|---|---|---|
| `minDurationMs` | `30000` | 跑完提醒的最短回合时长；`0` = 每次完成都提醒 |
| `uiPromptDelayMs` | `8000` | 提问/方案确认等多久还没答才提醒；`0` = 立即 |
| `approvalDelayMs` | `0` | 审批等多久才提醒 |
| `desktopTimeoutMs` | `8000` | 桌面通知停留毫秒数；`0` = 交给通知服务器决定 |
| `urgency` | `normal` | `low` / `normal` / `critical`；**`critical` 不会自动消失** |
| `coalesce` | `true` | 同一会话用同一个通知 id 替换旧通知 |
| `dismissOnReturn` | `true` | 你发消息时撤回当前会话的通知 |
| `includeSnippet` | `true` | 通知正文带最后回复的首行摘要 |
| `kdeconnect` | `true` | 是否推手机 |
| `kdeconnectDevices` | `[]` | 设备 id 白名单；空 = 所有已配对且可达的设备 |
| `kdeconnectRefreshWhenOffline` | `true` | 没设备可达时让 kdeconnectd 重扫并轮询 |
| `annotatePhoneFailure` | `true` | 手机没送达时在桌面通知里注明 |
| `suppressWhenAborted` | `true` | 你按 Esc 中断的那一轮不提醒 |
| `suppressSubagentSessions` | `true` | 子代理会话不单独提醒 |

`/notify-kde` 命令：

| 命令 | 作用 |
|---|---|
| `/notify-kde` 或 `/notify-kde status` | 当前配置、DBus、上次手机投递结果 |
| `/notify-kde test` | 立刻发一条桌面 + 手机测试 |
| `/notify-kde on` / `off` | 总开关（写 `notify-kde.json`，先备份 `.bak`） |

## 排查

日志在 `$DSH_HOME/notify-kde.log`，每次投递都有一行 `desktop: sent ...` 或失败原因。

不经过 DSH 也能单独验证两条链路：

```sh
node tools/smoke.mjs --no-phone     # 只测桌面
node tools/smoke.mjs --no-desktop   # 只测手机
node tools/smoke.mjs                # 两条都测
```

常见问题：

- **桌面没弹**：确认 `echo $DBUS_SESSION_BUS_ADDRESS` 非空；插件会尝试从
  `/run/user/<uid>/bus` 补上。`notify-send` 缺失时日志会写 `notify-send failed`。
- **手机没震**：先 `kdeconnect-cli -a --id-only` 看有没有可达设备。小米/HyperOS 等
  省电策略会在锁屏后杀 KDE Connect，手机根本不在网络上——这只能在手机端加白名单。
- **一直不提醒**：短于 30 秒的完成本来就不提醒；把 `minDurationMs` 设成 `0`，
  或看日志里有没有 `desktop: sent`。

## 已知限制

- 只支持 Linux/KDE；`notify-send` 和 `kdeconnect-cli` 是硬依赖。
- 不能点击通知聚焦到对应会话：Wayland 下可靠地找到并激活正确的窗口超出本插件范围。
- `ping` 是「通知 + 震动」，不是可交互通知；手机上不能直接批准或回答。
- `includeSnippet: true` 会把最后回复的首行送到手机锁屏；敏感场景请关掉。

## 从 pi-notify-kde 的映射

| pi 事件 | DSH 事件 |
|---|---|
| `agent_settled` | `turn/end` + 子代理树计数 |
| `ui_prompt_start` | `tool/call` 且工具名是 `ask_user_question` / `exit_plan_mode` |
| 审批 | `approval/asked` / `approval/decided` |
| 用户输入 | `user/message`（`source.kind === 'user'`） |

## License

MIT
