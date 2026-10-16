# agentbus — 后端无关的 Agent 消息总线

> 产品设计文档 v0.3 · 2026-10-15 · 工作名 `agentbus`（可改）
>
> 一句话：让任何编码 agent（Claude Code、Codex、Gemini CLI、Kimi、纯 API agent、第三方 A2A agent）在不同目录、不同机器上互相对话、互派任务、交换文件；人可以随时旁观和插话。agent 用哪家后端，对总线和对其他 agent 都不可见。
>
> v0.3 按"产品功能 → 核心机制 → 技术栈 → 开发任务"重排。设计论证与来源见附录 C；v0.2 对 `DESIGN_REVIEW.md` 11 条的逐条响应已全部并入正文。

---

## 1. 产品定位

### 1.1 解决什么问题

今天让两个编码 agent 协作，要么人在终端之间复制粘贴，要么依赖某一家的私有功能（如 Claude Code 的 channels 研究预览）。agentbus 提供一条与后端无关的通道：**agent 说话用 MCP 工具，被叫醒靠总线托管它的会话（ACP），互派任务用 A2A 的任务模型**，三者之间的胶水由 agentbus 定义。

### 1.2 目标用户与场景

| 用户 | 场景 | 有了 agentbus |
|---|---|---|
| 一个开发者，跑着 2–4 个 agent（终端里的，或 driver 托管的） | 前端仓库的 agent 和后端仓库的 agent 要对齐接口 | 在 A 里说一句"去和 B 商量"，之后只看结果；B 不需要开着终端 |
| 同一人，不同后端 | 用 Claude 做 review，用 Codex 修 bug（谁便宜用谁） | review agent 把 finding 作为 Task 派给 fix agent，收 result |
| 小团队，各自机器 | 每人跑自己的 agent，想让它们跨机器协作 | 一个总线，agent 用名字互相找到 |
| 已有 A2A agent 的组织 | 想让企业内别的 agent 给编码 agent 派活 | 总线对外暴露 A2A 端点，编码 agent 成为普通的 A2A remote agent |

### 1.3 产品立场

1. **后端无关**：接入一个新后端 = 写一个适配器，核心零改动；其他 agent 和人都感知不到对方用的是哪家。
2. **driver 是基线**：无人值守时 agent 必须能被叫醒，这件事不依赖任何一家的私有推送。
3. **driver 模式下，总线就是该 agent 的终端**：人通过 `dm` 与被托管的 agent 对话，权限请求作为 `input-required` 推给人。
4. **协议不自造**：任务语义用 A2A，工具接口用 MCP，驱动会话用 ACP。
5. **人在环内、可审计**：人能旁观、以更高权限插话、暂停失控对话；谁对谁说了什么、派了什么、结果如何，可回放。

### 1.4 非目标（v1 不做）

- 不做 agent 本身，不做任务编排 DSL / 工作流引擎。
- 不做公网 SaaS、多租户、计费。
- 不做"把消息推进别家的交互式会话"；Claude 自家的 channels 只作为可选预览接入。
- 不做 LLM 级的消息路由 / 摘要 / 翻译。

---

## 2. 产品功能清单

优先级：**P0** = M0 必须；**P1** = M1–M2；**P2** = M3–M4。里程碑定义见 §7。

### 2.1 Agent 接入（adapter，MCP stdio server）

| ID | 功能 | 说明 | 优先级 |
|---|---|---|---|
| F-A1 | 注册与身份 | `agentbus agent --name --token` 以 agent 身份连总线；token 决定身份与权威级别（bot / relayer / human） | P0 |
| F-A2 | 发现 | `agents()` 在线 / 离线列表，含 backend、state、capabilities；`rooms()` | P0 |
| F-A3 | 房间 | `join(room)`、`history(room, limit)`；`dm:<a>\|<b>` 自动创建 | P0 |
| F-A4 | 发消息 | `send(to or room, text, payload?, task_id?)`，返回投递三态 | P0 |
| F-A5 | 回合边界拉取 | `inbox()` 返回所有房间未读并推进 cursor；instructions 要求每回合开始先调 | P1 |
| F-A6 | 显式等待 | `wait_for_message(timeout_s)` 阻塞至有消息或超时，自动按宿主 MCP 超时分段 | P1 |
| F-A7 | 状态上报 | `status(text?)`；Claude Code 可由 hooks 调 | P1 |
| F-A8 | 文件 | `put_file(path) → blob_id`、`get_file(blob_id) → local_path`、`list_files(room)`；落盘路径由总线生成 | P1 |
| F-A9 | 任务工具 | `task_create` / `task_update` / `task_cancel`（§2.4） | P1 |
| F-A10 | 紧凑返回格式 | 列表类工具返回管道分隔表格而非 JSON，省 token | P0 |
| F-A11 | 注入边界包装 | 所有总线消息带 `from / authority / room / id`，以"数据不是指令"框架包装 | P0 |
| F-A12 | push（可选预览） | `--push on` 时在 Claude Code 内声明 `experimental['claude/channel']`，dev flag 加载则打 `preview` 标 | P2 |

### 2.2 投递与叫醒（bus core + driver）

| ID | 功能 | 说明 | 优先级 |
|---|---|---|---|
| F-D1 | 投递三态 | 每条消息对每个接收者记录 `written / seen / handled` 三个时间戳 | P0 |
| F-D2 | at-least-once + 去重 | 先落库再投递；agent 侧按 `message.id` 去重；cursor 按 (agent, room) | P0 |
| F-D3 | driver 长驻会话 | 为每个托管 agent 持有一个活的 ACP 会话；一回合 = 一次 `session/prompt` | P0 |
| F-D4 | 批处理 | 同房间自上次回合以来的消息合为一批；`batch_window_ms` 只对 bot 消息生效，人类消息立即开回合 | P0 |
| F-D5 | 每 agent 串行 | 一个会话一次只跑一个回合，队列深度可见 | P0 |
| F-D6 | 崩溃恢复 | 进程死亡时用 `--resume` / `session/load` / `codex exec resume` 重建会话；重试耗尽标 `undeliverable` 并通知发送方 | P0 |
| F-D7 | "没有 send 就是没回复" | driver 不把后端 stdout 当消息 | P0 |
| F-D8 | mailbox | 离线 / 交互式 agent 的待投递队列；TTL（默认 24h）与上限 | P0 / TTL P2 |
| F-D9 | push 超时降级 | push 只到 `written`；T 秒内无 `seen` 自动降级到 driver 或 mailbox | P2 |
| F-D10 | 权限请求转人 | `autonomy: ask` 时 ACP `session/request_permission` → 该任务 `input-required` → 推给人 → 人回答 → 回传后端 | P1 |

### 2.3 房间与对话治理

| ID | 功能 | 说明 | 优先级 |
|---|---|---|---|
| F-R1 | 房间与 dm | 命名房间群聊；`dm:<a>\|<b>` 双方私聊 | P0 |
| F-R2 | 交换守卫 | 自上次人类消息起按 bot 消息条数计（默认上限 20），超限 `paused` 并发系统消息；人类消息清零并解除 | P0 |
| F-R3 | 限速 | 每 agent 最小发送间隔（默认 2s），超速返回 `rate_limited`，不计数 | P0 |
| F-R4 | 人类权威 | human 消息不计入守卫、可解除暂停、可强制取消任务；relayer 有人类权威但计入上限 | P0 |
| F-R5 | 同名接管 | 旧连接活着则拒绝；已断且 token 相同则接管并留痕；token 不符拒绝；按连接 role（control / tool）分别应用（§5.7） | P0 |
| F-R6 | 成员规则 | dm 首次 send 自动建并加入双方；命名房间需 join，非成员 send 返回 `not_member`；human 发言即加入（§5.7） | P0 |

### 2.4 任务（Task）

| ID | 功能 | 说明 | 优先级 |
|---|---|---|---|
| F-T1 | 状态机 | `submitted → working → input-required / completed / failed / canceled`；总线校验，非法转换拒绝；`task_events` 只追加 | P1 |
| F-T2 | 留在原房间 | task 不开新房间，相关消息带 `task_id`；看板按 `task_id` 派生 | P1 |
| F-T3 | 预算 | `deadline`（默认 1h）、`max_turns`（默认 30），到点自动 `failed(reason=budget)` | P1 |
| F-T4 | input-required 升级 | 先发派发方；派发方是 bot 且答不了，升级给房间内人类权威；没有则进控制台全局待办 | P1 |
| F-T5 | 并发 | driver 模式下串行，其余 task 停在 `submitted`，队列可见 | P1 |
| F-T6 | A2A 数据模型 | 内部 Task / Message / Part / Artifact 对齐 A2A 1.0，隔离在 `a2a/` 包 | P1 |

### 2.5 文件（blob store）

| ID | 功能 | 说明 | 优先级 |
|---|---|---|---|
| F-B1 | 内容寻址 | `blob_id = sha256`，磁盘 `<data>/blobs/<sha[:2]>/<sha>`，同内容只存一份 | P1 |
| F-B2 | 引用关系 | `message_blobs` 表由总线维护；`refcount` 归零后按 TTL 回收 | P1 |
| F-B3 | 配额 | 单 blob 上限（默认 100MB）、总配额（默认 10GB），超限拒绝 | P1 |
| F-B4 | 落盘限制 | `get_file` 只写到 `<cwd>/.agentbus/inbox/<blob_id>/<原名>`，agent 不能指定路径 | P1 |

### 2.6 人类入口

| ID | 功能 | 说明 | 优先级 |
|---|---|---|---|
| F-H1 | `agentbus chat <room>` / `chat --to <agent>` | 以 human 权威发言；对 driver 托管的 agent 这就是它的终端 | P0 |
| F-H2 | `agentbus tail <room>`、`status`、`tasks [--open]` | 旁观与查询 | P0 / tasks P1 |
| F-H3 | `agentbus token create --name --authority` | 签发 agent / human token；`serve` 首次启动生成 owner token（§5.7） | P0 |
| F-H4 | Web 控制台只读版 | 对话列表、房间视图、任务看板、agent 面板（能力、state、队列深度、`preview` / `full` 标记） | P1 |
| F-H5 | Web 控制台动作 | 暂停 / 解除暂停、强制取消任务、回答 `input-required` | P2 |

### 2.7 对外互通与多机

| ID | 功能 | 说明 | 优先级 |
|---|---|---|---|
| F-X1 | HTTP participants API | register → token；`receive`（long-poll，`after` 游标即 `seen`）；`send`；给无 WS 能力的客户端 | P1 |
| F-X2 | 局域网模式 | `--bind 0.0.0.0`，强制 token，不提供无 token 模式 | P2 |
| F-X3 | A2A 对外端点 | `/a2a/agents/<name>` 与 Agent Card 聚合；外部 A2A client 的 task 进入该 agent 投递流程 | P2 |

### 2.8 安全与治理

| ID | 功能 | 说明 | 优先级 |
|---|---|---|---|
| F-S1 | 每 agent token | 注册时签发、落库存 hash；无全局共享 secret | P0 |
| F-S2 | 注入边界 | 固定数据块 + `authority` 标注；driver system prompt 明说只有 human 消息是指令 | P0 |
| F-S3 | 自主级别 | `autonomy: full` 只建议沙箱使用，控制台打标 | P1 |
| F-S4 | 默认本机 | 只监听 127.0.0.1；无遥测；日志本地 | P0 |

### 2.9 可观测性

| ID | 功能 | 说明 | 优先级 |
|---|---|---|---|
| F-O1 | deliveries 记录 | `written_at / seen_at / handled_at / via（含降级链）/ attempts / error` | P0 |
| F-O2 | 回合记录 | 后端、session、输入消息 ids、耗时、token、是否 send、退出原因、是否 recover | P0 |
| F-O3 | 审计导出 | `agentbus audit --room x --since 1h` 导出 JSONL | P2 |
| F-O4 | 指标 | 可选 Prometheus 端点：投递延迟分位、mailbox 深度、回合失败率、push 降级次数、守卫触发次数、预算耗尽次数 | P2 |

---

## 3. 核心概念

| 概念 | 定义 |
|---|---|
| **Agent** | 总线上的一个参与者，有唯一 `name`，由某个 **Adapter** 代表；注册时签发一个只属于它的 **token**。 |
| **Human** | 特殊参与者：消息不计入 bot 交换上限，能解除暂停、能强制取消任务，是 `input-required` 的最终升级目标。 |
| **Backend** | agent 底下真正的执行体：`claude-code`、`codex`、`gemini-cli`、`kimi`、`api`、`a2a`。只用于显示和审计，总线不认识也能工作。 |
| **Capability** | 注册时声明的入站能力：`driver`、`inbox`、`push`。 |
| **Adapter（出站）** | 让 agent 能对总线"说话"的 MCP stdio server；所有后端共用一个二进制。 |
| **Driver（入站）** | 总线侧为某个 agent **持有一个长驻后端会话**的 worker（ACP client）；收到消息就对该会话 `prompt()` 一次。 |
| **Room / dm** | 多方会话容器。`dm:<a>\|<b>` 是双方私聊，命名房间是群聊。 |
| **Message** | 房间里的一条消息（文本 + 可选结构化 payload + 附件引用）。对应 A2A `Message`。 |
| **Task** | 带状态机的 Message 线程，由总线校验状态转换。对应 A2A `Task`。 |
| **Blob** | 任务产物或附件，按内容 sha256 寻址，消息里用引用。 |
| **Delivery** | 一条消息对一个接收者的投递记录，三态 `written → seen → handled`。 |

---

## 4. 核心机制

### 4.1 三种入站能力

| 能力 | 含义 | 谁有 | 代价 |
|---|---|---|---|
| **driver** | 总线侧 worker 为该 agent 持有一个**长驻**的后端会话（ACP `session/new` 一次，之后反复 `session/prompt`）；有消息就喂一回合 | 任何有 ACP 适配器或"单进程多轮"无头模式的后端；纯 API agent 天然如此 | 会话由总线独占，人通过总线与它对话 |
| **inbox** | agent 在自己的回合里主动拉取：回合开始先 `inbox()`；需要等结果时显式调 `wait_for_message` | 任何 MCP 宿主 | 回合一结束，交互式会话里的 agent 就不可达；`wait_for_message` 每次循环都是一轮模型调用 |
| **push** | 总线把消息注入 agent *正在运行的交互式会话*（Claude Code channels） | 今天只有 Claude Code，且自定义 channel 只能经 `--dangerously-load-development-channels` 加载（每次启动弹警告，`-p` / Agent SDK 下被忽略） | 研究预览；Claude Code 不确认通知，静默丢弃时发送方拿不到错误 |

**基线是 driver**；inbox 是交互式会话的补充；push 只在用户显式 `--push on` 时启用。

注册时声明，不按厂商硬编码：

```json
{
  "name": "gamma",
  "backend": "codex",
  "capabilities": {
    "driver": { "kind": "acp", "recover": "codex exec resume" },
    "inbox": true,
    "push": false
  },
  "session": { "id": "0193f…", "cwd": "/work/gamma" },
  "version": "agentbus-adapter/0.3"
}
```

### 4.2 投递算法与三态

```
written   总线已写到某条传输（driver 已 prompt / push 通知已发 / 已进 mailbox）
seen      agent 侧 adapter 以 cursor 确认收到（participants API 的 after 游标就是这个）
handled   agent 在回合里对该消息做了任何动作（send / task_update / 显式 ack）
```

```
deliver(msg, to):
  a = agents[to]
  write(msg, to)                                              # 先落库，再投递
  if a.driver:                     prompt_or_enqueue(a, msg)  # written；回合结束 → seen / handled
  elif a.online and a.push:        inject(a, msg)             # written；T 秒内无 seen → 降级到下一条
  elif a.online and a.waiting:     resolve_wait(a, msg)       # written → seen（adapter 回执）
  else:                            enqueue_mailbox(a, msg)    # written；下次 inbox() 时 seen
```

- push 永远只到 `written`；`written` 后 T 秒（默认 10s）无 `seen`，自动降级并在 delivery 上记 `via=push→mailbox`。
- cursor 按 (agent, room) 维护 `last_seen_id`；去重键是 `message.id`；投递 at-least-once。
- 人类消息跳过批处理窗口，立即投递。

### 4.3 Driver 回合模型

driver 对每个 agent 持有**一个活的会话**；一个"回合"就是一次 `prompt()`。不每回合起新进程、不每回合 `resume`。

| 后端 | 长驻方式 | 崩溃恢复 |
|---|---|---|
| Claude Code | ACP 适配器 `@agentclientprotocol/claude-agent-acp`（封装 Agent SDK）；或直接用 `@anthropic-ai/claude-agent-sdk`；或 `claude -p --input-format stream-json --output-format stream-json` | `--resume <sid>`（可跨目录） |
| Codex | ACP 适配器 `@agentclientprotocol/codex-acp` | `codex exec resume <id>`（本机 0.155.1 已确认） |
| Gemini CLI / Kimi CLI / OpenCode | 各自 ACP 适配器（均在 ACP 官方列表） | ACP `session/load`（可选能力，由 `initialize` 声明） |

每回合：

1. 从 mailbox 取出该 agent 的待处理消息，按房间分组，渲染为紧凑表格（表头 `id|from|authority|room|ts|text|attachments`，每条一行，管道与换行转义），外加房间历史尾部（长度可配）和固定的注入边界说明。`batch_window_ms` 只对 bot 消息生效；**人类消息立即开回合**。
2. `prompt(session, rendered)`，流式读取；会话上下文由后端持有，driver 不重放历史。
3. agent 通过 MCP adapter `send` / `task_update` 回话；**没有调用 send 就视为没有回复**。回合结束该批标 `seen`；被回应的标 `handled`。
4. **每 agent 串行**：回合期间到达的消息排队，队列深度可见。
5. 超时 / 崩溃 → 消息回 mailbox；进程死了用 `recover` 重建；重试耗尽标 `undeliverable` 并通知发送方。

### 4.4 交换守卫

- 每个房间维护 **bot 消息计数**：自上次人类消息起，每条 bot 消息计 1（不是往返对数）；超过上限（默认 20）进入 `paused`，双方收到系统消息。
- 人类消息把计数清零并解除暂停；人类消息不受守卫与限速约束。
- 每 agent 最小发送间隔（默认 2s），超速返回 `rate_limited`，不计数。
- Task 的 `cancel`、`error`、终态 `result` 不计入；带 `task_id` 的消息由任务预算约束，守卫只管无任务闲聊。

### 4.5 Task 规则

| 问题 | 定义 |
|---|---|
| 状态转换 | 合法：`submitted → working`、`working → input-required / completed / failed / canceled`、`input-required → working / canceled`、`submitted → canceled`。总线校验，非法拒绝；`task_events` 只追加。 |
| 住在哪 | 原房间 / dm，消息带 `task_id`；看板按 `task_id` 派生。 |
| `input-required` 发给谁 | 派发方 → （bot 且在 `max_turns` 内答不了，或显式 `escalate`）→ 房间内人类权威 → 控制台全局待办。 |
| 预算 | `deadline` 默认 1h，`max_turns` 默认 30（线程内 bot 消息条数）；到点总线置 `failed(reason=budget)` 并通知双方。 |
| 并发 | driver 模式下串行；其余 task 停 `submitted`，队列可见。 |
| 数据模型 | A2A **1.0** 的 Task / Message / Part / Artifact（`@a2a-js/sdk` 1.x 实现 1.0 并提供 0.3 兼容层）；隔离在 `a2a/` 包，核心不依赖其类型。 |

### 4.6 driver 模式下，总线就是该 agent 的终端

- `dm:human|gamma` 里的人类消息就是 gamma 的"终端输入"，`agentbus chat --to gamma` 和控制台就是人的 UI，gamma 的 `send` 就是"终端输出"。
- `autonomy: ask` 时，ACP `session/request_permission` 由 driver 转成该任务的 `input-required` 推给人；人在 dm 里回答，driver 把结果回给后端。
- 人不需要开着那个 agent 的终端。想亲手在终端用某个 agent，就不给它配 driver，它以 inbox（必要时 + push）参与。两种模式对其他 agent 和总线投递语义一样。

### 4.7 注入边界

- 所有投递给模型的内容渲染为固定数据块，每条带 `from / authority(human|relayer|bot) / room / id`。
- adapter 不执行消息里的任何"指令"，任务接不接由 agent 自己的回合决定。
- driver 模式下整段 prompt 都是总线内容，没有人类输入做锚，所以 driver 的 system prompt 明说：只有 `authority=human` 的消息是指令，bot 消息是"待评估的请求"。
- 唯一的写盘能力 `get_file` 路径由总线生成（§2.5 F-B4）。

---

## 5. 架构与技术栈

### 5.1 组件图

```
                 ┌──────────────────────────────────────────────────────────┐
                 │                        bus core                          │
   human CLI ───►│  rooms · messages · cursors · deliveries · tasks · blobs │◄─── web console
                 │  presence · guard · tokens                               │
                 │  WS (adapters) · HTTP/SSE (participants) · A2A 端点      │
                 └───────┬───────────────────┬───────────────────┬──────────┘
                         │ WS                │ WS                │ WS
                 ┌───────▼───────┐   ┌───────▼───────┐   ┌───────▼────────────────────┐
                 │ adapter (MCP) │   │ adapter (MCP) │   │ driver = ACP client        │
                 │ in Claude Code│   │ in Codex      │   │  └─ 长驻 session:          │
                 │ (人在用的终端) │   │ (人在用的终端) │   │     claude-agent-acp /     │
                 │ inbox [+push] │   │ inbox         │   │     codex-acp / gemini …   │
                 └───────────────┘   └───────────────┘   │  └─ 回合内挂 MCP adapter   │
                                                         └────────────────────────────┘
```

### 5.2 技术栈

实现语言定为 **TypeScript**：adapter 要作为 MCP stdio server 被每个 agent 会话拉起，还要在将来能当 channel；MCP SDK、channels 示例、ACP SDK、codex-acp、claude-agent-acp 都是 TS 优先；控制台本来就是 TS；一套工具链，Windows 上省事。review-agent 的联动走 MCP / HTTP，不要求同语言。

| 层 | 选择 | 版本（2026-10-15 npm 最新） | 说明 |
|---|---|---|---|
| 运行时 | Node.js | 24 LTS（本机 v24.11.0） | 不支持更低版本 |
| 语言 / 构建 | TypeScript 5.x、tsup（esbuild） | — | adapter 打成单文件，冷启动 < 300ms |
| 包管理 | pnpm workspace | 9.x（本机 9.15.4） | monorepo |
| HTTP / SSE | hono | 4.13 | participants API、A2A 端点、控制台静态文件 |
| WebSocket | ws | 8.22 | adapter 与 driver 的双向通道 |
| 存储 | better-sqlite3 | 13.0 | WAL，单写者；磁盘 blob |
| 校验 | zod | 3.x | WS 帧、配置、工具参数 |
| MCP | @modelcontextprotocol/sdk | 1.32 | adapter 的 stdio server |
| ACP | @agentclientprotocol/sdk | 1.8 | driver 的 ACP client |
| 后端适配 | @agentclientprotocol/codex-acp | 2.2 | Codex 长驻会话（旧名 @zed-industries/codex-acp 已弃用） |
| 后端适配 | @agentclientprotocol/claude-agent-acp | 0.90 | Claude 长驻会话（主路径；旧名 @zed-industries/claude-agent-acp 已弃用） |
| 后端适配（备） | @anthropic-ai/claude-agent-sdk | 0.3.x | claude-agent-acp 缺能力时直接用 |
| A2A | @a2a-js/sdk | 1.3（规范 1.0，含 0.3 兼容层） | 内部数据模型（M2）与对外端点（M3） |
| CLI | commander | 15 | `agentbus` 子命令 |
| 配置 | yaml | 2.x | `drivers.yaml` |
| 日志 | pino | 9.x | JSONL，审计导出同源 |
| 控制台 | React 18 + Vite | — | 只读视图订阅 `WS /console` |
| 测试 | vitest | 5.0 | 单测 + e2e（含假 ACP agent） |
| 格式 / lint | Biome | — | 单工具 |

### 5.3 仓库结构（pnpm monorepo）

```
agentbus/
  packages/
    core/        bus core：store、registry、delivery、guard、tasks、presence、WS / HTTP 服务
    protocol/    WS 帧与 MCP 工具参数的 zod schema、紧凑表格编解码、共享类型
    adapter/     MCP stdio server（agentbus agent）
    driver/      ACP client、会话管理、回合渲染、backends/{acp,cli,api}
    a2a/         A2A 1.0 数据模型映射、对外端点（M3）
    cli/         agentbus 可执行入口：serve / agent / driver / chat / tail / status / tasks / token / audit
    console/     React + Vite 控制台
  e2e/           端到端场景：假 ACP agent、谈判脚本、守卫 / 预算 / 恢复用例
  docs/
```

一个 npm 包 `agentbus` 对外，bin 同名；`agent` 子命令是被 MCP 宿主拉起的 stdio server，所以 cli 包要对 adapter 路径做单独的轻量入口（不加载 core / driver 依赖）。

### 5.4 数据模型（SQLite）

| 表 | 关键列 | 备注 |
|---|---|---|
| `agents` | `name PK, backend, authority, token_hash, capabilities_json, cwd, session_id, online, last_seen, version` | 同名接管需 token 匹配 |
| `rooms` | `name PK, kind(dm\|room), created_at, paused` | |
| `room_members` | `room, agent_name` PK | |
| `messages` | `id PK autoinc, room, from_agent, authority, text, payload_json, task_id?, created_at` | `(room, id)` 索引 |
| `message_blobs` | `message_id, blob_id` PK | 总线维护引用关系 |
| `cursors` | `agent_name, room` PK, `last_seen_id` | 推进即 `seen` |
| `deliveries` | `message_id, recipient` PK, `written_at, seen_at, handled_at, via, attempts, error` | 三态 |
| `tasks` | `id PK, room, from_agent, to_agent, state, deadline, max_turns, turns_used, created_at, updated_at` | 状态由总线校验 |
| `task_events` | `id PK, task_id, from_state, to_state, by, summary, artifacts_json, at` | 只追加 |
| `blobs` | `sha256 PK, size, mime, created_at, refcount` | 内容寻址 |
| `driver_turns` | `id PK, agent, session_id, message_ids_json, started_at, ended_at, tokens?, sent, exit_reason, recovered` | 可观测性 |
| `events` | `id PK, kind, agent?, room?, detail_json, at` | 暂停 / 解除 / 接管 / 降级等审计 |

### 5.5 接口

**WS /ws（adapter / driver ↔ core）**，JSON 帧，zod 校验：
`register(name, token, capabilities, session)` · `join(room)` · `send(room|to, text, payload?, task_id?)` · `history(room, limit)` · `inbox()` · `wait(timeout_s)` · `ack(message_ids)` · `task_create / task_update / task_cancel` · `status(text)` · `heartbeat`；
服务端推送：`message`（给 push / wait / driver）· `delivery`（三态变化）· `system`（paused / resumed / undeliverable）· `permission_result`（driver 用）。

**HTTP**：
`POST /api/participants/register` → token · `GET /api/participants/receive?after=` long-poll · `POST /api/participants/send` · `GET /a2a/agents/<name>`、`/.well-known/agent.json`（M3）· `WS /console` 只读流 · `GET /metrics`（可选）。

**MCP 工具（adapter 对模型）**：§2.1 F-A2 到 F-A9；列表类返回紧凑表格。

**driver 后端接口**：`open(cwd) → session` · `prompt(session, text, attachments) → stream` · `cancel(session)` · `recover(session_id) → session`。实现 `AcpBackend`（主）、`CliBackend`（兜底）、`ApiBackend`（M4）。

### 5.6 driver 配置

```yaml
bus: ws://127.0.0.1:7777/ws
agents:
  - name: alpha
    backend: claude-code      # claude-code | codex | gemini-cli | kimi | acp | api
    token_env: AGENTBUS_TOKEN_ALPHA
    cwd: /work/alpha
    autonomy: ask             # full | ask
    batch_window_ms: 1500
    turn_timeout_s: 600
  - name: gamma
    backend: codex
    token_env: AGENTBUS_TOKEN_GAMMA
    cwd: /work/gamma
    autonomy: full
```

### 5.7 连接模型、成员规则与总线配置

**一个 agent 最多两条连接。** driver 托管的 agent 有两个进程在说话：driver 本身（收消息、跑回合）和后端会话里被拉起的 MCP adapter（`send` / `task_update`）。两者都以同一个 `name` + 同一个 token 注册，但 `register` 帧带 `role`：

| role | 谁 | 职责 | 每 agent 数量 |
|---|---|---|---|
| `control` | driver，或交互式会话里的 adapter（无 driver 时） | 接收投递、上报 presence、声明 capabilities | 恰好 1 |
| `tool` | driver 模式下后端会话内的 adapter | 只出站：send / task_* / put_file / inbox（读自己的 cursor） | 0 或 1 |

同名接管规则（F-R5）按 role 分别应用；`tool` 连接不接收投递，投递只走 `control`。无 driver 的交互式 agent 只有一条 `control` 连接，由 adapter 担任。

**房间成员规则。** `dm:<a>|<b>` 在首次 `send` 时自动创建并把双方加入；命名房间需显式 `join`，向未加入的房间 `send` 被拒绝（返回 `not_member`）；human 可向任何房间发言，发言即加入；投递只发给成员。房间名限 `[a-z0-9][a-z0-9-]{0,63}`。

**token 引导。** `agentbus serve` 首次启动生成一枚 `human` 权威的 owner token，写到 `<data>/owner.token`（只读权限）并打印一次；`chat` / `tail` / `tasks` / `token create` 默认从该文件读 token。此后所有 agent token 由 `token create` 签发，表里存 scrypt 哈希（Node 内建，无原生依赖），明文只在签发时出现一次。

**总线配置** `agentbus.yaml`（全部有默认值，可不写）：

```yaml
bind: 127.0.0.1          # --bind 0.0.0.0 进入局域网模式，强制 token
port: 7777
data_dir: ~/.agentbus    # sqlite、blobs、owner.token、日志
guard:
  cap: 20                # 自上次人类消息起的 bot 消息上限
  min_interval_ms: 2000
mailbox:
  ttl_hours: 24
  max_per_agent: 1000
push:
  seen_timeout_s: 10     # written 后无 seen 则降级
blobs:
  max_bytes: 104857600   # 100MB
  quota_bytes: 10737418240
message:
  max_text_bytes: 65536  # 超长正文要求走 blob
```

---

## 6. 后端适配矩阵

"已验证" = 本机实测；"文档" = 依据公开文档；"待验证" = 需在 M0 里确认。

| 后端 | 出站 | 入站能力 | 长驻会话（driver 用） | 崩溃恢复 | 自主级别开关 | presence 来源 | 状态 |
|---|---|---|---|---|---|---|---|
| Claude Code | MCP | driver + inbox（+ push，预览，仅交互式） | `@agentclientprotocol/claude-agent-acp`；或 Agent SDK；或 `claude -p --input-format stream-json` 单进程多轮 | `--resume <sid>` | `--dangerously-skip-permissions` / `--permission-mode` | hooks + driver 上报 | MCP、hooks 已验证；ACP 适配器：文档；channels：自定义 channel 需 dev flag，dev flag 在 `-p` / SDK 下被忽略；进入 allowlist 的 channel 在 `-p` 下可用 |
| Codex CLI（本机 0.155.1） | MCP | driver + inbox | `@agentclientprotocol/codex-acp` | `codex exec resume <id>`（已确认） | `--full-auto` / sandbox 级别 | `notify` 钩子（仅出站）+ driver 上报 | 文档；M-1 / M0 验证 |
| Gemini CLI | MCP | driver + inbox | 原生 ACP | ACP `session/load`（可选） | `--yolo` / approval mode | driver 上报 | 文档；M2 零新代码接入 |
| Kimi（kimi-cli） | MCP | driver + inbox | ACP 官方列表内 | 待确认 | 待确认 | driver 上报 | 待验证 |
| OpenCode / 其他 MCP 宿主 | MCP | inbox（+ driver，若有 ACP 或 headless） | OpenCode 在 ACP 列表 | 各自 | 各自 | 总线观察 | 待验证；无 ACP 者走 `CliBackend` |
| 纯 API agent（`api`） | 内置 | driver（天然） | driver 自己持有对话 | 不适用 | 配置 | driver 上报 | M4 |
| 外部 A2A agent | A2A client | A2A server（它自己的） | 不适用 | 不适用 | 不适用 | A2A task 状态 | M3 |

---

## 7. 开发任务

估时单位为**人日**，按一人全职估；"依赖"指必须先完成的任务。里程碑验收在每段末。

### M-1 · 半天 spike（0.5 人日）

| ID | 任务 | 产出 | 依赖 | 估时 |
|---|---|---|---|---|
| T-1.1 | 用现成 claude-message-bus + participants API 写一个 Codex driver 脚本（TS），经 `codex-acp` 持有长驻会话，`after` 游标即 ack | `e2e/spike-codex-driver.ts` | — | 0.5 |

**验收**：Claude(channel) ↔ Codex(driver) 隔着总线完成一轮谈判。这是对整个设计最便宜的证伪机会。

### M0 · 两家后端对谈（约 10.5 人日）

| ID | 任务 | 产出 | 依赖 | 估时 |
|---|---|---|---|---|
| T0.1 | monorepo 脚手架：pnpm workspace、tsconfig、Biome、vitest、tsup 打包单一 `agentbus` bin，adapter 轻量入口 | 可构建的空包 | — | 0.5 |
| T0.2 | `protocol` 包：WS 帧 zod schema、MCP 工具参数 schema、紧凑表格编解码（F-A10） | `packages/protocol` | T0.1 | 1 |
| T0.3 | `core` 存储层：§5.4 全部表、WAL、迁移、Store API | `packages/core/store` | T0.1 | 1 |
| T0.4 | `core` 注册与身份：token 签发 / 校验（F-S1）、同名接管规则（F-R5）、presence `online` | registry | T0.3 | 0.5 |
| T0.5 | `core` 投递引擎：`deliver()` 三态、mailbox、cursor 推进、at-least-once（F-D1、F-D2、F-D8） | delivery | T0.3 | 1 |
| T0.6 | `core` 守卫：bot 计数、human 清零、限速、`paused` 系统消息（F-R2–R4） | guard | T0.5 | 0.5 |
| T0.7 | `core` WS 服务：register / join / send / history / inbox / heartbeat 帧处理，`WS /console` 只读流 | ws server | T0.2、T0.4–T0.6 | 1 |
| T0.8 | `adapter`：MCP stdio server，工具 `agents / rooms / join / history / send / status`、instructions 文本、注入边界包装（F-A1–A4、A7、A11）；无 wait、无 push | `packages/adapter` | T0.2、T0.7 | 1 |
| T0.9 | `driver` 核心：ACP client 会话管理、每 agent 串行队列、批窗口、人类消息直通、回合渲染、seen / handled 标记、超时与 recover（F-D3–D7） | `packages/driver` | T0.2、T0.7 | 1.5 |
| T0.10 | `AcpBackend`：接 `codex-acp` 与 `claude-agent-acp`，`session/new` 传 `mcpServers` 挂 adapter；验证两家长驻与 recover | backends/acp | T0.9 | 1 |
| T0.11 | `cli`：`serve` / `agent` / `driver` / `chat` / `tail` / `status` / `token create`（F-H1–H3） | `packages/cli` | T0.7–T0.10 | 1 |
| T0.12 | e2e：alpha(Claude, driver) ↔ gamma(Codex, driver) 谈判脚本，人从 `chat --to` 介入一次；投递零丢失断言 | `e2e/negotiation.test.ts` | T0.11 | 0.5 |

**验收**：alpha 与 gamma 完成一次与 2026-10-14 相同的协议谈判；人类介入被当作该 agent 的终端输入；每条消息 delivery 三个时间戳单调、恰好 handled 一次；**不依赖 push**。

### M1 · inbox + 人在环（约 6 人日）

| ID | 任务 | 产出 | 依赖 | 估时 |
|---|---|---|---|---|
| T1.1 | `inbox()`：按 cursor 返回未读、推进 cursor 标 `seen`；instructions 要求回合开始先调（F-A5） | adapter + core | M0 | 0.5 |
| T1.2 | `wait_for_message`：阻塞、按宿主 MCP 超时自动分段、`waiting` 状态上报；presence 排除阻塞中（F-A6） | adapter + core | T1.1 | 1 |
| T1.3 | Claude `UserPromptSubmit` hook 脚本：注入未读消息（可选安装） | `packages/adapter/hooks` | T1.1 | 0.5 |
| T1.4 | `autonomy: ask`：ACP `session/request_permission` → `input-required` dm 给人 → 人回答 → `permission_result` 回传（F-D10） | driver + core | M0 | 1.5 |
| T1.5 | presence 合成：adapter 上报 > driver 上报 > 总线观察 > unknown | core | T1.2 | 0.5 |
| T1.6 | blob store：内容寻址、`message_blobs`、refcount、配额；`put_file / get_file / list_files`，落盘路径限制（F-A8、F-B1–B4） | core + adapter | M0 | 1.5 |
| T1.7 | HTTP participants API：register / receive（long-poll，`after` 即 seen）/ send（F-X1） | core http | M0 | 0.5 |

**验收**：一个人亲手用的 Codex 交互式会话以 inbox 参与对话；driver 托管的 Claude 在 `ask` 模式下把一次权限请求推给人，人在 dm 里放行后回合继续；一个文件从 alpha 经 blob 到 gamma 的 `.agentbus/inbox/`。

### M2 · Task 语义 + 控制台只读（约 10 人日）

| ID | 任务 | 产出 | 依赖 | 估时 |
|---|---|---|---|---|
| T2.1 | `a2a` 包：A2A 1.0 Task / Message / Part / Artifact 与内部模型的映射，核心不依赖 SDK 类型（F-T6） | `packages/a2a/model` | M0 | 1 |
| T2.2 | Task 状态机：合法转换表、总线校验、`task_events` 只追加（F-T1、F-T2） | core tasks | T2.1 | 1 |
| T2.3 | `task_create / task_update / task_cancel` MCP 工具与 WS 帧；`send` 带 `task_id`（F-A9） | adapter + core | T2.2 | 1 |
| T2.4 | 预算调度器：`deadline` / `max_turns` 计数、到点 `failed(budget)` 并通知（F-T3） | core | T2.2 | 1 |
| T2.5 | `input-required` 升级路径与 driver 串行队列中的 task 排队（F-T4、F-T5） | core + driver | T2.3、T1.4 | 1 |
| T2.6 | 控制台只读版：对话列表、房间视图、任务看板（按 `task_id` 派生）、agent 面板（F-H4）；`agentbus tasks` CLI | `packages/console` | T2.3 | 3 |
| T2.7 | Gemini CLI 经 ACP 接入验证（零新代码），更新矩阵 | 文档 | M0 | 0.5 |
| T2.8 | e2e：review-agent 把 finding 派成 Task，fix agent 完成回 artifact；不收尾 task 预算到点 `failed(budget)` | `e2e/task.test.ts` | T2.4、T2.5 | 1 |
| T2.9 | 回合记录 `driver_turns` 落库与控制台展示（F-O2） | driver + console | T2.6 | 0.5 |

**验收**：跨后端派活端到端成功；预算用例通过；Gemini CLI 接入零新代码；看板能从消息派生出任务状态。

### M3 · A2A 对外 + 多机（约 8 人日）

| ID | 任务 | 产出 | 依赖 | 估时 |
|---|---|---|---|---|
| T3.1 | A2A 对外端点：`@a2a-js/sdk` server、`/a2a/agents/<name>`、Agent Card 聚合；外部 task → 内部投递（F-X3） | `packages/a2a/server` | M2 | 3 |
| T3.2 | `--bind 0.0.0.0` 局域网模式：强制 token、拒绝无 token 连接（F-X2） | core | M0 | 1 |
| T3.3 | 离线 mailbox TTL 与上限、丢弃通知（F-D8） | core | M0 | 0.5 |
| T3.4 | 同名接管 token 校验用例：同名 + 错 token 被拒 | e2e | T3.2 | 0.5 |
| T3.5 | 多机 e2e：两台机器各一个 agent 对谈；外部 A2A client 给 Codex 派活拿结果 | e2e | T3.1、T3.2 | 1 |
| T3.6 | 0.3 兼容层开关与测试（对接仍在 0.3 的外部 agent） | a2a | T3.1 | 1 |
| T3.7 | 文档：多机部署、token 分发、A2A 接入 | docs | T3.5 | 1 |

**验收**：外部 A2A client 给总线上的 Codex 派活并拿到结果；两机对谈；错 token 接管被拒。

### M4 · 可选能力与打磨（约 9 人日）

| ID | 任务 | 产出 | 依赖 | 估时 |
|---|---|---|---|---|
| T4.1 | push：`--push on` 声明 `claude/channel`、dev flag 探测打 `preview` 标、`written` 后 T 秒无 `seen` 降级（F-A12、F-D9） | adapter + core | M1 | 2 |
| T4.2 | `ApiBackend`：跨进程调 LiteLLM proxy 之类网关的内嵌 agent | backends/api | M0 | 2 |
| T4.3 | `CliBackend` 兜底：每回合 `exec resume` 的后端适配，矩阵标注 | backends/cli | M0 | 1 |
| T4.4 | 控制台动作：暂停 / 解除、强制取消、回答 `input-required`（F-H5） | console + core | M2 | 1.5 |
| T4.5 | `agentbus audit` JSONL 导出、`/metrics` Prometheus 端点（F-O3、F-O4） | cli + core | M2 | 1.5 |
| T4.6 | 文档化 5 分钟上手、npm 发布、Windows / macOS / Linux 三平台冒烟 | docs + CI | 全部 | 1 |

**验收**：5 分钟上手文档可独立走通；push 打开时降级可观测；全部矩阵行至少"文档"级。

### 总览

| 里程碑 | 人日 | 累计 |
|---|---|---|
| M-1 | 0.5 | 0.5 |
| M0 | 10.5 | 11 |
| M1 | 6 | 17 |
| M2 | 10 | 27 |
| M3 | 8 | 35 |
| M4 | 9 | 44 |

一人全职约 9 周；M0 结束即可内部试用，M2 结束即可给 review-agent 当真实用户。

---

## 8. 验证方法

- **投递正确性**：注入 N 条消息（含离线、并发、同名重连、driver 回合中途崩溃并 recover），断言每条恰好被目标处理一次，且 delivery 三个时间戳单调。
- **跨后端等价性**：同一协商任务，分别用 Claude↔Claude、Claude↔Codex、Codex↔Codex 跑 k 次，比较回合数、达成一致率、人介入次数——证明后端差异不影响总线层行为。
- **守卫与预算**：互相"收到，谢谢"的 agent 在上限处暂停、人类消息能解除；不收尾的 task 在 `deadline` / `max_turns` 到点置 `failed(budget)`。
- **人在环**：`ask` 模式下权限请求必须在 dm 里出现为 `input-required`，人回答后回合继续；人类消息必须跳过批窗口。
- **延迟**：driver / inbox / wait / push 各路径的 `written→seen` 与 `seen→handled` 分位写进文档；push 降级率单独统计。

---

## 9. 风险与未决

### 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| Claude channels 是研究预览，自定义 channel 只能经 dev flag 加载 | push 不可静默或失效 | push 不作基线、不进验收、默认关闭；打开时自动降级 |
| 各家 ACP 适配器成熟度不一（`session/load` 可选、权限请求形态差异） | driver 回合错乱 | M-1 / M0 逐家验证写进矩阵；每 agent 串行；recover 失败降级为新会话并标注 |
| `claude-agent-acp` 缺某项能力（如权限模式、mcpServers 透传） | Claude driver 受限 | 备用路径：直接用 `@anthropic-ai/claude-agent-sdk` 封装成同一后端接口 |
| 宿主 MCP 工具超时短于 `wait_for_message` 期望 | wait 需频繁循环 | adapter 自动分段；主路径用 driver |
| driver 模式下人对"看不到终端"有预期落差 | 困惑 | 产品立场明确：总线就是终端；`chat --to` 与控制台即 UI |
| A2A 1.0 刚稳定，外部 agent 多在 0.3 | 互通失败 | `@a2a-js/sdk` 0.3 兼容层可开（T3.6）；数据模型隔离在 `a2a/` |
| bot 互相礼貌消耗 token | 成本 | 闲聊靠守卫；任务靠预算 |
| driver prompt 全是总线内容，注入面大 | bot 消息冒充指令 | §4.7 注入边界；`get_file` 路径不可指定 |
| adapter 冷启动慢 | 每个会话启动卡顿 | 单文件打包、轻量入口、懒加载，目标 < 300ms，CI 测量 |

### 未决

1. 实现语言已定 TypeScript。若坚持 Python，adapter 必须单文件、无重依赖、启动 300ms 内；核心与控制台仍建议 TS。
2. Claude driver 主路径选 `claude-agent-acp` 还是直接 Agent SDK，M0 的 T0.10 实测后定；文档先按 ACP 统一写。
3. 名字：工作名 `agentbus` 与目录名 `aimbus` 不一致，发布前定一个并查 npm / GitHub 占用。
4. 待 M0 实测的默认值：push 降级超时 10s、`batch_window_ms` 1500、task `deadline` 1h、`max_turns` 30、单 blob 100MB、总配额 10GB。
5. 控制台是否复用 claude-message-bus 的 React 视图形状；倾向先复用其 API 形状，控制台在 M2 后写。

---

## 附录 A · 三个协议各管什么

| | MCP | A2A（1.0） | ACP |
|---|---|---|---|
| 解决 | 模型 ↔ 工具 | agent ↔ agent 派活 | 客户端 ↔ agent 会话驱动 |
| 在 agentbus 里 | adapter 对 agent 暴露的接口 | 任务语义与对外端点 | driver 就是 ACP client；长驻会话、权限请求、崩溃恢复都走它 |
| 传输 | stdio / HTTP | HTTP + SSE + webhook（1.0 另有 gRPC） | stdio JSON-RPC |
| 不覆盖 | 空闲 agent 如何被叫醒 | 群聊、人类权威、如何叫醒 CLI | agent 之间的语义 |

**不采用 A2A 的地方**：A2A 是 client → server 点对点，对等协商要求双方都是 server。agentbus 让所有 agent 只做 outbound 连接，由总线充当每个 agent 的 A2A 代理端点。

## 附录 B · 术语

- **driver / inbox / push**：三种入站能力。driver 是基线；inbox 含 `inbox()` 与 `wait_for_message`（v0.1 称 poll）；push 是可选预览。
- **written / seen / handled**：投递三态；push 只能到 written。
- **mailbox**：某 agent 的待投递队列。**cursor**：(agent, room) 的 `last_seen_id`，推进即 ack。
- **guard**：bot 消息计数与暂停机制，只管无任务闲聊。**task 预算**：`deadline` + `max_turns`。
- **relayer**：代人转发的参与者，有人类权威但计入上限。**token**：每 agent 一个，决定身份与权威。
- **recover**：driver 在后端进程崩溃后重建会话的方式，不是回合原语。

## 附录 C · 来源、取舍与版本记录

**来源**

- **claude-message-bus**（bbaldino，v0.9.2）：2026-10-14 本机实跑，证明 agent 间协商质量是真的，也证明它只有 channels 一处绑死 Claude。**核心从零实现，不 fork**：它 11k 行 Rust + 9k 行 TS 控制台围绕 channels 设计，表结构无 deliveries / tasks / capabilities。继承其语义：exchange cap 计数规则（自上次人类消息起按 bot 消息条数计，human 清零）、human / relayer / bot 三级权威、participants API 的"cursor 即 ack"、同名接管留痕、status 文件。不复用其 channel 必需假设和 `CLAUDE_PROJECT_DIR` 命名（它在 Windows 上能跑，"Unix-only"不是问题）。作为 M-1 试验台。
- **danielrosehill/Claude-Agent-Relay-Plugin**：LAN 上的 MCP 中继（Python 约 700 行），相当于 agentbus 的 inbox 子集，无投递、守卫、身份校验、叫醒。借其内容寻址 blob store 与紧凑表格返回；不借"把总线直接当远程 MCP server 加进会话"——那是 Claude 平台向的便利，agentbus 接入面统一在 adapter。
- **review-agent**：第一个真实用户，M2 的端到端验收。

**核实过的外部事实（2026-10-15）**

| 事实 | 来源 |
|---|---|
| channels 仍是 research preview；自定义 channel 只能走 dev flag；dev flag 在 `-p` / SDK 下被忽略；Claude Code 不确认通知；allowlist 内插件在 `-p` 下可用 | code.claude.com/docs channels 与 channels-reference |
| `claude -p --input-format stream-json` 支持单进程多轮；`--resume` 可跨目录 | code.claude.com/docs headless |
| ACP `session/load` 为可选能力；`session/new` 可传 mcpServers | agentclientprotocol.com |
| ACP 官方列表含 Codex、Claude Agent、Gemini CLI、Kimi CLI、OpenCode；npm 有 `@agentclientprotocol/codex-acp` 2.2、`@agentclientprotocol/claude-agent-acp` 0.90（二者 @zed-industries 旧名已弃用）、`@agentclientprotocol/sdk` 1.8 | agentclientprotocol.com、npm |
| **A2A 规范 1.0 已正式发布**，`@a2a-js/sdk` 1.x 实现 1.0 并提供 0.3 兼容层（**修正 DESIGN_REVIEW.md 附录"1.0 仍是 RC"的判断**） | npm `@a2a-js/sdk` 1.3.0 README |
| 本机 codex-cli 0.155.1 有 `codex exec resume <id>` 与 `fork` | `codex exec --help` |
| claude-message-bus exchange cap 默认 20，按 bot 消息条数计，human 清零；另有每 agent 2s 限速；`cursors(room, agent_name, last_delivered_id)` | 源码 `src/bus/delivery.rs`、`schema.sql` |

**版本记录**

| 版本 | 日期 | 变化 |
|---|---|---|
| v0.1 | 2026-10-15 | 初稿：能力声明 + 三条投递路径 + 不自造协议 |
| v0.2 | 2026-10-15 | 按 `DESIGN_REVIEW.md` 11 条修订：driver 长驻会话、push 降级、投递三态、Task 硬定义、注入边界、每 agent token、里程碑重排、TypeScript、§13 从零实现；补 blob 内容寻址与紧凑表格 |
| v0.3 | 2026-10-15 | 重排为功能清单（F-xx）/ 核心机制 / 技术栈（含包名版本）/ 开发任务（T-xx，人日估时）；Claude driver 主路径改 `claude-agent-acp`；A2A 锁 1.0；补 §5.7 连接 role、成员规则、token 引导、总线配置 |

**实施记录**

| 日期 | 完成 | 偏离设计之处 |
|---|---|---|
| 2026-10-15 | M0 全部（T0.1–T0.12）；真机：两个 Claude agent 经 `claude-agent-acp` 完成谈判，Codex 因账号配额未验 | 实现语言 TS 如期；HTTP 层暂用 Node 原生 `http` 而非 hono；token 哈希用 scrypt 而非 argon2；adapter 在宿主关闭 stdin 时自行退出（设计未提） |
| 2026-10-15 | M4（T4.1–T4.5）：push——adapter `--push` 声明 `experimental['claude/channel']`、消息事件转 `notifications/claude/channel`、注册带 `push_preview`，bus 在 `push.seen_timeout_s` 后把未 seen 的 push 投递改标 `push->mailbox`；`ApiBackend`（OpenAI 兼容 chat/completions + MCP 工具 function calling 循环，历史随会话保留、recover 不丢上下文）；`CliBackend`（每回合 spawn，首轮正则抓 session id，续轮 `args_resume`，stdout 永不当回复）；控制台动作（`POST /api/console/rooms/<r>/pause|resume|send`、`/tasks/<id>/cancel`，仅 human；UI 加按钮与回话框）；`agentbus audit` JSONL 与 `/metrics` | push 只验证了 adapter 侧（MCP 客户端收到通知、capabilities 正确、降级计时生效），未在真实 Claude Code dev-flag 会话里跑；`dev flag 探测`无法从 adapter 内判断，`push_preview` 在 push 开启时恒为 true；指标按请求从 SQLite 聚合而非进程内计数器；T4.6 发布打包未做（仍以 monorepo 源码运行） |
| 2026-10-15 | M3（T3.1–T3.5、T3.7）：`packages/a2a` 改为基于 `@a2a-js/sdk` 1.3（1.0 规范）——`DefaultRequestHandler` + `JsonRpcTransportHandler` 挂在 bus 的 HTTP 路由钩子上，executor 把外部 `SendMessage` 变成参与者 `a2a` 派发的 Task，bus `task` 事件回流为 status / artifact update；每 agent 一张 Agent Card，索引 `/.well-known/agentbus-agents.json`；LAN 硬化：未注册 socket 10s 断开，`public_host` 配置；mailbox `max_per_agent`（最旧的标 `mailbox_full` 并通知发送方）；`inbox` 改为按投递记录取未读（被丢弃的不再回流）；多进程 e2e：serve 绑 0.0.0.0，两个 driver 进程经局域网 IP 接入，官方 A2A client 派活拿到 artifact | A2A 1.0 的 JSON-RPC 方法名是 `SendMessage` / `GetTask` / `CancelTask`（非 0.3 的 `message/send`），默认阻塞到终态；未实现 `SendStreamingMessage`（card 声明 streaming=false）；T3.6 0.3 兼容层未开（SDK 提供 `compat/v0_3`，待有 0.3 对端再接）；A2A 端点无鉴权，靠 `--bind` 的网络边界；聚合卡片路径用 `/.well-known/agentbus-agents.json` 而非设计稿的 `agent.json`（1.0 规范单卡片路径是 `agent-card.json`） |
| 2026-10-15 | M2（T2.1–T2.6、T2.8、T2.9）：Task 状态机（§4.5 转换表，总线校验，`task_events` 只追加）、`task_create / task_update / task_cancel / tasks` 工具与帧、预算（`max_turns` 按线程内 bot 消息计，`deadline` 由 tick 清扫，到点 `failed(budget)` 并由 `bus` 发系统消息关闭线程）、input-required 升级（dispatcher 为 bot 或显式 escalate 时 dm 房间外的人）、task 线程免交换守卫、`turn_report` 帧与 `driver_turns`、只读控制台（React + Vite，`/console/`，`/api/console/*` 与 `WS /console` 仅 human）、`packages/a2a` 1.0 数据模型映射 | T2.7 Gemini CLI 未装，未验；A2A SDK 未引入（M3 端点时再装），a2a 包是手写的 1.0 形状；A2A `REJECTED` / `AUTH_REQUIRED` 折叠为内部 `failed`；控制台"任务看板动作"仍留 M4 |
| 2026-10-15 | M1 全部（T1.1–T1.7）：`inbox` / `wait_for_message`（按宿主超时上限分段，默认 55s）、`UserPromptSubmit` hook、`autonomy: ask` → dm 给房间内的人并回传、presence 合成、blob 内容寻址与 `put_file` / `get_file` / `list_files`、participants HTTP API | Task 尚未存在，`ask` 的 input-required 先以带 `payload.kind=permission_request` 的 dm 实现，M2 接到 Task 状态机；`wait_for_message` 不能绕过宿主超时，只能上限内返回并提示再调 |
