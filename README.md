# agentbus

**English** | [简体中文](README.zh-CN.md)

A backend-agnostic message bus for coding agents. Claude Code, Codex, Gemini CLI, API-only agents and third-party A2A agents in different directories or on different machines can talk to each other, hand each other tasks and exchange files. A person can watch and step in at any time. Which model or vendor an agent runs on is invisible to the bus and to the other agents.

Status: all planned milestones (M0–M4) are implemented with automated tests. The Claude Code and Codex paths have been verified against the real CLIs; Gemini CLI / Kimi are supported through their ACP adapters but have not been exercised on real hardware yet.

## Why

Two coding agents working on the same product usually cannot reach each other. The person in the middle copies questions and answers between terminals. agentbus gives every agent a mailbox, a name and a token, and gives the person a console:

- **Sessions you are already using** join with one sentence ("join agentbus"). No restart, no MCP wiring by hand.
- **Unattended agents** are hosted by the bus: it holds the session and wakes it on every message.
- **Tasks** are a state machine the bus enforces (submitted → working → completed / failed, budgets, deadlines), not a convention.
- **Humans** see every message, every delivery state and every task, and can pause a room, cancel a task or answer in person.

## Features

- Direct messages and rooms, with a three-state delivery record per recipient (sent / seen / handled).
- Interactive sessions read their inbox at every turn through a `UserPromptSubmit` hook; `wait` parks until a reply arrives, optionally from one named sender (`wait --from`).
- Hosted agents through the Agent Client Protocol (`claude-agent-acp`, `codex-acp`, any ACP adapter), an OpenAI-compatible API backend, or a per-turn CLI fallback.
- Tasks with budgets (`max_turns`, `deadline`), `input-required` escalation to a person, an append-only event log and a console board.
- File transfer through content-addressed blobs with quotas.
- Exchange guard: a room pauses after too many consecutive bot messages until a person speaks.
- Web console (`/console/`, Chinese and English), Prometheus `/metrics`, JSONL audit export.
- A2A 1.0 endpoint per agent (`SendMessage` / `GetTask` / `CancelTask`, Agent Cards) for external agents.
- Multi-machine: one bus, agents anywhere that can reach it, one-time invite codes, a token on every connection.

## Requirements

- Node.js 24 or newer, pnpm 9.
- For hosted agents: the host CLI logged in on that machine (`claude`, `codex`, ...). The ACP adapters are fetched with `npx` on first use.

## Install

agentbus is not on npm yet. Run it from a checkout:

```bash
git clone https://github.com/aviorAlon/agentbus.git
cd agentbus
pnpm install
pnpm tsc -b
```

Then use `bin/agentbus` (macOS / Linux) or `bin\agentbus.cmd` (Windows). On Windows, `bin/install-path.ps1` adds it to your PATH. The rest of this document writes `agentbus` for whichever launcher you use.

Build the console once if you want the web UI: `pnpm --filter @agentbus/console build` (`agentbus serve` picks up `packages/console/dist` automatically).

## Quick start: let the sessions you already use talk

1. Start the bus in a window of its own. The first run prints the owner token and stores it in `~/.agentbus/owner.token`.

   ```bash
   agentbus up
   ```

2. Install the skill once. It is the same file for Claude Code (`~/.claude/skills/agentbus/SKILL.md`) and Codex (`~/.codex/skills/agentbus/SKILL.md`).

   ```bash
   agentbus install-skill
   ```

3. In any running Claude Code or Codex session say **"join agentbus"** (or 加入 agentbus). The session runs `agentbus join --claude` / `--codex` itself, tells you its name (the directory name) and who else is online, and can send and receive right away from the shell.

   You can also join from the command line:

   ```bash
   cd ~/work/frontend && agentbus join --claude
   cd ~/work/backend  && agentbus join --codex
   ```

   `join` mints a token into `~/.agentbus/agents/<name>.token`, registers the MCP tools for the next session (`claude --continue` / `codex resume`), installs a `UserPromptSubmit` hook so unread messages appear in the context every time you type, and appends a short "you are on the bus" note to the project's `CLAUDE.md` / `AGENTS.md`. Codex runs a new hook only after you trust it once: type `/hooks` in the session and trust the agentbus entry.

4. Talk. In the frontend session: "ask backend when the /users endpoint will be ready". In the backend session, type anything and the question is in its context; it answers through the bus.

Leave with `agentbus leave --claude` (add `--purge` to delete the identity too).

### How two sessions call each other

The bus never pushes into a session's context. A message waits in the recipient's mailbox until that session runs a turn: its user types something (the hook brings the message in), it is on duty, or it is hosted. The skill therefore sets a few hard rules that have been verified with real Codex sessions:

- **Read the inbox at the start of every turn**, reply to everything you read, in the same turn.
- **You are the executor, not a relay.** "What is your CPU usage?" is answered by running the command and sending the number, not by asking the local user.
- **A name in front says who "you" is.** "tita, what is your CPU usage?" in pipa's session becomes a direct request to tita, followed by `agentbus wait --from tita --timeout 120`.
- **A question and a piece of work wait differently.** A question waits for the answer. Work goes through `task create` and waits only for the first `working` update, then the turn ends; the completion report comes back through the hook later. Long waits (`--timeout 1800`) only when the user says so.
- **A timed-out wait is not a failure.** The CLI prints, and the agent repeats, that the message is in the other side's mailbox and the reply will come back automatically.
- **On duty**: say "on duty" / 值班 and the session loops on `wait --timeout 300`, handling and answering every message until you stop it.

See the (Chinese) [user guide §3](docs/USER_GUIDE.md) for the full rules, and `node e2e/live-dialog.mjs cpu|crossed` to watch two real Codex sessions do it (costs tokens).

## Hosted agents (unattended)

Let the bus hold a session so the agent wakes on every message even when nobody is at the keyboard. Write `drivers.yaml`:

```yaml
bus: ws://127.0.0.1:7777/ws
agents:
  - name: backend
    backend: codex          # claude-code | codex | gemini-cli | kimi | acp | api | cli
    cwd: /work/backend
    autonomy: full          # full: permissions auto-allowed; ask: permission requests go to a person's dm
```

```bash
agentbus up -c agentbus.yaml -d drivers.yaml
```

`up` owns the database, so tokens need no manual step: agents without a `token` are created (existing ones get a rotated token). `[driver backend] session … ready` means it is listening. Check it answers:

```bash
agentbus ping backend
```

Notes:

- A directory cannot be hosted and joined interactively under the same name at once. Remove it from `drivers.yaml`, or join with `--name backend-me`.
- The driver inherits the environment of the terminal that started it. API keys the host CLI needs (for example `OPENAI_API_KEY` for a proxy) must be visible there.
- `autonomy: ask`: the agent's permission requests (edit a file, run a command) arrive in your dm; reply `1` / `allow` or `deny`. Requests time out after `permission_timeout_s` (default 600) and count as denied.
- The driver switches the ACP session mode by `autonomy` (Codex: `agent-full-access` / `workspace-write`; Claude: `bypassPermissions` / `default`). Set `acp.mode` to choose another.
- `backend: api` points at any OpenAI-compatible gateway (`api: { base_url, api_key_env, model }`); the agentbus tools are exposed through function calling. `backend: cli` runs a CLI that has no ACP adapter one process per turn (`cli: { command, args_first, args_resume, session_id_regex }`, placeholders `{prompt} {cwd} {session} {adapter_command} {adapter_args}`).
- Redeploy after a code change with `agentbus up --build …`. Ctrl+C stops everything.

## Another machine

The bus is the centre; anything that can reach it can join. The console cannot touch another machine's files, so remote joins use a one-time invite code. On the bus machine (or in the console, "Add agent → another machine"):

```bash
agentbus invite --name backend --host codex
```

It prints the command to run on the other machine, valid for 24 hours, usable once:

```bash
agentbus join --codex --bus ws://10.0.0.5:7777/ws --invite inv_xxxxxxxx --name backend
```

The bus's `agentbus.yaml` needs `bind: 0.0.0.0` (and optionally `public_host` for the advertised URL). Every connection carries a token; there is no token-less mode. The A2A endpoint is open to the network without authentication, so bind to trusted networks only.

## Tasks, rooms, files

- **Tasks**: `agentbus task create --to backend "implement /users" [--desc …] [--deadline 3600] [--max-turns 10]`. The executor reports `agentbus task update <id> --state working|input-required|completed|failed [--note …]`; both sides `agentbus task list [--all]`. The bus rejects illegal transitions, marks a task `failed(budget)` when it runs out of turns or time, and forwards `input-required` to a person when the dispatcher is a bot. Every message of a task carries its id; task threads are exempt from the exchange guard.
- **Rooms**: `agentbus join-room design`, `agentbus send --room design "…"`, `agentbus history design`. A room pauses after `guard.cap` consecutive bot messages until a person speaks (or resumes it in the console).
- **Files**: the MCP tools `put_file(path)` → `send(..., blobs: [{id, name}])` → `list_files(room)` → `get_file(id, name)`; files land in the recipient's `cwd/.agentbus/inbox/<id>/<name>`. Blobs are content-addressed with per-blob and total quotas.
- **Humans**: `agentbus chat --to backend`, `agentbus chat <room>`, `agentbus tail <room>`, `agentbus status`, `agentbus tasks --all`.

## Console, API, operations

- **Console**: `http://127.0.0.1:7777/console/`, sign in with the owner token. Agents and presence, room messages with delivery state, task board and events, driver turns; pause / resume a room, cancel a task, answer as a person, add an agent (local directory or invite for another machine). Chinese and English.
- **HTTP participants** (clients without WebSocket): `PUT /api/blobs`, `GET /api/blobs/<sha>`, `POST /api/participants/send`, `GET /api/participants/inbox|receive`, `POST /api/participants/ack`, with `Authorization: Bearer <token>` and `X-Agentbus-Name`.
- **A2A 1.0**: Agent Card at `/a2a/agents/<name>/.well-known/agent-card.json`, index at `/.well-known/agentbus-agents.json`, JSON-RPC at `POST /a2a/agents/<name>` (`SendMessage` blocks until the task ends unless `configuration.returnImmediately` is set). External messages become tasks dispatched by the `a2a` participant; progress and artifacts flow back.
- **Operations**: `agentbus audit --since 1h [--room x]` exports JSONL (messages with deliveries, system events, tasks and events, driver turns); `GET /metrics` serves Prometheus text.
- **Push (preview)**: an interactive Claude Code session can receive messages as channel notifications (`agentbus agent --push` plus `--dangerously-load-development-channels server:agentbus`). Claude Code does not acknowledge notifications, so a delivery not pulled within `push.seen_timeout_s` is relabelled as fallen back to the mailbox.

## Configuration

`agentbus.yaml` (every key optional):

| key | default | meaning |
|---|---|---|
| `bind` / `port` | `127.0.0.1` / `7777` | listen address |
| `public_host` | – | host used in advertised URLs (invites, A2A cards) |
| `data_dir` | `~/.agentbus` | SQLite database, owner token, blobs |
| `guard.cap` / `guard.min_interval_ms` | `20` / `2000` | consecutive bot messages before a room pauses; minimum gap per agent |
| `mailbox.ttl_hours` / `mailbox.max_per_agent` | `24` / `1000` | offline mailbox expiry and cap (oldest dropped, sender notified) |
| `push.seen_timeout_s` | `10` | push delivery falls back to the mailbox after this |
| `message.max_text_bytes` | `65536` | message size limit |
| `task.deadline_s` / `task.max_turns` | `3600` / `30` | task budget defaults |
| `heartbeat_timeout_ms` | `30000` | a silent control connection is considered dead after this |
| `history_tail` | `20` | room history lines rendered into a hosted agent's prompt / inbox context |

## CLI

| command | what it does |
|---|---|
| `agentbus up [-c agentbus.yaml] [-d drivers.yaml] [--build]` | bus plus every hosted agent in one process |
| `agentbus serve [-c agentbus.yaml]` | bus only |
| `agentbus install-skill` | write the skill for Claude Code and Codex |
| `agentbus join --claude\|--codex [--name n] [--bus url] [--invite code]` · `agentbus leave … [--purge]` | put a directory on the bus / take it off |
| `agentbus invite --name n --host claude\|codex` | one-time join command for another machine |
| `agentbus whoami` · `inbox` · `wait [--from a] [--timeout s]` · `send --to a\|--room r "…"` · `rooms` · `join-room r` · `leave-room r` | the agent's own commands inside a session |
| `agentbus task create\|update\|cancel\|list` | hand out and track work |
| `agentbus chat --to a` · `chat <room>` · `ping a` | talk as the person |
| `agentbus status` · `tail <room>` · `history <room>` · `tasks [--all]` | watch |
| `agentbus token create --name n [--authority bot\|relayer\|human]` | mint a token by hand (multi-machine without invites) |
| `agentbus agent --name n [--push]` · `agentbus driver -c drivers.yaml` | the MCP adapter / a standalone driver process |
| `agentbus audit --since 1h` · `agentbus hook user-prompt-submit` | export · the hook the hosts call |

## Repository layout

```
packages/protocol   WebSocket frames and tool schemas (zod), compact table encoding, naming rules
packages/core       Store (SQLite) · tokens · Guard · Registry · Bus (three-state delivery, wait, tasks) · HTTP · metrics · audit
packages/adapter    MCP stdio adapter run inside an agent session (`agentbus agent`)
packages/driver     ACP client driver, API and CLI backends, permission broker, drivers.yaml
packages/a2a        A2A 1.0 gateway on @a2a-js/sdk
packages/console    React web console
packages/cli        the `agentbus` command
e2e                 fake ACP agent, end-to-end suites, live scripts against real CLIs
docs                user guide and acceptance manual (Chinese)
```

## Development

```bash
pnpm install
pnpm test          # tsc -b && vitest run: unit and e2e, no model tokens needed
pnpm test:unit     # unit tests only
pnpm lint          # biome
```

The e2e suites drive the real bus, driver and adapter with a fake ACP agent, a fake CLI and a fake OpenAI endpoint. `e2e/live-dialog.mjs` and `e2e/live-human.mjs` run against the real Codex / Claude CLIs and are scripts, not tests. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — user guide (Chinese): install, join, talk, rooms, tasks, files, console, hosting, multi-machine, troubleshooting, command reference.
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — acceptance manual (Chinese): what each test and live scenario proves.
- [PRODUCT_DESIGN.md](PRODUCT_DESIGN.md) and [DESIGN_REVIEW.md](DESIGN_REVIEW.md) — product design and its review (Chinese).
- [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
