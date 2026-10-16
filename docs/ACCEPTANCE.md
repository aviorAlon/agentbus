# 验收手册：怎么证明 agentbus 做到了设计里说的事

两层验证。第一层是自动化测试，证明代码按设计行为；第二层是真机场景，证明接上真实的 Claude / Codex 后产品立场成立。每个场景都写明"做什么、应看到什么、对应设计哪一条"。设计条目编号见 `PRODUCT_DESIGN.md` §2（F-xx）与 §8。

## 第一层：自动化（5 分钟）

```bash
pnpm test
```

27 个文件、95 个用例，全部用无模型的假 ACP agent / 假 CLI / 假 OpenAI 服务，不花 token。覆盖：

| 文件 | 证明的事 |
|---|---|
| `packages/core/src/bus/bus.test.ts` | 注册与 token、同名接管、dm/房间成员规则、投递三态、wait、守卫暂停与人类解除、限速、TTL |
| `packages/core/src/bus/tasks.test.ts` | Task 转换校验、预算（max_turns / deadline）、input-required 升级、取消权限、任务线程免守卫 |
| `packages/core/src/bus/multi-control.test.ts` | 人可以开多个窗口，bot 只能一个 |
| `packages/core/src/ws/http.test.ts`、`static.test.ts` | participants HTTP、blob 内容寻址与配额、控制台静态页 |
| `packages/core/src/store/presence.test.ts` | presence 合成规则 |
| `packages/a2a/src/*.test.ts` | A2A 1.0 映射；官方 client 走 SendMessage / GetTask / CancelTask |
| `e2e/driver.test.ts` | 人类唤醒 driver、双 bot 互聊到守卫暂停、后端崩溃恢复 |
| `e2e/m1.test.ts` | wait_for_message 分段、ask 权限推给人并回传、文件 put/get、hook、HTTP 参与者 |
| `e2e/m2.test.ts` | review→fixer 派活完成带 artifact、deadline 到点 failed、控制台快照与流 |
| `e2e/m3.test.ts` | 总线绑 0.0.0.0、两个 driver 进程经局域网 IP 接入、外部 A2A client 派活拿 artifact、mailbox 上限 |
| `e2e/m4.test.ts` | push 声明/通知/降级、ApiBackend、CliBackend、控制台动作、/metrics、audit |
| `e2e/up.test.ts`、`cli.test.ts` | `up` 自动签 token、`ping`、`serve`/`token`/`status` |

全绿即"代码符合设计"。下面才是"产品是否成立"。

## 第二层：真机场景（按便宜到贵排序）

前置：一个窗口 `agentbus up --build -c agentbus.yaml -d drivers.yaml`，看到 `[up] ready`。另开一个窗口做下面的事。浏览器开着 `http://127.0.0.1:7777/console/`。

### 场景 1 · 总线就是 driver agent 的终端（§4.6，G2 G3）

```bash
agentbus ping alpha
```

应看到：`sent → driver/written`，几秒到几十秒后 `alpha replied in N.Ns: ...`。控制台 agents 面板里 alpha 的状态点在回合中变 working，结束变 idle；房间 `dm:alpha|owner` 里两条消息，第一条的投递徽章从 written 变 seen 再变 handled。

证明：没有终端、没有 push，空闲的 agent 被总线叫醒并回话；投递三态真实反映了"写到、收到、处理了"。

### 场景 2 · 人的权威与权限请求（F-D10，§4.6）

alpha 配 `autonomy: ask`。

```bash
agentbus chat --to alpha
```

让它做一件需要权限的事，比如"在你的工作目录新建 hello.txt 写一句话"。应看到 dm 里出现 `[permission request perm-1] ...`，列出选项；回 `1` 或 `allow`，它继续并完成；回 `deny` 它会告诉你没做。控制台里这段时间 alpha 状态是 blocked。

证明：被托管 agent 的权限请求推到了人手里，人通过总线放行或拒绝。

### 场景 3 · 两个 agent 协商 + 守卫（§4.4，G1）

两个窗口分别 `chat --to alpha`、`chat --to gamma`，都说："调用 agentbus 的 join 工具加入房间 negotiate"。然后：

```bash
agentbus chat negotiate
```

输入："alpha 和 gamma：商定 /users 接口的 JSON 字段，最多 4 个顶层字段，alpha 先提案，gamma 评审一次，达成一致后各发一条 FINAL: 开头的消息。"

应看到：两边交替发言，几轮内各发 FINAL。然后换个故意无穷的题："alpha 和 gamma 轮流互相说谢谢，不要停。" 应看到第 20 条 bot 消息后房间暂停（控制台房间名旁出现 paused 徽章，chat 里收到系统消息），你在房间说一句话就恢复。

证明：跨 agent 协商成立（Codex 恢复后就是跨后端）；守卫能截住失控对话，人类发言是唯一解除条件。

### 场景 4 · 正式派活与预算（§4.5，F-T1–F-T5）

在 `chat --to alpha` 里说："用 task_create 给 gamma 派活：按 negotiate 房间里 FINAL 的字段，在你的工作目录写一个 users.json 示例，完成后用 put_file 上传并作为 artifact 附上，max_turns 设 10。"

应看到：`agentbus tasks` 里出现 submitted → working → completed；控制台任务看板卡片从左向右移动，详情页有 events 和 artifact 文件；alpha 能用 `list_files` 看到并 `get_file` 拿到。再派一个 `deadline_s: 60` 的任务给一个不存在工作的 agent（或先停掉它的 driver），一分钟后看板里它变 failed，summary 写 `budget: deadline passed`。

证明：Task 是带状态机的消息线程，总线校验转换并执行预算。

### 场景 5 · 人在用的交互式 Claude Code（inbox 模式，F-A5 F-A6）

在某个项目的 `.mcp.json` 挂 adapter（name 用 `beta`，先 `agentbus token create --name beta`），打开 Claude Code。另一个窗口 `agentbus chat --to beta` 发一句话。在 Claude Code 里让它"调 inbox 看看有没有人找我"，它应复述你的话并用 send 回复；chat 窗口收到。再让它"用 wait_for_message 等 30 秒"，期间你发一句，它应立刻醒来。装了 UserPromptSubmit hook 后，你每次在 Claude Code 输入，未读消息自动出现在它的上下文里。

证明：不托管的交互式会话也能参与，靠回合边界拉取与显式等待，不靠 push。

### 场景 6 · 多窗口、控制台动作、审计（F-H4 F-H5 F-O3 F-O4）

同时开 `chat`、`tail negotiate`、`tasks` 三个窗口，都应正常。控制台里对某房间点 pause，chat 里 bot 再发言会被拒；点 resume 恢复。任务详情点 cancel task，看板移到 canceled。然后：

```bash
agentbus audit --since 1h --room negotiate
```

应是一行一个 JSON，`record` 字段有 message / event / task / task_event。`curl http://127.0.0.1:7777/metrics` 能看到 `agentbus_deliveries_total`、`agentbus_events_total{kind="paused"}` 等计数。

### 场景 7 · 外部 A2A agent 派活（F-X3，G5）

```bash
curl http://127.0.0.1:7777/.well-known/agentbus-agents.json
```

用任何 A2A 1.0 client（`@a2a-js/sdk` 的 `ClientFactory.createFromUrl`，或 `e2e/m3.test.ts` 里的写法）对 `/a2a/agents/gamma` 发 `SendMessage`，应拿到 state=SUBMITTED 的 Task；`GetTask` 轮询到 COMPLETED，artifacts 里是可下载的 blob URL（下载需要 bus token）。

### 场景 7b · 两个人在用的会话互相调用（真实 Codex，自动）

```bash
node e2e/live-dialog.mjs cpu
node e2e/live-dialog.mjs crossed
```

隔离环境（独立总线、临时 CODEX_HOME、两个目录 pipa / tita），用真实 `codex exec` 跑：`cpu` 是 tita 值班、pipa 的人问 tita 的 CPU 使用率，应在总线上看到 tita 回的百分比、pipa 的最终回答里有这个数字；`crossed` 是两边同时互问、没人值班，应双方都在总线上回了数字，且没有"用户问："式的转述。脚本最后打印 PASS/FAIL；`--keep` 保留临时目录看 `*.out` 全文。

### 场景 8 · 多机（G6）

`agentbus.yaml` 改 `bind: 0.0.0.0`，另一台机器上 `agentbus driver -c drivers.yaml`，其中 `bus: ws://<这台IP>:7777/ws`，agent 的 token 用这台 `token create` 签出来后带过去。那台机器上的 agent 应出现在 `agentbus status` 里 online，`ping` 能回。

## 还没验证、需要等条件的

- Codex 路径：codex-acp 初始化正常，但当前账号配额用尽（10 月 21 日后重置）。恢复后先 `agentbus ping gamma`。
- push（Claude Code channels）：需要 `--dangerously-load-development-channels server:agentbus` 启动 Claude Code，adapter 加 `--push`。自动化只验到"通知发出 + 超时降级"，没在真实会话里看过它被注入。
- Gemini CLI / Kimi：本机未安装。
