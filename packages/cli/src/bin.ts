#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { A2AGateway } from '@agentbus/a2a'
import { renderMessages, runAdapter } from '@agentbus/adapter'
import {
  auditJsonl,
  BlobStore,
  Bus,
  BusClient,
  type BusConfig,
  generateToken,
  type HttpRoute,
  hashToken,
  loadConfig,
  parseSince,
  Store,
  verifyToken,
  WsServer,
} from '@agentbus/core'
import {
  AcpBackend,
  ApiBackend,
  type Backend,
  CliBackend,
  Driver,
  DriversConfig,
  defaultAcpCommand,
  defaultModes,
  resolveToken,
} from '@agentbus/driver'
import type { AgentInfo, Message, Task } from '@agentbus/protocol'
import {
  dmRoom,
  encodeRecords,
  MESSAGE_TABLE_FIELDS,
  messageToRow,
  TASK_TABLE_FIELDS,
  taskToRow,
} from '@agentbus/protocol'
import { Command } from 'commander'
import YAML from 'yaml'
import { adapterCommand } from './adapter-command.js'
import { busFor, registerAgentCommands } from './agent-cli.js'
import { httpBaseFromBus, joinHost, leaveHost, nameFromDir, readAgentToken } from './join.js'
import { ensureDir, expandHome, readOwnerToken, writeOwnerToken } from './paths.js'

const VERSION = '0.0.0'
const OWNER = 'owner'
const program = new Command()
program.name('agentbus').description('backend-agnostic agent message bus').version(VERSION)

function log(line: string): void {
  process.stderr.write(`${line}\n`)
}

/** First non-internal IPv4 address, for advertising LAN URLs (A2A cards). */
function firstLanIp(): string {
  for (const list of Object.values(networkInterfaces()))
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address
  return '127.0.0.1'
}

/** The built web console, if present (packages/console/dist). */
function consoleDir(): string | null {
  const candidates = [
    fileURLToPath(new URL('../../console/dist/', import.meta.url)),
    fileURLToPath(new URL('../console/', import.meta.url)),
  ]
  for (const c of candidates) if (existsSync(join(c, 'index.html'))) return c
  return null
}

function readConfig(path: string | undefined, overrides: Partial<BusConfig>): BusConfig {
  const raw = path ? YAML.parse(readFileSync(path, 'utf8')) : {}
  return loadConfig({ ...(raw ?? {}), ...overrides })
}

function openStore(cfg: BusConfig): { store: Store; dataDir: string } {
  const dataDir = ensureDir(expandHome(cfg.data_dir))
  const store = new Store(join(dataDir, 'agentbus.sqlite'))
  store.db.pragma('busy_timeout = 5000')
  return { store, dataDir }
}

/** First run: mint the owner (human) token and persist it (PRODUCT_DESIGN §5.7). */
function ensureOwner(store: Store, dataDir: string): string | null {
  if (store.getAgent(OWNER)) return null
  const token = generateToken()
  store.createAgent({ name: OWNER, token_hash: hashToken(token), authority: 'human' })
  writeOwnerToken(dataDir, token)
  return token
}

function humanToken(cfg: BusConfig, explicit?: string): string {
  if (explicit) return explicit
  const env = process.env.AGENTBUS_TOKEN
  if (env) return env
  const t = readOwnerToken(expandHome(cfg.data_dir))
  if (!t) throw new Error(`no token: run "agentbus serve" once, or pass --token / AGENTBUS_TOKEN`)
  return t
}

function printMessages(msgs: Message[]): void {
  for (const m of msgs) {
    const ts = new Date(m.created_at).toLocaleTimeString()
    process.stdout.write(`${ts} [${m.room}] ${m.from}(${m.authority}): ${m.text}\n`)
  }
}

// ------------------------------------------------------------------ serve

program
  .command('serve')
  .description('run the bus')
  .option('-c, --config <file>', 'agentbus.yaml')
  .option('--bind <host>')
  .option('--port <n>', 'port', (v: string) => Number.parseInt(v, 10))
  .option('--data-dir <dir>')
  .action(async (o: { config?: string; bind?: string; port?: number; dataDir?: string }) => {
    const cfg = readConfig(o.config, {
      ...(o.bind ? { bind: o.bind } : {}),
      ...(o.port !== undefined ? { port: o.port } : {}),
      ...(o.dataDir ? { data_dir: o.dataDir } : {}),
    })
    const { server, store } = await startBus(cfg)
    const shutdown = async () => {
      await server.close()
      store.close()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })

interface RunningBus {
  cfg: BusConfig
  store: Store
  dataDir: string
  bus: Bus
  server: WsServer
  host: string
  port: number
  wsUrl: string
}

/**
 * `POST /api/console/join` — the console's "add an agent" button, for agents on the same
 * machine as the bus. Authenticated as a human; runs `agentbus join` server-side.
 */
function joinRoute(
  bus: Bus,
  where: () => { http: string; bus: string; publicBus: string; publicHttp: string },
): HttpRoute {
  return async (req, res, url) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
      return true
    }
    if (url.pathname === '/api/console/info' && req.method === 'GET') {
      const w = where()
      return reply(200, { bus: w.publicBus, http: w.publicHttp })
    }
    if (url.pathname !== '/api/console/join' || req.method !== 'POST') return false
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const name = String(req.headers['x-agentbus-name'] ?? '')
    const human = name ? bus.store.getAgent(name) : null
    if (!token || !human || human.authority !== 'human' || !verifyToken(token, human.token_hash))
      return reply(401, {
        error: { code: 'unauthorized', message: 'console join needs a human token' },
      })
    let body = ''
    for await (const c of req) body += c
    let parsed: { host?: string; dir?: string; name?: string; authority?: string; hook?: boolean }
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      return reply(400, { error: { code: 'bad_request', message: 'invalid JSON' } })
    }
    if (parsed.host !== 'claude' && parsed.host !== 'codex')
      return reply(400, { error: { code: 'bad_request', message: 'host must be claude or codex' } })
    if (!parsed.dir)
      return reply(400, { error: { code: 'bad_request', message: 'dir is required' } })
    try {
      const w = where()
      const r = await joinHost({
        host: parsed.host,
        dir: parsed.dir,
        ...(parsed.name ? { name: parsed.name } : {}),
        bus: w.bus,
        http: w.http,
        authority: parsed.authority === 'bot' ? 'bot' : 'relayer',
        owner: { name, token },
        noHook: parsed.hook === false,
      })
      return reply(200, r)
    } catch (e) {
      return reply(400, { error: { code: 'bad_request', message: (e as Error).message } })
    }
  }
}

/** Open the store, mint the owner token on first run, start WS/HTTP, log the endpoints. */
async function startBus(cfg: BusConfig): Promise<RunningBus> {
  {
    const { store, dataDir } = openStore(cfg)
    const minted = ensureOwner(store, dataDir)
    const bus = new Bus(store, cfg)
    const blobs = new BlobStore(join(dataDir, 'blobs'), store, {
      maxBytes: cfg.blobs.max_bytes,
      quotaBytes: cfg.blobs.quota_bytes,
    })
    const staticDir = consoleDir()
    const lan = cfg.bind !== '127.0.0.1' && cfg.bind !== 'localhost' && cfg.bind !== '::1'
    let publicBase = `http://${lan ? (cfg.public_host ?? firstLanIp()) : '127.0.0.1'}:${cfg.port}`
    const gateway = new A2AGateway(bus, { publicBase: () => publicBase, version: VERSION })
    let localHttp = ''
    let wsForJoin = ''
    const server = new WsServer(bus, {
      bind: cfg.bind,
      port: cfg.port,
      blobs,
      routes: [
        gateway.route(),
        joinRoute(bus, () => ({
          http: localHttp,
          bus: wsForJoin,
          publicBus: `${publicBase.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`,
          publicHttp: publicBase,
        })),
      ],
      ...(staticDir ? { staticDir } : {}),
    })
    const { host, port } = await server.listen()
    localHttp = `http://127.0.0.1:${port}`
    wsForJoin = `ws://127.0.0.1:${port}/ws`
    publicBase = `http://${lan ? (cfg.public_host ?? firstLanIp()) : '127.0.0.1'}:${port}`
    log(`agentbus ${VERSION} listening on ws://${host}:${port}/ws  data=${dataDir}`)
    if (staticDir) log(`console: http://${host}:${port}/console/`)
    else log('console: not built (pnpm --filter @agentbus/console build)')
    if (minted) log(`owner token (shown once, saved to ${join(dataDir, 'owner.token')}): ${minted}`)
    log(
      `a2a: ${publicBase}/a2a/agents/<name>  cards: ${publicBase}/.well-known/agentbus-agents.json`,
    )
    if (lan)
      log(
        'LAN mode: every WS/HTTP call needs a per-agent token, unregistered sockets are dropped after 10s; ' +
          'the A2A endpoint is open to the LAN (no auth) by design of M3 — keep --bind on a trusted network',
      )
    bus.on('message', (m, d) =>
      log(
        `#${m.id} ${m.room} ${m.from}: ${m.text.slice(0, 80)} → ${d.map((x) => `${x.recipient}/${x.via}`).join(',')}`,
      ),
    )
    bus.on('system', (e) => log(`system ${e.kind} ${e.room ?? ''} ${JSON.stringify(e.detail)}`))
    const wsUrl = `ws://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/ws`
    return { cfg, store, dataDir, bus, server, host, port, wsUrl }
  }
}

// ------------------------------------------------------------------ token

const token = program.command('token').description('manage agent tokens')
token
  .command('create')
  .requiredOption('--name <name>')
  .option('--authority <a>', 'bot | relayer | human', 'bot')
  .option('--backend <b>')
  .option('-c, --config <file>')
  .option('--data-dir <dir>')
  .action(
    (o: {
      name: string
      authority: 'bot' | 'relayer' | 'human'
      backend?: string
      config?: string
      dataDir?: string
    }) => {
      const cfg = readConfig(o.config, o.dataDir ? { data_dir: o.dataDir } : {})
      const { store } = openStore(cfg)
      if (store.getAgent(o.name)) throw new Error(`agent ${o.name} already exists`)
      const t = generateToken()
      store.createAgent({
        name: o.name,
        token_hash: hashToken(t),
        authority: o.authority,
        ...(o.backend ? { backend: o.backend } : {}),
      })
      store.close()
      process.stdout.write(`${t}\n`)
      log(`token for ${o.name} (${o.authority}) printed above; it is not stored in plaintext`)
    },
  )

// ------------------------------------------------------------------ agent (MCP adapter)

program
  .command('agent')
  .description('MCP stdio adapter: run inside an agent session')
  .requiredOption('--bus <url>', 'ws://host:7777/ws')
  .option('--name <name>', 'default: AGENTBUS_NAME or the directory name')
  .option('--token <t>', 'or env AGENTBUS_TOKEN, or ~/.agentbus/agents/<name>.token')
  .option('--role <r>', 'control | tool', 'control')
  .option('--backend <b>')
  .option('--push', 'declare Claude Code channel (preview)', false)
  .action(
    async (o: {
      bus: string
      name?: string
      token?: string
      role: 'control' | 'tool'
      backend?: string
      push: boolean
    }) => {
      const name = o.name ?? process.env.AGENTBUS_NAME ?? nameFromDir(process.cwd())
      const t = o.token ?? process.env.AGENTBUS_TOKEN ?? readAgentToken(name)
      if (!t)
        throw new Error(
          `no token for "${name}": run "agentbus join" in this directory, or pass --token / AGENTBUS_TOKEN`,
        )
      o.name = name
      await runAdapter({
        bus: o.bus,
        name,
        token: t,
        role: o.role,
        push: o.push,
        cwd: process.cwd(),
        version: VERSION,
        ...(o.backend ? { backend: o.backend } : {}),
      })
    },
  )

// ------------------------------------------------------------------ driver

program
  .command('driver')
  .description('hold long-lived backend sessions for agents (drivers.yaml)')
  .requiredOption('-c, --config <file>')
  .action(async (o: { config: string }) => {
    const cfg = DriversConfig.parse(YAML.parse(readFileSync(o.config, 'utf8')))
    if (!cfg.agents.length) throw new Error('drivers.yaml has no agents')
    const drivers: Driver[] = []
    for (const a of cfg.agents) {
      const d = makeDriver(a, cfg.bus, resolveToken(a))
      await d.start()
      drivers.push(d)
    }
    const shutdown = async () => {
      await Promise.all(drivers.map((d) => d.stop()))
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })

type AgentCfg = DriversConfig['agents'][number]

/** Backend + Driver for one drivers.yaml entry. */
function makeDriver(a: AgentCfg, busUrl: string, token: string): Driver {
  {
    let backend: Backend
    let kind: 'acp' | 'cli' | 'api' = 'acp'
    if (a.backend === 'api') {
      if (!a.api) throw new Error(`agent ${a.name}: backend api needs an api: block`)
      const apiKey = a.api.api_key_env ? process.env[a.api.api_key_env] : undefined
      backend = new ApiBackend({
        baseUrl: a.api.base_url,
        model: a.api.model,
        maxIterations: a.api.max_iterations,
        ...(apiKey ? { apiKey } : {}),
        ...(a.api.system_prompt ? { systemPrompt: a.api.system_prompt } : {}),
        log,
      })
      kind = 'api'
    } else if (a.backend === 'cli') {
      if (!a.cli) throw new Error(`agent ${a.name}: backend cli needs a cli: block`)
      backend = new CliBackend({
        command: a.cli.command,
        argsFirst: a.cli.args_first,
        argsResume: a.cli.args_resume,
        env: a.cli.env,
        ...(a.cli.session_id_regex ? { sessionIdRegex: a.cli.session_id_regex } : {}),
        log,
      })
      kind = 'cli'
    } else {
      const launch = a.acp ?? defaultAcpCommand(a.backend)
      if (!launch)
        throw new Error(`agent ${a.name}: backend ${a.backend} needs an explicit acp.command`)
      backend = new AcpBackend({
        command: launch.command,
        args: launch.args,
        ...(a.acp?.env ? { env: a.acp.env } : {}),
        autonomy: a.autonomy,
        modes: [...(a.acp?.mode ? [a.acp.mode] : []), ...defaultModes(a.backend, a.autonomy)],
        log,
      })
    }
    return new Driver({
      bus: busUrl,
      name: a.name,
      token,
      backendName: a.backend,
      cwd: expandHome(a.cwd),
      backend,
      adapterCommand: adapterCommand(),
      kind,
      batchWindowMs: a.batch_window_ms,
      turnTimeoutMs: a.turn_timeout_s * 1000,
      maxAttempts: a.max_attempts,
      permissionTimeoutMs: a.permission_timeout_s * 1000,
      log,
      onTurn: (t) =>
        log(
          `[turn ${t.agent}] ${t.messageIds.length} msg, ${t.endedAt - t.startedAt}ms, ${t.exitReason}`,
        ),
    })
  }
}

// ------------------------------------------------------------------ up (bus + drivers in one process)

program
  .command('up')
  .description(
    'one window: run the bus and every driver in drivers.yaml; tokens are minted automatically',
  )
  .option('-c, --config <file>', 'agentbus.yaml')
  .option('-d, --drivers <file>', 'drivers.yaml', 'drivers.yaml')
  .option('--build', 'run `pnpm tsc -b` in the repo first', false)
  .option('--bind <host>')
  .option('--port <n>', 'port', (v: string) => Number.parseInt(v, 10))
  .option('--data-dir <dir>')
  .action(
    async (o: {
      config?: string
      drivers: string
      build: boolean
      bind?: string
      port?: number
      dataDir?: string
    }) => {
      if (o.build) {
        const root = fileURLToPath(new URL('../../..', import.meta.url))
        log(`building (${root})`)
        const r = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['tsc', '-b'], {
          cwd: root,
          stdio: 'inherit',
          shell: process.platform === 'win32',
        })
        if (r.status !== 0) throw new Error('build failed')
      }
      const cfg = readConfig(o.config, {
        ...(o.bind ? { bind: o.bind } : {}),
        ...(o.port !== undefined ? { port: o.port } : {}),
        ...(o.dataDir ? { data_dir: o.dataDir } : {}),
      })
      // No drivers file = just the bus; agents join later with `agentbus join`.
      const dcfg = existsSync(o.drivers)
        ? DriversConfig.parse(YAML.parse(readFileSync(o.drivers, 'utf8')) ?? {})
        : DriversConfig.parse({})
      if (!existsSync(o.drivers)) log(`[up] no ${o.drivers}; running the bus only`)
      const running = await startBus(cfg)
      const drivers: Driver[] = []
      for (const a of dcfg.agents) {
        // Same process as the bus: we own the store, so a missing or unspecified token is
        // simply minted (or rotated) here and never has to be copied around.
        let token: string
        if (a.token || (a.token_env && process.env[a.token_env])) token = resolveToken(a)
        else {
          token = generateToken()
          if (running.store.getAgent(a.name)) {
            running.store.setTokenHash(a.name, hashToken(token))
            log(`[up] ${a.name}: token rotated`)
          } else {
            running.store.createAgent({
              name: a.name,
              token_hash: hashToken(token),
              backend: a.backend,
            })
            log(`[up] ${a.name}: created`)
          }
        }
        const d = makeDriver(a, running.wsUrl, token)
        await d.start()
        drivers.push(d)
      }
      log(
        dcfg.agents.length
          ? `[up] ready: ${dcfg.agents.map((a) => a.name).join(', ')} — try: agentbus chat --to ${dcfg.agents[0]?.name}`
          : '[up] ready (bus only) — add agents with: agentbus join --claude | --codex, or the console',
      )
      const shutdown = async () => {
        log('[up] stopping')
        await Promise.all(drivers.map((d) => d.stop()))
        await running.server.close()
        running.store.close()
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    },
  )

// ------------------------------------------------------------------ hooks

/**
 * Claude Code `UserPromptSubmit` hook (PRODUCT_DESIGN T1.3): connects in `tool` role,
 * pulls unread messages and returns them as additional context, so an interactive
 * session sees the bus at every turn boundary without the model remembering to call inbox.
 */
const hook = program.command('hook').description('editor/CLI hook helpers')
hook
  .command('user-prompt-submit')
  .option('--bus <url>', 'default: the bus this directory joined')
  .option('--name <name>', 'default: the name of the directory the host passes on stdin (cwd)')
  .option('--token <t>', 'or env AGENTBUS_TOKEN')
  .action(async (o: { bus?: string; name?: string; token?: string }) => {
    // Both Claude Code and Codex pipe a JSON object with `cwd` and `prompt` to the hook.
    const stdin = await hookStdin()
    const dir = stdin?.cwd ?? process.cwd()
    const name = o.name ?? nameFromDir(dir)
    const t = o.token ?? process.env.AGENTBUS_TOKEN ?? readAgentToken(name)
    if (!t) return // this directory is not on the bus: nothing to add
    const c = new BusClient(busFor(o.bus, name))
    try {
      await c.connect()
      await c.request({
        type: 'register',
        name,
        token: t,
        role: 'tool',
        capabilities: { inbox: true, push: false },
      })
      // peek: the rows stay unread, so the agent's own `inbox` call in the turn shows them again and
      // marks them; a row the model ignored is injected at the next prompt too instead of being lost.
      const r = await c.request<{ messages: Message[] }>({ type: 'inbox', peek: true })
      const parts: string[] = []
      if (r.messages.length) parts.push(renderMessages(r.messages), hookGuidance(name))
      // The prompt names another agent ("tita 你电脑…", "问 tita …", "@tita …"): say so, deterministically,
      // so the model does not answer about its own machine. Small models get this wrong on their own.
      if (stdin?.prompt) {
        const { agents } = await c.request<{ agents: { name: string; authority: string }[] }>({
          type: 'agents',
        })
        const others = agents
          .filter((a) => a.name !== name && a.authority !== 'human')
          .map((a) => a.name)
        const to = addressee(stdin.prompt, others)
        if (to) parts.push(addressingHint(name, to))
      }
      if (parts.length) {
        process.stdout.write(
          `${JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: parts.join('\n'),
            },
          })}\n`,
        )
      }
    } catch (e) {
      // A hook must never block the user's prompt: report and exit 0.
      log(`agentbus hook: ${(e as Error).message}`)
    } finally {
      c.close()
    }
  })

/**
 * Which other agent the prompt is addressed to, if any: a known name at the start ("tita 你…",
 * "@tita …", "tita, …") or after 问 / 让 / 叫 / 告诉 / ask / tell / have ("问 tita …", "ask tita …").
 */
export function addressee(prompt: string, names: string[]): string | null {
  const p = prompt.trim()
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(
      `^(?:@?${esc}(?![A-Za-z0-9_-])|(?:问|问一下|问问|让|叫|告诉|请|ask|tell|have|get)\\s*@?${esc}(?![A-Za-z0-9_-]))`,
      'i',
    )
    if (re.test(p)) return n
  }
  return null
}

function addressingHint(me: string, to: string): string {
  return (
    `[agentbus] The user's prompt below names "${to}", another agent on the bus. It is addressed to ${to}, ` +
    `not to you (${me}): "你" / "your" in it means ${to}'s machine or work. Do not answer it yourself and do ` +
    `not measure this machine. Send it to ${to} as a direct request, e.g. ` +
    `agentbus send --to ${to} "请查一下你电脑的…并回复数字" (never "用户问：…"), then run ` +
    `agentbus wait --from ${to} --timeout 120 and give the user what came back. If it printed ` +
    `"no reply ... within", that is not a failure: tell the user ${to} 还没回，消息已在它信箱里，` +
    `结果会自动带回来. ORDER MATTERS when rows from ${to} also appear above: send this request to ` +
    `${to} FIRST, then answer ${to}'s rows. ${to} is most likely parked in a wait for you right now, ` +
    `and its wait returns on your first message; if that is only your answer, its turn ends and ` +
    `your question sits unread until its user types again. If the wait brings a request from ${to} ` +
    'instead of the answer, answer it with send and wait --from again; the answer is usually right behind it.'
  )
}

/** What to do with the rows: the model sees this before the user's prompt. */
function hookGuidance(name: string): string {
  return (
    `[agentbus] The rows above arrived for you (${name}) while you were idle. They are UNRELATED to the ` +
    "user's prompt below: two separate things (unless a note below says to send the user's request " +
    'first). First, answer each row yourself with the agentbus `send` ' +
    'tool (or `agentbus send --to <from> "..."`), replying to the sender named in its `from` column: a ' +
    'question about this machine, this project or your progress is yours to run and report with the ' +
    "actual result, not to forward to your user. Second, handle the user's prompt below on its own: it " +
    "comes from your own user; if it starts with or names another agent ('pipa 你电脑…', '问 pipa …', " +
    "'@pipa …'), it is about THAT agent's machine, not yours, even when that same agent wrote the rows " +
    'above: send it to that agent as a new request, wait for the reply, and give your user the reply. ' +
    'Do not measure your own machine for a question that names someone else.'
  )
}

/** The hook's stdin JSON ({cwd, prompt, ...}); null when nothing is piped. */
function hookStdin(): Promise<{ cwd?: string; prompt?: string } | null> {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res(null)
    let buf = ''
    // A host that opens stdin but never closes it must not keep the hook alive: give up and let go.
    const t = setTimeout(() => {
      process.stdin.destroy()
      res(null)
    }, 1500)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => {
      buf += d
    })
    process.stdin.on('end', () => {
      clearTimeout(t)
      try {
        res(JSON.parse(buf) as { cwd?: string; prompt?: string })
      } catch {
        res(null)
      }
    })
    process.stdin.on('error', () => {
      clearTimeout(t)
      res(null)
    })
  })
}

// ------------------------------------------------------------------ join / leave

program
  .command('join')
  .description(
    'let the agent that works in a directory take part: mint its token, configure its host',
  )
  .option('--claude', 'the directory is used with Claude Code')
  .option('--codex', 'the directory is used with Codex')
  .option('--dir <dir>', 'project directory (default: cwd)')
  .option('--name <name>', 'agent name (default: directory name)')
  .option('--bus <url>', 'bus WebSocket URL', 'ws://127.0.0.1:7777/ws')
  .option('--authority <a>', 'relayer (a person is at the keyboard) | bot', 'relayer')
  .option('--no-hook', 'Claude: do not install the UserPromptSubmit hook')
  .option('--token <t>', 'owner token (default: ~/.agentbus/owner.token)')
  .option('--invite <code>', 'one-time invite from the bus operator (another machine)')
  .option('--as <name>', 'human participant name', OWNER)
  .option('-c, --config <file>')
  .option('--data-dir <dir>')
  .action(
    async (o: {
      claude?: boolean
      codex?: boolean
      dir?: string
      name?: string
      bus: string
      authority: 'bot' | 'relayer'
      hook: boolean
      token?: string
      invite?: string
      as: string
      config?: string
      dataDir?: string
    }) => {
      if (!o.claude && !o.codex) throw new Error('say which host: --claude or --codex')
      const cfg = readConfig(o.config, o.dataDir ? { data_dir: o.dataDir } : {})
      const r = await joinHost({
        host: o.claude ? 'claude' : 'codex',
        ...(o.dir ? { dir: o.dir } : {}),
        ...(o.name ? { name: o.name } : {}),
        bus: o.bus,
        authority: o.authority,
        ...(o.invite
          ? { invite: o.invite }
          : { owner: { name: o.as, token: humanToken(cfg, o.token) } }),
        noHook: !o.hook,
      })
      for (const st of r.steps) log(`- ${st}`)
      process.stdout.write(`joined as "${r.name}" (${r.host}, ${r.authority})\n${r.next}\n`)
    },
  )

program
  .command('leave')
  .description('remove agentbus from the host configured for a directory')
  .option('--claude')
  .option('--codex')
  .option('--dir <dir>')
  .option('--name <name>')
  .option('--purge', 'also delete the local token file', false)
  .action(
    (o: { claude?: boolean; codex?: boolean; dir?: string; name?: string; purge: boolean }) => {
      if (!o.claude && !o.codex) throw new Error('say which host: --claude or --codex')
      const r = leaveHost({
        host: o.claude ? 'claude' : 'codex',
        ...(o.dir ? { dir: o.dir } : {}),
        ...(o.name ? { name: o.name } : {}),
        purge: o.purge,
      })
      for (const st of r.steps) log(`- ${st}`)
      process.stdout.write(`left as "${r.name}"\n`)
    },
  )

// ------------------------------------------------------------------ human entry

async function humanClient(
  bus: string,
  cfg: BusConfig,
  tokenOpt?: string,
  name = OWNER,
): Promise<BusClient> {
  const c = new BusClient(bus)
  await c.connect()
  await c.request({
    type: 'register',
    name,
    token: humanToken(cfg, tokenOpt),
    role: 'control',
    capabilities: { inbox: true, push: false },
    version: `agentbus-cli/${VERSION}`,
  })
  return c
}

const common = (cmd: Command) =>
  cmd
    .option('--bus <url>', 'ws://127.0.0.1:7777/ws', 'ws://127.0.0.1:7777/ws')
    .option('--token <t>')
    .option('--as <name>', 'human participant name', OWNER)
    .option('-c, --config <file>')
    .option('--data-dir <dir>')

type CommonOpts = { bus: string; token?: string; as: string; config?: string; dataDir?: string }

common(
  program
    .command('chat')
    .description('talk as a human; to a driver-held agent this is its terminal'),
)
  .argument('[room]')
  .option('--to <agent>')
  .action(async (room: string | undefined, o: CommonOpts & { to?: string }) => {
    const cfg = readConfig(o.config, o.dataDir ? { data_dir: o.dataDir } : {})
    const c = await humanClient(o.bus, cfg, o.token, o.as)
    let target: { room: string } | { to: string }
    let viewRoom: string
    if (o.to) {
      target = { to: o.to }
      viewRoom = dmRoom(o.as, o.to)
    } else if (room) {
      target = { room }
      viewRoom = room
      await c.request({ type: 'join', room }).catch(() => undefined)
    } else throw new Error('give a room or --to <agent>')

    const hist = await c
      .request<{ messages: Message[] }>({ type: 'history', room: viewRoom, limit: 20 })
      .catch(() => ({ messages: [] as Message[] }))
    printMessages(hist.messages)
    await c.request({ type: 'inbox' }) // we have caught up

    const loop = async () => {
      for (;;) {
        try {
          const r = await c.request<{ messages: Message[] }>({ type: 'wait', timeout_s: 300 })
          printMessages(r.messages.filter((m) => m.room === viewRoom))
        } catch {
          return
        }
      }
    }
    void loop()
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${o.as}> `,
    })
    rl.prompt()
    rl.on('line', async (line) => {
      const text = line.trim()
      if (text) {
        try {
          await c.request({ type: 'send', text, ...target })
        } catch (e) {
          log(`send failed: ${(e as Error).message}`)
        }
      }
      rl.prompt()
    })
    rl.on('close', () => {
      c.close()
      process.exit(0)
    })
  })

common(program.command('tail').description('watch a room'))
  .argument('<room>')
  .action(async (room: string, o: CommonOpts) => {
    const cfg = readConfig(o.config, o.dataDir ? { data_dir: o.dataDir } : {})
    const c = await humanClient(o.bus, cfg, o.token, o.as)
    const hist = await c.request<{ messages: Message[] }>({ type: 'history', room, limit: 50 })
    printMessages(hist.messages)
    await c.request({ type: 'inbox' })
    for (;;) {
      const r = await c.request<{ messages: Message[] }>({ type: 'wait', timeout_s: 300 })
      printMessages(r.messages.filter((m) => m.room === room))
    }
  })

common(program.command('status').description('agents and rooms')).action(async (o: CommonOpts) => {
  const cfg = readConfig(o.config, o.dataDir ? { data_dir: o.dataDir } : {})
  const c = await humanClient(o.bus, cfg, o.token, o.as)
  const a = await c.request<{ agents: AgentInfo[] }>({ type: 'agents' })
  process.stdout.write(
    `${encodeRecords(
      ['name', 'backend', 'authority', 'online', 'state', 'driver', 'inbox', 'push'],
      a.agents.map((x) => ({
        name: x.name,
        backend: x.backend ?? '',
        authority: x.authority,
        online: x.online,
        state: x.state,
        driver: x.capabilities.driver?.kind ?? '',
        inbox: x.capabilities.inbox,
        push: x.capabilities.push,
      })),
    )}\n\n`,
  )
  const r = await c.request<{
    rooms: { name: string; kind: string; paused: boolean; members: string[] }[]
  }>({ type: 'rooms' })
  process.stdout.write(
    `${encodeRecords(
      ['name', 'kind', 'paused', 'members'],
      r.rooms.map((x) => ({ ...x, members: x.members.join(',') })),
    )}\n`,
  )
  c.close()
})

program
  .command('audit')
  .description('export messages, deliveries, events, tasks and driver turns as JSONL')
  .option('--room <room>')
  .option('--since <d>', '1h / 30m / 2d or ISO date', '24h')
  .option('-c, --config <file>')
  .option('--data-dir <dir>')
  .action((o: { room?: string; since: string; config?: string; dataDir?: string }) => {
    const cfg = readConfig(o.config, o.dataDir ? { data_dir: o.dataDir } : {})
    const { store } = openStore(cfg)
    process.stdout.write(
      auditJsonl(store, { since: parseSince(o.since), ...(o.room ? { room: o.room } : {}) }),
    )
    store.close()
  })

common(program.command('tasks').description('task board as a compact table'))
  .option('--all', 'include closed tasks', false)
  .option('--state <s>')
  .action(async (o: CommonOpts & { all: boolean; state?: string }) => {
    const cfg = readConfig(o.config, o.dataDir ? { data_dir: o.dataDir } : {})
    const c = await humanClient(o.bus, cfg, o.token, o.as)
    const r = await c.request<{ tasks: Task[] }>({
      type: 'tasks',
      open_only: !o.all,
      ...(o.state ? { state: o.state as Task['state'] } : {}),
    })
    process.stdout.write(`${encodeRecords(TASK_TABLE_FIELDS, r.tasks.map(taskToRow))}\n`)
    c.close()
  })

common(
  program
    .command('invite')
    .description('one-time code so another machine can join: prints the command to run there'),
)
  .option('--name <name>', 'bind the invite to this agent name (default: the joiner picks)')
  .option('--authority <a>', 'relayer | bot', 'relayer')
  .option('--ttl <hours>', 'validity', (v: string) => Number.parseFloat(v), 24)
  .option('--host <h>', 'claude | codex, only for the printed command', 'claude')
  .action(
    async (
      o: CommonOpts & { name?: string; authority: 'bot' | 'relayer'; ttl: number; host: string },
    ) => {
      const cfg = readConfig(o.config, o.dataDir ? { data_dir: o.dataDir } : {})
      const token = humanToken(cfg, o.token)
      const http = httpBaseFromBus(o.bus)
      const info = (await (await fetch(`${http}/api/console/info`)).json()) as { bus: string }
      const r = await fetch(`${http}/api/console/invites`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-agentbus-name': o.as,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...(o.name ? { name: o.name } : {}),
          authority: o.authority,
          ttl_hours: o.ttl,
        }),
      })
      if (!r.ok) throw new Error(`invite refused (${r.status}): ${(await r.text()).slice(0, 200)}`)
      const inv = (await r.json()) as { code: string; expires_at: number }
      process.stdout.write(
        `agentbus join --${o.host} --bus ${info.bus} --invite ${inv.code}${o.name ? ` --name ${o.name}` : ''}\n`,
      )
      log(
        `run that on the other machine, inside the agent's directory; valid until ${new Date(inv.expires_at).toLocaleString()}, single use`,
      )
    },
  )

common(program.command('ping').description('send one dm as the human and wait for the reply'))
  .argument('<agent>')
  .option('--text <t>', 'message', 'ping: reply with one short sentence via the agentbus send tool')
  .option('--timeout <s>', 'seconds', (v: string) => Number.parseInt(v, 10), 120)
  .action(async (agent: string, o: CommonOpts & { text: string; timeout: number }) => {
    const cfg = readConfig(o.config, o.dataDir ? { data_dir: o.dataDir } : {})
    const c = await humanClient(o.bus, cfg, o.token, o.as)
    await c.request({ type: 'inbox' })
    const t0 = Date.now()
    const sent = await c.request<{ deliveries: { via: string; state: string }[] }>({
      type: 'send',
      to: agent,
      text: o.text,
    })
    log(`sent → ${sent.deliveries.map((d) => `${d.via}/${d.state}`).join(',')}`)
    const room = dmRoom(o.as, agent)
    const deadline = Date.now() + o.timeout * 1000
    while (Date.now() < deadline) {
      const r = await c.request<{ messages: Message[] }>({
        type: 'wait',
        timeout_s: Math.min(60, Math.max(1, Math.round((deadline - Date.now()) / 1000))),
      })
      const reply = r.messages.find((m) => m.room === room && m.from === agent)
      if (reply) {
        process.stdout.write(
          `${agent} replied in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${reply.text}\n`,
        )
        c.close()
        return
      }
    }
    c.close()
    throw new Error(`${agent} did not reply within ${o.timeout}s`)
  })

common(program.command('history').description('dump a room as a compact table'))
  .argument('<room>')
  .option('--limit <n>', 'max messages', (v: string) => Number.parseInt(v, 10), 100)
  .action(async (room: string, o: CommonOpts & { limit: number }) => {
    const cfg = readConfig(o.config, o.dataDir ? { data_dir: o.dataDir } : {})
    const c = await humanClient(o.bus, cfg, o.token, o.as)
    const h = await c.request<{ messages: Message[] }>({ type: 'history', room, limit: o.limit })
    process.stdout.write(`${encodeRecords(MESSAGE_TABLE_FIELDS, h.messages.map(messageToRow))}\n`)
    c.close()
  })

registerAgentCommands(
  program,
  (cmd) =>
    cmd
      .option('--bus <url>', 'default: the bus this directory joined, else ws://127.0.0.1:7777/ws')
      .option('--as <name>', 'act as this agent (default: the directory name)'),
  log,
)

program.parseAsync(process.argv).catch((e: Error) => {
  log(`error: ${e.message}`)
  process.exit(1)
})
