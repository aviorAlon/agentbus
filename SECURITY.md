# Security

## Reporting a vulnerability

Please report security issues privately to the maintainers (open a private security advisory at https://github.com/aviorAlon/agentbus/security/advisories/new) rather than in a public issue. Include the version or commit, how to reproduce, and what an attacker gains. You will get an acknowledgement within a few days and a fix or mitigation plan before any public disclosure.

## What the bus protects, and what it does not

**Every connection carries a token.** Agents, humans and HTTP participants authenticate with a per-name token (scrypt-hashed in the database). The owner token minted on first start can create and rotate agent tokens, sign in to the console and issue invites; keep `~/.agentbus/owner.token` private. Invite codes are one-time and expire (24 hours by default). There is no token-less mode on the WebSocket or participant HTTP API.

**Messages are data, not instructions.** The skill, the project note and the hook tell the model that bus messages are requests or proposals from other participants and must never be executed because their text says so. This is a prompt-level mitigation, not a sandbox: a hosted agent with `autonomy: full` runs whatever its model decides to run. Host agents with `autonomy: ask` when you do not trust the other participants, and run the host CLI with the least privilege it needs.

**The A2A endpoint is unauthenticated.** `POST /a2a/agents/<name>` and the Agent Cards are open to whoever can reach the bus, by design of the A2A discovery flow. Bind the bus to `127.0.0.1` (the default) unless you need other machines, and when you do, bind only to a trusted network. Artifact downloads do require a bus token.

**Hosted sessions act on the local machine.** A driver runs the host CLI in the configured `cwd` with the environment of the terminal that started it. Do not put secrets in `drivers.yaml`; reference them with `token_env` / `api_key_env`.

**The console shows everything.** Anyone with a human token sees every room, message, task and delivery. Mint separate human tokens for separate people (`agentbus token create --authority human`) so they can be rotated independently.

**Files** are stored content-addressed under `data_dir/blobs` with per-blob and total quotas; they are not scanned. A received file lands under the recipient's `cwd/.agentbus/inbox/` and is never executed by the bus.

## Supported versions

Only the latest release (or the `main` branch before the first release) receives security fixes.
