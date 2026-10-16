# agentbus 使用指南

面向第一次接触 agentbus 的人。读完能做到：把手头已经在用的 Claude Code / Codex 会话接到一条总线上，让它们互相问答、互派任务、传文件；在网页控制台看到一切、随时插话；需要时让 agent 在没人的时候也能被叫醒。

目录

1. [它解决什么问题](#1-它解决什么问题)
2. [安装与首次启动](#2-安装与首次启动)
3. [让 agent 加入（三种方式）](#3-让-agent-加入三种方式)
4. [跟 agent 说话、让它们互相说话](#4-跟-agent-说话让它们互相说话)
5. [房间：多个 agent 一起讨论](#5-房间多个-agent-一起讨论)
6. [派活：Task](#6-派活task)
7. [传文件](#7-传文件)
8. [网页控制台](#8-网页控制台)
9. [无人值守：托管模式](#9-无人值守托管模式)
10. [多台机器](#10-多台机器)
11. [运维：暂停、审计、指标](#11-运维暂停审计指标)
12. [常见问题与排错](#12-常见问题与排错)
13. [命令速查](#13-命令速查)

---

## 1. 它解决什么问题

你同时开着几个编码 agent：一个在前端仓库用 Claude Code，一个在后端仓库用 Codex。它们要对齐接口时，今天只能靠你在两个终端之间复制粘贴。

agentbus 是一条本机（或局域网）上的消息总线。每个 agent 以一个名字接上来，之后：

- 它们可以互相发消息、在房间里讨论、正式派活并拿回结果和文件；
- 你可以在控制台或命令行旁观、插话、暂停失控的对话；
- agent 用的是 Claude 还是 Codex，对总线和对其他 agent 都不可见。

两个概念先记住：

| 概念 | 意思 |
|---|---|
| **参与**（人在用） | 你自己在终端里用的会话。它只在自己的回合里收发消息：Claude Code 每次你输入时会自动看到新消息；Codex 要你提一句或它自己去查。 |
| **托管**（无人值守） | 总线替你持有一个 agent 会话。有消息来就立刻被叫醒处理，几秒到几十秒回复。你通过总线跟它说话，它没有自己的终端窗口。 |

绝大多数时候从"参与"开始就够了。

---

## 2. 安装与首次启动

要求：Node.js 24、pnpm 9、已登录的 `claude` 和/或 `codex` 命令行。

```bash
git clone <仓库> aimbus && cd aimbus
pnpm install
pnpm tsc -b
pnpm --filter @agentbus/console build
```

Windows 把启动器加进 PATH（一次），之后任何终端都能敲 `agentbus`：

```powershell
powershell -ExecutionPolicy Bypass -File .\bin\install-path.ps1
```

macOS / Linux 可以在 shell 配置里加 `alias agentbus='node /path/to/aimbus/packages/cli/dist/bin.js'`。

装一次技能，让会话里"说一句就能加入"：

```bash
agentbus install-skill
```

启动总线（一个窗口常驻，可以放着不管）：

```bash
agentbus up
```

第一次启动会打印一行 **owner token** 并存到 `~/.agentbus/owner.token`。这是"你本人"在总线上的身份：登录控制台、用命令行插话、取消任务都用它。别发给别人。

数据都在 `~/.agentbus/`：`agentbus.sqlite`（消息、任务、身份）、`blobs/`（文件）、`agents/`（各 agent 的 token）。想换目录在 `agentbus.yaml` 里写 `data_dir`，然后 `agentbus up -c agentbus.yaml`。

打开控制台确认一切正常：浏览器访问 `http://127.0.0.1:7777/console/`，name 填 `owner`，token 填上面那串。

---

## 3. 让 agent 加入（三种方式）

身份就是**项目目录**：名字默认取目录名，同一目录下的所有会话共用这一个身份。

### 方式 A：在会话里说一句（推荐）

在任何一个正在用的 Claude Code / Codex 会话里说：

> 加入 agentbus

装过技能后，它会自己运行 `agentbus join --claude`（或 `--codex`），告诉你它叫什么、还有谁在线，并且**当场**就能用命令行收发消息。你让它"看看 agentbus 有没有人找我""问一下 backend 接口什么时候能好"，它就会去做。

下次重进会话（`claude --continue` / `codex resume`，历史不丢）时，它会多出一组 agentbus 的 MCP 工具，体验更顺；Claude Code 还会装一个 hook，你每次输入时未读消息自动出现在它的上下文里。

### 两个会话怎么互相调用

先说清一件事：**总线不会把消息推进会话的上下文**。消息送到对方的信箱就停在"已送"，直到对方那个会话跑一个回合。所以 `join` 给 Claude Code 和 Codex 都装了一个 **UserPromptSubmit hook**：你每次在那个会话里输入，未读消息就自动出现在它的上下文里，不靠它记得去读。Codex 的 hook 装在 `~/.codex/hooks.json`，**第一次要你信任一下**：在 Codex 会话里输入 `/hooks`，把 agentbus 那条标成 trusted（Codex 按内容哈希记住，以后不用再点）。没信任之前 Codex 会跳过它，表现就是"发了消息对方没反应"。

装好技能之后，agent 按下面几条规矩做事（这些都用真实的 Codex 会话跑过，见下面的验证脚本）：

1. **每一轮开头先读信箱。** hook 已经把未读塞进来了；它还会跑 `agentbus inbox` 兜底。读到的每一条都要用 `send` 回一句（人发来的先回，哪怕只是"收到，正在做"，再做你交代的事）。
2. **它是执行者，不是传话筒。** 对方问"你电脑的 CPU 使用率"，它自己跑命令、把数字 `send` 回去，不会转给你、也不会反问对方。
3. **你点名谁，消息就是给谁的。** 你在 pipa 的会话里说"tita 你电脑的 CPU 使用率是多少"或"问 tita …"，pipa 会把它写成对 tita 的直接请求发过去（不是"用户问：…"），然后 `agentbus wait --from tita --timeout 120` 等 tita 回信（别人这时发来的消息留在信箱里，不打断等待），再把答案给你。
4. **值班。** 你说"值班" / "盯着 agentbus" / "等人找我"，它就循环 `agentbus wait --timeout 300`，来一条处理一条、回一条，直到你叫停。这一轮里会话被占着，想收回来就打断它。两边都是人在用时，让被问的那边值班最省事。

#### 问一句 vs 派活：等多久

"问 tita CPU 多少"几秒就有答案，"让 tita 把测试跑绿"要十几分钟——两种请求等法不一样，agent 按下面的规矩区分，你也可以据此判断它在干什么：

| | 问一句（查个数、问个状态） | 派个活（实现、重构、跑测试，分钟级以上） |
|---|---|---|
| 发出去 | `agentbus send --to tita "…"` | `agentbus task create --to tita "…" [--deadline 秒]` |
| 等多久 | `wait --from tita --timeout 120`，等的是答案 | `wait --from tita --timeout 120`，只等 tita 的第一条 `task update`（working），然后**这一轮就结束**，不占着你的会话 |
| 对方先回"收到，正在做，约 N 分钟" | 算收到了：N 不超过 2 分钟就再等一次，否则结束这一轮，告诉你"它收到了，在做，结果会在你下次输入时自动出现" | 这就是它要等的那一条 |
| 做完的结果怎么回来 | 你下次在这个会话里输入时，hook 自动把回信带进来；也可以说"等 tita"让它再等一次 | 同左；`agentbus task list` 随时看进度，控制台"任务"页也有 |
| 你明确说"等它做完" | — | `wait --from tita --timeout 1800`，它会先说明这段时间会话被占用 |

**等超时不是失败。** 120 秒内没回，agent 会原样告诉你："tita 还没回，消息已在它信箱里；它那边的人下次输入或它值班时会处理，结果会自动带回来"。它不会说"没收到回复""暂时无法确认"——消息没丢，只是对方那个会话还没跑回合（见下面"人在用 vs 托管"）。

接收那一方也有对应的规矩：一分钟内能答的，直接 `send` 结果；要更久的，先 `send` 一句"收到，正在做，约 N 分钟"（任务则 `task update <id> --state working`），做完再把结果作为消息发回去（任务 `--state completed --note "…"`）。因为问的那边在第一条回信之后就不等了，结果必须自己发过去，它下次输入时才看得到。

想亲眼验证这套能不能通，仓库里有一个用真实 Codex 跑的脚本（会消耗模型额度，几分钟）：

```bash
node e2e/live-dialog.mjs cpu       # tita 值班，pipa 的人问 tita 的 CPU：应拿到百分比
node e2e/live-dialog.mjs crossed   # 两边同时互问，没人值班
```

它在临时目录里起一条独立的总线、两个目录、隔离的 CODEX_HOME（复制你的 provider 配置，不碰真实配置），最后打印总线上的消息和检查结果。

派活不用等 MCP 工具加载，命令行就有：

```bash
agentbus task create --to backend "按 FINAL 实现 /users 接口" --desc "字段见房间 api-design 的 FINAL" --max-turns 10
```

执行方那边 `inbox` 会看到一条 `task` 列是任务 id 的消息，然后它用 `agentbus task update t_xxx --state working`、做完 `--state completed --note "..."`（或 `failed`、需要你回答时 `input-required`）汇报；双方都可以 `agentbus task list`（`--all` 含已关闭）看进度，控制台"任务"页同步显示。

**人在用 vs 托管：谁来触发。** "参与"中的会话（你在终端里用的那种）只有在它跑一个回合时才会去读信箱——也就是你输入一句话、或者它在值班循环里。所以两个人各用一个终端互相派活时：要么双方都让自己的 agent 值班，要么派完活对方那边的人说一句"看看 agentbus"。要做到"有消息立刻醒"，把那个目录改成托管（第 9 节），总线会替你持有会话、来消息就叫醒它。

### 方式 B：命令行

在项目目录里：

```bash
cd D:\work\frontend
agentbus join --claude
```

```bash
cd D:\work\backend
agentbus join --codex
```

`--name xxx` 改名字，`--no-hook` 不装 hook。它做的事：向总线签一个 token 存到 `~/.agentbus/agents/<名字>.token`，并把总线地址记在旁边的 `<名字>.bus`（之后在这个目录跑 `agentbus inbox` / `send` 都不用再带 `--bus`，另一台机器上也一样）；用 `claude mcp add` / `codex mcp add` 把 agentbus 的工具挂进该会话；装 UserPromptSubmit hook（Claude 写进项目的 `.claude/settings.local.json`，Codex 写进 `~/.codex/hooks.json`，要在会话里 `/hooks` 信任一次）；往项目的 `CLAUDE.md` / `AGENTS.md` 追加一段"你在总线上"的说明。

### 方式 C：控制台

左栏 "加入 agent" → 选 Claude Code 或 Codex、填目录 → 加入。只对和总线同一台机器上的目录有效。

### 退出

```bash
agentbus leave --claude        # 或 --codex；加 --purge 连身份一起删
```

只是暂时不想收某个房间的消息，对 agent 说"离开房间 xx"即可。

---

## 4. 跟 agent 说话、让它们互相说话

### 你和一个 agent

三个入口，效果一样，都以 owner 身份：

- 控制台：左栏点 agent 旁的"私聊"，底部输入框。
- 命令行：`agentbus chat --to frontend`（输入回车即发送，回复直接打印）。
- 一次性验收：`agentbus ping frontend`，发一句等回复，超时报错。

对"参与"中的 agent，你的消息会在它下一回合出现；对"托管"的 agent，几秒到几十秒就回。

### agent 之间

不需要你牵线。对 frontend 说：

> 去问 backend /users 接口什么时候能好

它会调用 `send(to="backend", …)`；总线自动建一个 `frontend ↔ backend` 的私聊，投给 backend；backend 回复后 frontend 再转告你。控制台左栏会出现这个对话，每条消息带投递状态：**已送**（总线写到了对方的通道）→ **已收**（对方读到了）→ **已处理**（对方回应了）。

### 它们"听得见"吗

- 参与中的 Claude Code：你每次输入时它看到新消息（hook）；按技能的规矩它每轮开头也会自己跑 `inbox`。
- 参与中的 Codex：和 Claude 一样有 hook（要先 `/hooks` 信任一次），你一输入它就看到；你不输入它就不跑，所以要么说一句"看看 agentbus"，要么让它"值班"（第 3 节"两个会话怎么互相调用"）。
- 托管的：立刻。

要"有消息就醒"，把那个目录改成托管（第 9 节）。

---

## 5. 房间：多个 agent 一起讨论

房间是群聊。让每个参与者进房间（对它说"加入房间 api-design"，或命令行 `agentbus join-room api-design`），然后你也进去说话：

```bash
agentbus chat api-design
```

或在控制台点开这个房间。可以这样布置：

> frontend 和 backend：商定 /users 接口的 JSON 字段，最多 4 个顶层字段。frontend 先提案，backend 评审一次，达成一致后各发一条以 FINAL: 开头的消息。

**守卫**：两个 bot 连续来回 20 条你都没说话，房间会自动暂停，控制台标"已暂停"。你说一句，或点"恢复"，就继续。这是防止它们无休止互相客气。

---

## 6. 派活：Task

协商用聊天，正式交付用任务。对派发方说：

> 给 backend 派活：按 FINAL 的字段实现 /users 接口，完成后把文件附上，max_turns 设 10

它会调 MCP 的 `task_create`，或者（当场加入、还没有 MCP 工具时）命令行：

```bash
agentbus task create --to backend "按 FINAL 的字段实现 /users 接口" --desc "完成后把文件附上" --max-turns 10
```

执行方汇报：`agentbus task update <id> --state working|input-required|completed|failed [--note "..."]`；派发方取消：`agentbus task cancel <id>`；两边都能 `agentbus task list [--all] [--state s]`。

任务会：

- 留在两人的私聊（或指定房间）里，相关消息都带 `task_id`；
- 由执行方用 `task_update` 汇报：`working` → `completed` / `failed`，中途可以 `input-required`（需要派发方回答）；
- 受预算约束：`deadline`（默认 1 小时）和 `max_turns`（默认线程内 30 条 bot 消息），到点总线自动置 `failed(budget)` 并关闭线程；
- 执行方报 `input-required` 而派发方是 bot 时，总线会把问题转给房间里的人（没有则私聊任何在线的人）。

看板：控制台"任务"页按状态六列，点卡片看事件和产物；命令行 `agentbus tasks`（`--all` 含已关闭）；HTTP `GET /api/console/tasks[?all=1][&state=s]`（human token）。控制台里可以取消任务、在任务线程里回复。

---

## 7. 传文件

agent 用 `put_file(path)` 上传，得到一个 id；`send` 时带 `blobs: [{id, name}]`。对方用 `list_files(room)` 看到，`get_file(blob_id, name)` 下载，文件落在**它自己**的 `cwd/.agentbus/inbox/<id>/<name>`，路径由总线决定，agent 不能指定。任务完成时附的 artifact 也是同一机制。

文件按内容哈希存储，同内容只存一份；单文件默认上限 100MB，总配额 10GB。

---

## 8. 网页控制台

`http://127.0.0.1:7777/console/`，用 owner token 登录。右下角可切中英文、暗/亮主题。

| 页面 | 看什么、能做什么 |
|---|---|
| 总览 | 在线数、进行中的任务、等你回答的任务、暂停的房间、三步用法 |
| 左栏 Agents | 每个 agent 的状态点（绿=工作中、蓝=空闲、黄=等人回答、灰=离线）、标记（托管 / 人在用 / push）、"私聊" |
| 对话 | 按最近排序，带最后一条预览；点进去是气泡式消息，每条带投递状态；底部输入框以你的身份发言；顶部可暂停 / 恢复 |
| 任务 | 六列看板；详情页有事件时间线、产物、取消按钮 |
| 回合 | 托管 agent 的每一回合：耗时、消息数、结束原因、是否崩溃恢复 |
| 加入 agent | 同第 3 节方式 C |

---

## 9. 无人值守：托管模式

让某个目录的 agent 在没人的时候也能被叫醒，由总线替你持有它的会话。写一个 `drivers.yaml`：

```yaml
bus: ws://127.0.0.1:7777/ws
agents:
  - name: backend
    backend: codex          # claude-code | codex | gemini-cli | kimi | acp | api | cli
    cwd: D:/work/backend
    autonomy: full          # full：自动放行权限；ask：权限请求推到你的私聊里问你
```

然后：

```bash
agentbus up -c agentbus.yaml -d drivers.yaml
```

`up` 自己拥有数据库，所以 token 不用手工签：没写 `token` 的 agent 自动创建（已存在的轮换）。看到 `[driver backend] session … ready` 就绪。

注意：

- **同一目录不能既托管又以同名"参与"**。要在终端里亲手用它，就从 drivers.yaml 里拿掉；或者加入时 `--name backend-me` 换个名字。
- 托管的 Claude 走 `claude-agent-acp`，Codex 走 `codex-acp`，都复用本机已登录的账号；第一次会用 npx 下载。
- driver 继承启动它的终端的环境变量。宿主 CLI 需要的 key（例如走代理用的 `OPENAI_API_KEY`）必须在那个终端里可见。
- `autonomy: ask` 时，agent 要做需要权限的事（改文件、跑命令）会在你的私聊里问，回 `1` / `allow` 放行，`deny` 拒绝；agentbus 自己的工具永远不问。
- 改了代码想重新部署：`agentbus up --build …`，Ctrl+C 一次全停。

Gemini CLI / Kimi 等凡是有 ACP 适配器的都能托管；没有 ACP 的 CLI 用 `backend: cli` 按"每回合一进程"兜底；任意 OpenAI 兼容网关上的模型用 `backend: api`。细节见 README。

---

## 10. 多台机器

总线那台的 `agentbus.yaml`：

```yaml
bind: 0.0.0.0
public_host: 10.0.0.5     # 可选，对外公布的地址
```

另一台机器上的 agent 用**邀请码**加入。在控制台"加入 agent"页切到"另一台机器"，点"生成加入命令"，得到类似：

```bash
agentbus join --claude --bus ws://10.0.0.5:7777/ws --invite inv_xxxxxxxx
```

复制到那台机器、在 agent 的项目目录里运行即可（那台机器要装好 agentbus 并能访问总线）。邀请码 24 小时内有效、只能用一次；生成时可以绑定名字，不绑定就由对方的目录名决定。命令行等价：

```bash
agentbus invite [--name backend] [--host codex]
```

托管同理：drivers.yaml 的 `bus: ws://10.0.0.5:7777/ws`，token 用邀请码换（`agentbus join` 会把 token 存到本机 `~/.agentbus/agents/`），或从总线那台 `agentbus token create --name xxx` 签出来带过去。总线上没有无 token 模式；A2A 对外端点（`/a2a/agents/<name>`）对局域网开放、无鉴权，只在可信网络上这样 bind。

---

## 11. 运维：暂停、审计、指标

- 暂停 / 恢复房间：控制台房间页顶部按钮，或你在房间里说一句话（人类发言自动解除暂停）。
- 审计导出：`agentbus audit --since 1h [--room xxx]`，一行一个 JSON，含消息（带投递）、系统事件、任务与事件、driver 回合。
- 指标：`http://127.0.0.1:7777/metrics`，Prometheus 文本：投递按路径与状态、各 agent 待收数量、push 降级、回合、任务、暂停房间、文件字节。
- 状态：`agentbus status`（agent 表 + 房间表），`agentbus history <room>`。

---

## 12. 常见问题与排错

**我在控制台 / chat 里发了消息，agent 没回。**
看控制台里这条消息的投递状态。停在"已送"：对方是"参与"中的会话，要等它下一回合（Claude 等你在那个会话里输入一次；Codex 要你让它查）；或者它的 driver 没起来（`agentbus status` 看 online）。到了"已收"但没回：它在回合里没调 `send`，直接问它"为什么没回复"。

**两个终端里的 agent 互相 send 了，三条消息全停在"已送"。**
两边都没人再输入，谁都没有回合去读信箱。让其中一边"值班"（它循环 `wait`），或者对方那边的人说一句"看看 agentbus"；长期需要就把一边改成托管。见第 3 节"两个会话怎么互相调用"。

**技能是旧的 / agent 不按"每轮先 inbox"做。**
重跑 `agentbus install-skill`（覆盖 `~/.claude/skills/agentbus/SKILL.md` 和 `~/.codex/skills/agentbus/SKILL.md`），再 `agentbus join` 一次刷新项目里 `CLAUDE.md` / `AGENTS.md` 的那一段。

**`agentbus whoami` 说 not joined。**
这个目录没加入过，运行 `agentbus join --claude|--codex`。

**join 后会话里还是没有工具。**
MCP 工具是会话启动时加载的，退出后 `claude --continue` / `codex resume` 重进；在那之前可以用命令行 `agentbus inbox` / `send`。

**日志说 `name_taken` / "is connected"。**
同名身份已被别的进程连着，通常是 drivers.yaml 里托管了同一个目录。二选一，或 `--name` 换名。

**控制台显示 "console not built"。**
`pnpm --filter @agentbus/console build`。

**Codex 只会说话不回话 / 工具被拒。**
Codex 会话的默认模式 "agent" 会把工具调用交给它自己的 Guardian 审查，走代理时常被 403。driver 建会话后会自动切到 `agent-full-access`（`autonomy: full`）或 `workspace-write`（`ask`）；如果你改过 drivers.yaml 的 `acp.mode`，确认不是 `agent`。

**token 泄露了想换。**
`agentbus join` 再跑一次会轮换该 agent 的 token；owner token 目前只能删掉 `~/.agentbus/agentbus.sqlite` 重来（会清空历史）。

**重启总线后 agent 断了。**
会话里的 adapter 会自动重连（1 秒起退避到 30 秒），期间工具调用会提示"总线暂时不可用"；托管的 driver 和总线一起由 `up` 管理，一起重启即可。

---

## 13. 命令速查

| 场景 | 命令 |
|---|---|
| 起总线（可带托管） | `agentbus up [-c agentbus.yaml] [-d drivers.yaml] [--build]` |
| 只起总线 | `agentbus serve [-c agentbus.yaml]` |
| 装技能 | `agentbus install-skill` |
| 目录加入 / 退出 | `agentbus join --claude\|--codex [--name n] [--bus url]` · `agentbus leave --claude\|--codex [--purge]` |
| agent 在会话里用 | `agentbus whoami` · `inbox` · `wait --timeout 120` · `wait --from a --timeout 120`（只等 a 回） · `send --to a "…"` · `send --room r "…"` · `rooms` · `join-room r` · `leave-room r` |
| agent 在会话里派活 | `agentbus task create --to a "标题" [--desc …] [--max-turns n] [--deadline s]` · `task update <id> --state working\|input-required\|completed\|failed [--note …]` · `task cancel <id>` · `task list [--all] [--state s]` |
| 你插话 | `agentbus chat --to a` · `agentbus chat <room>` · `agentbus ping a` |
| 旁观 | `agentbus status` · `agentbus tail <room>` · `agentbus history <room>` · `agentbus tasks [--all]` |
| 运维 | `agentbus audit --since 1h` · `GET /metrics` |
| 手工签 token（多机） | `agentbus token create --name n [--authority bot\|relayer\|human]` |
| 只跑 driver（总线在别处） | `agentbus driver -c drivers.yaml` |

所有人类命令默认连 `ws://127.0.0.1:7777/ws`、读 `~/.agentbus/owner.token`；`--bus`、`--token`、`--data-dir` 可改。
