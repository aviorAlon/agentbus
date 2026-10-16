# Contributing to agentbus

Thanks for taking the time. This page is in English; a short Chinese summary follows at the end (中文摘要见文末).

## Before you start

- Bugs and feature requests go to the issue tracker. For a bug, include the bus log line(s), the `agentbus status` output and, when a message is involved, its delivery state from `agentbus tail <room>` or the console.
- For anything larger than a fix, open an issue first so the design can be discussed. The product design lives in [PRODUCT_DESIGN.md](PRODUCT_DESIGN.md) (Chinese); its feature list (F-xx) and mechanisms (§4) are what the code is checked against.

## Development setup

```bash
pnpm install
pnpm tsc -b                      # build every package into dist/
pnpm test                        # tsc -b && vitest run (unit + e2e)
pnpm test:unit                   # unit tests only
pnpm lint                        # biome check
pnpm --filter @agentbus/console build   # the web console (optional)
```

Node.js 24 and pnpm 9 are required. The e2e suites start a real bus, driver and adapter and talk to a fake ACP agent (`e2e/fake-agent.ts`), a fake CLI and a fake OpenAI endpoint, so they need no model and no API key. `e2e/live-dialog.mjs` and `e2e/live-human.mjs` drive the real Codex / Claude CLIs; they cost tokens and are run by hand.

Layout and responsibilities are listed in the README under "Repository layout". A few conventions that are not obvious from the code:

- `packages/protocol` is the only place frames and tool schemas are defined; core, adapter, driver and CLI import from it. A new frame goes there first, with its zod schema.
- The bus never pushes into an interactive session. Anything that needs a session to notice a message goes through `inbox` / `wait` / the `UserPromptSubmit` hook, or through a driver for hosted agents. Keep that invariant.
- Delivery has three states (written / seen / handled) and one row per recipient. Code that reads or writes them lives in `packages/core/src/store` and `packages/core/src/bus/bus.ts`; add tests in `bus.test.ts` for any change to the delivery path.
- The skill text (`packages/cli/src/skill.ts`) is a product surface: it is what the model reads. Changes to it must keep `node e2e/live-dialog.mjs cpu` and `crossed` passing, and `skillMarkdown` and `projectNote` must say the same thing.
- Table output for agents is the compact pipe format from `@agentbus/protocol` (`encodeRecords`), to save tokens. Do not switch it to JSON.

## Pull requests

- One topic per PR. Include tests for behaviour changes; `pnpm test` and `pnpm lint` must pass.
- Keep user-facing docs in step: `docs/USER_GUIDE.md` for behaviour a user sees, `README.md` and `README.zh-CN.md` together for anything that changes the quick start, configuration or CLI tables.
- Commit messages: a short imperative summary line, then why, in the body, when the diff does not say it.

## Reporting a security issue

See [SECURITY.md](SECURITY.md). Please do not open a public issue for a vulnerability.

---

## 中文摘要

- 提 issue 时附上总线日志、`agentbus status` 输出，涉及消息的附投递状态（`agentbus tail <room>` 或控制台）。较大的改动先开 issue 讨论；设计文档是 [PRODUCT_DESIGN.md](PRODUCT_DESIGN.md)。
- 环境：Node 24、pnpm 9。`pnpm install && pnpm tsc -b`，`pnpm test` 跑单测和 e2e（e2e 用假 agent，不消耗 token），`pnpm lint` 是 biome。
- 几条约定：帧和工具 schema 只定义在 `packages/protocol`；总线永远不把消息推进交互式会话，要让会话看到消息只能走 `inbox` / `wait` / hook 或托管；投递三态的读写集中在 core 的 store 与 bus，改投递路径必须加测试；`packages/cli/src/skill.ts` 是模型读的产品文案，改完必须让 `e2e/live-dialog.mjs` 的 `cpu` 和 `crossed` 都 PASS；给 agent 看的表格保持紧凑管道格式，不要改成 JSON。
- PR：一个主题一个 PR，带测试，`pnpm test` 和 `pnpm lint` 通过；用户可见的行为同步改 `docs/USER_GUIDE.md`，README 中英文一起改。
- 安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。
