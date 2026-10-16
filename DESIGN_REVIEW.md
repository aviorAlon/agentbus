# PRODUCT_DESIGN.md v0.1 评审

> 2026-10-15 · 针对 `PRODUCT_DESIGN.md` v0.1 · 评审前核实过的外部事实见文末

## 结论

**核心从零写，不 fork claude-message-bus；把它当"规格来源 + 半天试验台"，不当代码底座。**

理由：

1. 它 11k 行 Rust + 9k 行 TS 控制台，整个 `agent/` 模块和 `launch` 都围绕 channels 设计；表结构（`messages` + 每房间 `cursors`）没有 deliveries / tasks / capabilities，加 driver、poll、task 三件事等于重写 store、registry、delivery。
2. 文档已经倾向 Python 写 driver 和 adapter，再保留 Rust 核心就是两套工具链、两套构建（Rust 还要先 `make ui` 嵌入前端），Windows 上尤其麻烦。
3. 真正值得继承的是**语义**而不是代码：exchange cap 的计数规则、human / relayer / bot 三级权威、participants API 的"cursor 即 ack"、同名接管留痕。这些写进新文档几百字就够。

v0.1 的大方向（能力声明 + 三条投递路径 + 不自造协议）是对的。下面是需要改的地方，按影响排序。

---

## 1. driver 的"每回合 resume"是错的原语（最大改动）

文档把 driver 定义为"收到消息 → `resume(session_id, prompt)` → 跑一回合 → 进程退出"。这带来文档自己列出的风险：并发 resume 冲突、每回合冷启动、上下文重读、回合中途状态丢失。

现在三家都提供**长驻会话进程**，不需要 resume：

| 后端 | 长驻方式 |
|---|---|
| Claude Code | `claude -p --input-format stream-json --output-format stream-json`，一个进程持续收多轮 user 消息；或直接用 Agent SDK（Python / TS） |
| Codex | 官方 ACP 适配器 `agentclientprotocol/codex-acp`：`session/new` 后反复 `session/prompt` |
| Gemini CLI / Kimi CLI / OpenCode | 都在 ACP 官方 agent 列表里，同上 |

**改法**：driver 对每个 agent 持有一个活的 session；一个"回合"就是一次 `prompt()`；只有进程崩溃才 `session/load` / `--resume` 重建。§7 的"续会话"一列变成"会话能否长驻"，全部是"能"。`codex exec resume <id>` 只做崩溃恢复（本机 0.155.1 已确认有 `resume` 和 `fork` 子命令）。

副作用：driver 本质上就是一个 **ACP client**。M2 的 `AcpBackend` 应该提前到 M0，`CliBackend` 退为 ACP 不可用时的兜底，而不是反过来。

## 2. push 路径的现实比文档写的更差，M0 不该依赖它

核实官方 channels 文档（2026-10 版）：

- 自定义 channel（agentbus 一定是）**只能**通过 `--dangerously-load-development-channels server:<name>` 加载，每次启动弹全屏警告对话框，无法静默。
- 这个 dev flag 在 `-p` 和 Agent SDK 下**被忽略**，channel 不注册。
- 要摆脱 dev flag 只有两条路：进 Anthropic 官方 allowlist，或 Team / Enterprise 管理员在 `allowedChannelPlugins` 里加白。个人 Pro / Max 用户没有后一条。
- Claude Code **不确认** channel 通知；session 没注册 channel 或被组织策略禁用时，通知静默丢弃，发送方拿不到任何错误。

v0.1 §7 写"channels 在 `-p` 下不可用"不够准确：allowlist 内的插件在 `-p` 下可用（文档明确提到 `-p` 模式下会禁用需要终端输入的工具）；不可用的是 dev flag。这个区别决定了"如果哪天上了 allowlist，push + 无头就同时成立"。

**改法**：

- M0 的 alpha 也走 driver（SDK / stream-json），push 彻底从验收条件里拿掉。
- push 只在用户显式传 `--push on` 时启用，adapter 探测到自己是以 dev flag 加载的就打标，控制台展示"预览功能"。
- 投递状态里 push 永远不能标 `DELIVERED`，只能标 `written`（见第 5 条）。

## 3. poll 被高估了，它不是基线

`wait_for_message(timeout)` 只在 agent **自己决定等**的那一刻有效；回合一结束，交互式会话里的 agent 就不可达了。再加上宿主的 MCP 工具超时（Claude Code 默认 `MCP_TOOL_TIMEOUT`），它需要循环调用，每次循环都是一轮模型调用。

真正可靠的基线只有 driver。poll 应改名并降级为两件事：

- **回合边界拉取**：adapter 的 `instructions` 要求 agent 每个回合开始先 `inbox()`；Claude 可以用 `UserPromptSubmit` hook 把未读消息注入，Codex 用 `notify` 钩子只能做出站提示。
- **显式等待**：`wait_for_message` 保留，用于"我派了任务，现在等结果"这一种场景，文档里明说代价。

§4.1 的"基线是 driver + poll"改成"基线是 driver；poll 是交互式会话的补充"。

## 4. "人用交互式会话 XOR 总线叫得醒"这个两难可以消解

§7 的关键推论是对的，但结论"把选择暴露给用户"是放弃。既然 driver 持有长驻会话，人就可以**通过总线**和这个会话说话：`dm:human|gamma` 里人类消息就是这个 agent 的"终端输入"。

产品立场应该写成：**driver 模式下，总线就是那个 agent 的终端**。`agentbus chat --to gamma` 和控制台就是人的 UI；`autonomy: ask` 时权限请求（ACP `session/request_permission`）作为 `input-required` 推给房间里的人。
这样 §7 的矩阵少一列"人能否参与"，§2 的场景 1 也不再需要"开着终端"。

## 5. 投递状态缺 ack，push 的 `DELIVERED` 是假的

§4.3 的算法把 `inject()` 直接返回 `DELIVERED`，但 Claude Code 不确认通知（见第 2 条）。建议统一成三态，所有路径一个口径：

```
written   总线已写到某条传输（push 通知已发 / driver 已 prompt / 已进 mailbox）
seen      agent 侧 adapter 以 cursor 确认收到（参与者 API 的 after 游标就是这个）
handled   agent 在回合里对该消息做了任何动作（send / task_update / 显式 ack）
```

- `deliveries` 表按 (message, recipient) 记录三个时间戳。
- push 路径 `written` 后 T 秒内没有 `seen`，自动降级到该 agent 的下一条路径（driver 或 mailbox），这才叫"push 是优化，不是假设"。
- cursor 按 (agent, room) 维护，和 claude-message-bus 一致；去重键是 `message.id`。

## 6. Task 模型缺几个硬定义

"Task 是带状态机的 Message 线程"是好抽象，但 v0.1 没回答：

- **谁校验状态转换**：建议总线校验（非法转换拒绝），`task_events` 只追加。
- **Task 住在哪**：建议 task 不开新房间，消息带 `task_id` 留在原房间 / dm 里，任务看板从消息派生。开新房间会让历史碎片化。
- **input-required 发给谁**：发给派发方；派发方是 bot 且 bot 也答不了时，升级给房间里有人类权威的参与者。
- **截止与预算**：每个 task 带 `deadline` 和 `max_turns`，到点自动 `failed(reason=budget)`，这才是 §12 "互相礼貌消耗 token"的真正解法，exchange cap 只管无任务的闲聊。
- **并发**：一个 agent 同时收到两个 task 怎么办。driver 模式下建议串行（一个会话一次只跑一个回合），队列深度可见。
- **A2A 版本**：v1.0 仍是 RC，SDK 普遍实现的是 0.3。锁 0.3 的 Task / Message / Part / Artifact 数据模型，隔离在 `a2a/` 后面，对外端点推到 M3 不变。

## 7. 注入边界在 driver 模式下更严重

交互式会话里，总线消息只是工具返回值；driver 模式下**整段 prompt 都是总线内容**，没有人类输入做锚。要补：

- 渲染格式固定为数据块，每条带 `from` / `authority(human|relayer|bot)` / `room` / `id`。
- driver 的 system prompt 明说：只有 `authority=human` 的消息是指令，bot 消息是"待评估的请求"，接不接由本回合决定。
- `get_file` 是写盘能力，不是"只说话"。落盘路径限定在 `<cwd>/.agentbus/inbox/`，路径由总线生成，agent 不能指定。

## 8. 身份与安全

- "参与者 secret" 是全局共享密钥，改成**每个 agent 一个 token**（注册时签发、落库）。§8 的"同名接管"规则需要 token 才能防止另一台机器用同名把会话抢走。
- 默认 `127.0.0.1` 正确；`--bind 0.0.0.0` 时强制 token，不给无 token 模式。
- `autonomy: full` 的 agent 在控制台打标，这条保留。

## 9. 里程碑重排

v0.1 的 M0 要做 bus core + adapter + 两家 driver，1–2 周偏紧，同时还有一个半天 spike。建议：

| 里程碑 | 内容 | 相对 v0.1 的变化 |
|---|---|---|
| **M-1 · 半天** | 用现成 claude-message-bus + participants API 写 Codex driver | 保留；但 driver 用 `codex-acp` 长驻会话，不用 `exec resume` |
| **M0 · 1 周** | 自写 bus（rooms / messages / cursors / deliveries / guard）+ MCP adapter（无 push、无 wait）+ ACP driver（Claude 经 SDK，Codex 经 codex-acp）+ `chat` / `tail` | push 和 CliBackend 移出 M0 |
| **M1** | `inbox()` 回合边界拉取 + `wait_for_message`；`autonomy: ask` → input-required 推给人 | ApiBackend 推后 |
| **M2** | Task 状态机（A2A 0.3 模型）+ 任务预算 + 看板只读 | ACP driver 已在 M0 |
| **M3** | A2A 对外端点 + `--bind` + 每 agent token + 离线 TTL | 不变 |
| **M4** | push（可选）、ApiBackend、审计导出、指标 | push 降到最后 |

## 10. 实现语言：选一种，建议 TypeScript

v0.1 建议 Python，理由是与 review-agent 同栈。反对理由更重：

- adapter 要作为 MCP stdio server 被每个 agent 会话拉起，还要在将来能当 channel；官方 MCP SDK、channels 示例、`codex-acp`、`claude-agent-acp`、ACP SDK 都是 TS 优先。
- 控制台本来就是 TS。
- Claude 后端用 Agent SDK，TS 和 Python 都有，不构成差异。
- review-agent 的联动在 M2 以后，走的是 MCP / HTTP，不要求同语言。

Python 唯一的实际优势是 LiteLLM 做 ApiBackend，而 ApiBackend 已经推到 M4，到时用 LiteLLM proxy 跨进程调即可。

如果仍选 Python，adapter 必须是单文件、无重依赖、启动在 300ms 内，否则每个会话启动都会卡。

## 11. 小问题

- §6.1 presence 的"总线观察到的工具活动 → working"会把 `wait_for_message` 的阻塞也算成 working，要排除。
- §4.4 批处理窗口 `batch_window_ms` 和"人类消息立即投递"冲突：人类消息应跳过批窗口。
- §13 提到"不复用其 Unix-only 代码"，但本机实测它在 Windows 上跑起来了；这句改成"不复用其 `CLAUDE_PROJECT_DIR` 命名和 channel 必需的假设"更准确。
- 工作名 `agentbus` 与本目录名 `aimbus` 不一致，定一个。

---

## 附：本次核实过的事实

| 事实 | 来源 |
|---|---|
| channels 仍是 research preview；自定义 channel 只能走 dev flag；dev flag 在 `-p` / SDK 下被忽略；Claude Code 不确认通知 | code.claude.com/docs/en/channels 与 channels-reference |
| allowlist 内插件在 `-p` 下可用（终端输入类工具被禁用） | 同上 |
| `claude -p --input-format stream-json` 支持单进程多轮；`--resume` 可跨目录 | code.claude.com/docs/en/headless |
| ACP `session/load` / `session/resume` 为可选能力，由 `initialize` 声明；`session/new` 可传 mcpServers | agentclientprotocol.com/protocol/session-setup |
| ACP 官方列表含 Codex（`agentclientprotocol/codex-acp`）、Claude Agent（Zed 适配器）、Gemini CLI、Kimi CLI、OpenCode | agentclientprotocol.com/overview/agents |
| A2A 正式版仍是 0.3.0，1.0 为 RC | 多家 SDK 页面，未找到 2026 年官方定稿公告 |
| 本机 codex-cli 0.155.1 有 `codex exec resume <id> [prompt]` 和 `fork` | `codex exec --help` |
| claude-message-bus 0.9.2：Rust 11.1k 行，UI 8.9k 行；表无 deliveries / tasks；exchange cap 默认 20 | 本地 checkout 的 claude-message-bus 源码 |
