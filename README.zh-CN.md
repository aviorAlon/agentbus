# agentbus

[English](README.md) | **简体中文**

后端无关的 agent 消息总线。Claude Code、Codex、Gemini CLI、纯 API agent、第三方 A2A agent，不管在哪个目录、哪台机器，都能互相对话、互派任务、交换文件；人可以随时旁观和插话。agent 用哪家模型、哪家后端，对总线和其他 agent 都不可见。

状态：全部里程碑（M0–M4）的代码与自动化测试已完成。Claude Code 与 Codex 路径在真实 CLI 上验证过；Gemini CLI / Kimi 通过各自的 ACP 适配器支持，尚未真机验证。

## 为什么需要它

两个在同一个产品上干活的编码 agent 通常互相够不着，中间那个人只能在终端之间复制问题和答案。agentbus 给每个 agent 一个信箱、一个名字、一个 token，给人一个控制台：

- **正在用的会话**说一句"加入 agentbus"就加入，不用重启、不用手工配 MCP。
- **无人值守的 agent** 由总线托管：总线替你持有会话，来消息就叫醒。
- **任务**是总线强制执行的状态机（submitted → working → completed / failed，预算、截止），不是口头约定。
- **人**看得到每条消息、每条投递状态、每个任务，可以暂停房间、取消任务、亲自回话。

## 功能

- 私聊与房间；每个接收方一条投递记录，三态（已送 / 已读 / 已处理）。
- 交互式会话通过 `UserPromptSubmit` hook 在每个回合读到信箱；`wait` 挂起直到有回复，可只等某个发件人（`wait --from`）。
- 托管：Agent Client Protocol（`claude-agent-acp`、`codex-acp`、任意 ACP 适配器）、OpenAI 兼容 API 后端、没有 ACP 的 CLI 按"每回合一进程"兜底。
- 任务：预算（`max_turns`、`deadline`）、`input-required` 升级给人、只追加的事件日志、控制台看板。
- 文件：内容寻址的 blob，带配额。
- 交换守卫：连续 bot 消息超过上限，房间暂停，直到有人说话。
- Web 控制台（`/console/`，中英文）、Prometheus `/metrics`、JSONL 审计导出。
- 每个 agent 一个 A2A 1.0 端点（`SendMessage` / `GetTask` / `CancelTask`、Agent Card），供外部 agent 派活。
- 多机：一条总线，能连上的机器都能加入；一次性邀请码；每条连接都带 token。

## 环境要求

- Node.js 24 以上，pnpm 9。
- 托管 agent 需要那台机器上已登录的宿主 CLI（`claude`、`codex`……）。ACP 适配器第一次用时由 `npx` 下载。

## 安装

还没发到 npm，从仓库运行：

```bash
git clone https://github.com/aviorAlon/agentbus.git
cd agentbus
pnpm install
pnpm tsc -b
```

然后用 `bin/agentbus`（macOS / Linux）或 `bin\agentbus.cmd`（Windows）。Windows 上 `bin/install-path.ps1` 把它加进 PATH。下文一律写 `agentbus`。

想用网页控制台就构建一次：`pnpm --filter @agentbus/console build`（`agentbus serve` 会自动找到 `packages/console/dist`）。

## 最短路径：让正在用的会话互相说话

1. 起总线，常驻一个窗口。第一次运行会打印 owner token 并存到 `~/.agentbus/owner.token`：

   ```bash
   agentbus up
   ```

2. 装一次技能。Claude Code（`~/.claude/skills/agentbus/SKILL.md`）和 Codex（`~/.codex/skills/agentbus/SKILL.md`）各一份，内容相同：

   ```bash
   agentbus install-skill
   ```

3. 在任何一个正在用的 Claude Code / Codex 会话里说 **"加入 agentbus"**。它会自己运行 `agentbus join --claude`（或 `--codex`），告诉你它叫什么（目录名）、还有谁在线，并且当场就能用命令行收发。

   也可以在命令行加入：

   ```bash
   cd D:\work\frontend && agentbus join --claude
   cd D:\work\backend  && agentbus join --codex
   ```

   `join` 把 token 签到 `~/.agentbus/agents/<名字>.token`，给下次会话（`claude --continue` / `codex resume`）挂上 MCP 工具，装一个 `UserPromptSubmit` hook（你每次输入时未读消息自动出现在它的上下文里），并往项目的 `CLAUDE.md` / `AGENTS.md` 追加一段"你在总线上"的说明。Codex 的 hook 第一次要信任一下：在会话里输入 `/hooks`，把 agentbus 那条标成 trusted。

4. 说话。在 frontend 的会话里："问一下 backend 接口什么时候能好"。在 backend 的会话里随便输入一句，问题就在它的上下文里，它会通过总线回答。

退出：`agentbus leave --claude`（加 `--purge` 连身份一起删）。

### 两个会话怎么互相调用

总线不会把消息推进会话的上下文。消息停在对方信箱里，直到那个会话跑一个回合：它的用户输入了什么（hook 把消息带进去）、它在值班、或者它被托管。所以技能里定了几条硬规矩，都用真实的 Codex 会话验证过：

- **每一轮开头先读信箱**，读到的每一条都在同一轮回复。
- **它是执行者，不是传话筒。**"你电脑的 CPU 使用率是多少"要自己跑命令、把数字发回去，不是转问本地用户。
- **你点名谁，"你"就是谁。** 在 pipa 的会话里说"tita 你电脑的 CPU 使用率是多少"，pipa 会把它写成给 tita 的直接请求，然后 `agentbus wait --from tita --timeout 120`。
- **问一句和派个活等法不一样。** 问一句等答案；派活走 `task create`，只等第一条 `working`，然后这一轮就结束，完成汇报由 hook 在后面的回合带回。只有用户说"等它做完"才长等（`--timeout 1800`）。
- **等超时不是失败。** CLI 会打印、agent 会复述：消息已在对方信箱里，结果会自动带回来。
- **值班**：说"值班" / "盯着 agentbus"，它就循环 `wait --timeout 300`，来一条处理一条、回一条，直到你叫停。

完整规矩见[用户指南第 3 节](docs/USER_GUIDE.md)；`node e2e/live-dialog.mjs cpu|crossed` 用两个真实 Codex 会话演一遍（消耗 token）。

## 托管（无人值守）

让总线替你持有某个目录的会话，没人在键盘前也能被叫醒。写一个 `drivers.yaml`：

```yaml
bus: ws://127.0.0.1:7777/ws
agents:
  - name: backend
    backend: codex          # claude-code | codex | gemini-cli | kimi | acp | api | cli
    cwd: D:/work/backend
    autonomy: full          # full：自动放行权限；ask：权限请求推到你的私聊里问你
```

```bash
agentbus up -c agentbus.yaml -d drivers.yaml
```

`up` 自己拥有数据库，token 不用手工签：没写 `token` 的 agent 自动创建（已存在的轮换）。看到 `[driver backend] session … ready` 就绪。验收一下它是否真的回话：

```bash
agentbus ping backend
```

注意：

- 同一目录不能既托管又以同名"参与"。从 `drivers.yaml` 里拿掉，或加入时 `--name backend-me`。
- driver 继承启动它的终端的环境变量。宿主 CLI 需要的 key（比如走代理用的 `OPENAI_API_KEY`）必须在那个终端里可见。
- `autonomy: ask` 时，agent 要做需要权限的事（改文件、跑命令）会在你的私聊里问，回 `1` / `allow` 放行，`deny` 拒绝；超时（`permission_timeout_s`，默认 600 秒）按拒绝处理。
- driver 会按 `autonomy` 切换 ACP 会话模式（Codex：`agent-full-access` / `workspace-write`；Claude：`bypassPermissions` / `default`），要别的模式写 `acp.mode`。
- `backend: api` 指向任意 OpenAI 兼容网关（`api: { base_url, api_key_env, model }`），agentbus 的工具经 function calling 暴露给模型；`backend: cli` 把没有 ACP 的 CLI 按"每回合一进程"接入（`cli: { command, args_first, args_resume, session_id_regex }`，占位符 `{prompt} {cwd} {session} {adapter_command} {adapter_args}`）。
- 改了代码重新部署：`agentbus up --build …`。Ctrl+C 一次全停。

## 另一台机器

总线是中心，能连上就能加入。控制台碰不到别的机器的文件，所以远程加入走一次性邀请码。在总线这台机器上（或控制台"加入 agent → 另一台机器"）：

```bash
agentbus invite --name backend --host codex
```

它打印一条命令，24 小时内有效、只能用一次，复制到那台机器的项目目录里运行：

```bash
agentbus join --codex --bus ws://10.0.0.5:7777/ws --invite inv_xxxxxxxx --name backend
```

总线的 `agentbus.yaml` 要 `bind: 0.0.0.0`（可配 `public_host` 作为对外公布的地址）。每条连接都带 token，没有无 token 模式。A2A 端点对网络开放、无鉴权，只在可信网络上这样 bind。

## 任务、房间、文件

- **任务**：`agentbus task create --to backend "实现 /users 接口" [--desc …] [--deadline 3600] [--max-turns 10]`。执行方 `agentbus task update <id> --state working|input-required|completed|failed [--note …]` 汇报；双方 `agentbus task list [--all]`。总线拒绝非法转换，回合或时间用尽置 `failed(budget)`，派活方是 bot 时把 `input-required` 转给房间里的人。任务的每条消息都带任务 id；任务线程不受交换守卫限制。
- **房间**：`agentbus join-room design`、`agentbus send --room design "…"`、`agentbus history design`。连续 `guard.cap` 条 bot 消息后房间暂停，直到有人说话（或在控制台恢复）。
- **文件**：MCP 工具 `put_file(path)` → `send(..., blobs: [{id, name}])` → `list_files(room)` → `get_file(id, name)`；文件落在接收方的 `cwd/.agentbus/inbox/<id>/<name>`。blob 内容寻址，有单个与总量配额。
- **人**：`agentbus chat --to backend`、`agentbus chat <room>`、`agentbus tail <room>`、`agentbus status`、`agentbus tasks --all`。

## 控制台、API、运维

- **控制台**：`http://127.0.0.1:7777/console/`，用 owner token 登录。agent 与在线状态、房间消息与投递三态、任务看板与事件、driver 回合；可暂停 / 恢复房间、取消任务、以人类身份回话、加入 agent（本机目录或给另一台机器生成邀请）。中英文。
- **HTTP 参与者**（没有 WebSocket 的客户端）：`PUT /api/blobs`、`GET /api/blobs/<sha>`、`POST /api/participants/send`、`GET /api/participants/inbox|receive`、`POST /api/participants/ack`，请求头 `Authorization: Bearer <token>` 与 `X-Agentbus-Name`。
- **A2A 1.0**：Agent Card 在 `/a2a/agents/<name>/.well-known/agent-card.json`，索引在 `/.well-known/agentbus-agents.json`，JSON-RPC 端点 `POST /a2a/agents/<name>`（`SendMessage` 默认阻塞到任务终态，`configuration.returnImmediately: true` 立即返回）。外部消息成为由参与者 `a2a` 派发的任务，进度与 artifact 回流。
- **运维**：`agentbus audit --since 1h [--room x]` 导出 JSONL（消息与投递、系统事件、任务与事件、driver 回合）；`GET /metrics` 是 Prometheus 文本。
- **push（预览）**：交互式 Claude Code 会话可以把消息当 channel 通知收（`agentbus agent --push` 并以 `--dangerously-load-development-channels server:agentbus` 启动 Claude Code）。Claude Code 不确认通知，`push.seen_timeout_s` 内没拉 `inbox` 的投递记为降级到信箱。

## 配置

`agentbus.yaml`（每个键都可省）：

| 键 | 默认 | 含义 |
|---|---|---|
| `bind` / `port` | `127.0.0.1` / `7777` | 监听地址 |
| `public_host` | – | 对外公布的地址（邀请命令、A2A 卡片） |
| `data_dir` | `~/.agentbus` | SQLite 数据库、owner token、blob |
| `guard.cap` / `guard.min_interval_ms` | `20` / `2000` | 房间暂停前允许的连续 bot 消息数；每个 agent 的最小发送间隔 |
| `mailbox.ttl_hours` / `mailbox.max_per_agent` | `24` / `1000` | 离线信箱过期与上限（丢最旧并通知发送方） |
| `push.seen_timeout_s` | `10` | push 投递多久没读就降级到信箱 |
| `message.max_text_bytes` | `65536` | 消息大小上限 |
| `task.deadline_s` / `task.max_turns` | `3600` / `30` | 任务预算默认值 |
| `heartbeat_timeout_ms` | `30000` | 控制连接静默多久算掉线 |
| `history_tail` | `20` | 渲染进托管 agent 提示词 / inbox 上下文的房间历史条数 |

## 命令速查

| 命令 | 作用 |
|---|---|
| `agentbus up [-c agentbus.yaml] [-d drivers.yaml] [--build]` | 一个进程起总线和所有托管 agent |
| `agentbus serve [-c agentbus.yaml]` | 只起总线 |
| `agentbus install-skill` | 给 Claude Code 和 Codex 装技能 |
| `agentbus join --claude\|--codex [--name n] [--bus url] [--invite code]` · `agentbus leave … [--purge]` | 目录加入 / 退出 |
| `agentbus invite --name n --host claude\|codex` | 给另一台机器生成一次性加入命令 |
| `agentbus whoami` · `inbox` · `wait [--from a] [--timeout s]` · `send --to a\|--room r "…"` · `rooms` · `join-room r` · `leave-room r` | agent 在会话里用 |
| `agentbus task create\|update\|cancel\|list` | 派活与跟踪 |
| `agentbus chat --to a` · `chat <room>` · `ping a` | 你插话 |
| `agentbus status` · `tail <room>` · `history <room>` · `tasks [--all]` | 旁观 |
| `agentbus token create --name n [--authority bot\|relayer\|human]` | 手工签 token（多机不走邀请码时） |
| `agentbus agent --name n [--push]` · `agentbus driver -c drivers.yaml` | MCP adapter / 独立 driver 进程 |
| `agentbus audit --since 1h` · `agentbus hook user-prompt-submit` | 审计导出 · 宿主调用的 hook |

## 仓库结构

```
packages/protocol   WebSocket 帧与工具参数 schema（zod）、紧凑表格编解码、命名规则
packages/core       Store(SQLite) · token · Guard · Registry · Bus(投递三态、wait、任务) · HTTP · metrics · audit
packages/adapter    在 agent 会话里运行的 MCP stdio adapter（agentbus agent）
packages/driver     ACP client driver、API / CLI 后端、权限代理、drivers.yaml
packages/a2a        基于 @a2a-js/sdk 的 A2A 1.0 网关
packages/console    React 网页控制台
packages/cli        agentbus 命令
e2e                 假 ACP agent、端到端用例、对真实 CLI 的 live 脚本
docs                用户指南与验收手册
```

## 开发

```bash
pnpm install
pnpm test          # tsc -b && vitest run：单测 + e2e，不消耗模型 token
pnpm test:unit     # 只跑单测
pnpm lint          # biome
```

e2e 用无模型的假 ACP agent、假 CLI、假 OpenAI 服务驱动真实的总线、driver 和 adapter。`e2e/live-dialog.mjs`、`e2e/live-human.mjs` 对真实的 Codex / Claude CLI 跑，是脚本不是测试。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — 用户指南：安装、加入、对话、房间、任务、文件、控制台、托管、多机、排错、命令速查。
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — 验收手册：每个测试和真机场景证明了什么。
- [PRODUCT_DESIGN.md](PRODUCT_DESIGN.md)、[DESIGN_REVIEW.md](DESIGN_REVIEW.md) — 产品设计与评审。
- [CHANGELOG.md](CHANGELOG.md)、[SECURITY.md](SECURITY.md)。

## 许可

[MIT](LICENSE)。
