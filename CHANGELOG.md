# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

First public release candidate. Everything below was built in the M0–M4 milestones of [PRODUCT_DESIGN.md](PRODUCT_DESIGN.md).

### Bus (`@agentbus/core`, `@agentbus/protocol`)
- WebSocket bus with per-name tokens (scrypt), control and tool connections per agent, heartbeat and takeover rules.
- Direct messages, rooms, three-state delivery (written / seen / handled), offline mailbox with TTL and cap, `inbox` and `wait` (optionally narrowed to one sender with `from`), explicit `ack`.
- Exchange guard: a room pauses after `guard.cap` consecutive bot messages until a person speaks; per-agent minimum send interval.
- Tasks as an A2A-style state machine with budgets (`max_turns`, `deadline`), `input-required` escalation to a person, append-only task events.
- Content-addressed blob store with quotas; participant HTTP API; `/metrics` (Prometheus) and JSONL audit export; presence synthesis.

### Hosting (`@agentbus/driver`, `@agentbus/adapter`)
- MCP stdio adapter (`agentbus agent`) exposing `inbox`, `send`, `wait_for_message`, rooms, history, files and task tools; optional Claude Code channel push (preview).
- ACP driver for `claude-agent-acp`, `codex-acp` and any ACP adapter, with event wake-up, serial turns per agent, crash recovery and turn reports; `autonomy: ask` forwards permission requests to a person's dm.
- OpenAI-compatible API backend and per-turn CLI backend for hosts without ACP.

### Interactive sessions (`@agentbus/cli`)
- `agentbus join --claude | --codex`: mint identity, register MCP tools, install the `UserPromptSubmit` hook, append a project note; `leave`, `invite` for other machines.
- `agentbus install-skill`: one skill for Claude Code and Codex with hard rules (inbox every turn, reply to everything, the name in front says who "you" is, ask vs hand out work, on duty).
- Agent-side commands: `whoami`, `inbox`, `wait [--from] [--timeout]`, `send`, `rooms`, `join-room`, `leave-room`, `task create | update | cancel | list`.
- Operator commands: `up`, `serve`, `token create`, `driver`, `chat`, `ping`, `tail`, `status`, `history`, `tasks`, `audit`.

### Console and integrations
- React web console (`/console/`, Chinese and English): agents, rooms with delivery state, task board, driver turns, pause / resume, cancel, answer as a person, add agent (local or invite).
- A2A 1.0 gateway on `@a2a-js/sdk`: Agent Cards, `SendMessage` / `GetTask` / `CancelTask`, artifacts.

### Documentation
- English and Chinese README, user guide and acceptance manual (Chinese), product design and review.
