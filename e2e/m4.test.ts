import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  Bus,
  BusClient,
  generateToken,
  hashToken,
  loadConfig,
  Store,
  WsServer,
} from '@agentbus/core'
import { ApiBackend, CliBackend, Driver } from '@agentbus/driver'
import type { Message } from '@agentbus/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** M4 acceptance: push degrade, ApiBackend, CliBackend, console actions, metrics, audit. */
const execFileP = promisify(execFile)
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const CLI_BIN = here('../packages/cli/dist/bin.js')
const FAKE_CLI = here('./dist/fake-cli.js')

async function waitFor<T>(
  fn: () => T | Promise<T>,
  pred: (v: T) => boolean,
  ms = 15_000,
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (pred(v)) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout; last: ${JSON.stringify(v).slice(0, 300)}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('M4 e2e', () => {
  let store: Store
  let bus: Bus
  let server: WsServer
  let url: string
  let http: string
  let dataDir: string
  const tokens: Record<string, string> = {}
  const drivers: Driver[] = []
  const mcp: Client[] = []
  const extra: Server[] = []

  beforeEach(async () => {
    expect(existsSync(CLI_BIN) && existsSync(FAKE_CLI), 'build first').toBe(true)
    dataDir = mkdtempSync(join(tmpdir(), 'agentbus-m4-'))
    store = new Store(join(dataDir, 'agentbus.sqlite')) // same file the CLI opens for `audit`
    for (const [name, authority] of [
      ['me', 'human'],
      ['alpha', 'bot'],
      ['api', 'bot'],
      ['cli', 'bot'],
    ] as const) {
      tokens[name] = generateToken()
      store.createAgent({ name, token_hash: hashToken(tokens[name] as string), authority })
    }
    bus = new Bus(
      store,
      loadConfig({ guard: { cap: 4, min_interval_ms: 0 }, push: { seen_timeout_s: 1 } }),
    )
    server = new WsServer(bus, { bind: '127.0.0.1', port: 0, tickMs: 300 })
    const { port } = await server.listen()
    url = `ws://127.0.0.1:${port}/ws`
    http = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await Promise.all(mcp.splice(0).map((c) => c.close().catch(() => undefined)))
    await Promise.all(drivers.splice(0).map((d) => d.stop()))
    for (const s of extra.splice(0)) await new Promise((r) => s.close(() => r(null)))
    await server.close()
    store.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  async function human(): Promise<BusClient> {
    const c = new BusClient(url)
    await c.connect()
    await c.request({
      type: 'register',
      name: 'me',
      token: tokens.me as string,
      role: 'control',
      capabilities: { inbox: true, push: false },
    })
    return c
  }
  const humanHeaders = () => ({
    authorization: `Bearer ${tokens.me}`,
    'x-agentbus-name': 'me',
    'content-type': 'application/json',
  })

  it('push: adapter declares the channel, pushes a notification, and the bus degrades to mailbox when unseen', async () => {
    const notifications: unknown[] = []
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_BIN, 'agent', '--bus', url, '--name', 'alpha', '--push'],
      env: { ...(process.env as Record<string, string>), AGENTBUS_TOKEN: tokens.alpha as string },
      cwd: dataDir,
      stderr: 'inherit',
    })
    const client = new Client({ name: 'host', version: '0' })
    client.fallbackNotificationHandler = async (n) => {
      notifications.push(n)
    }
    await client.connect(transport)
    mcp.push(client)
    expect(client.getServerCapabilities()?.experimental).toHaveProperty('claude/channel')
    await waitFor(
      () => bus.agents().find((a) => a.name === 'alpha'),
      (a) => a?.online === true,
    )
    expect(bus.agents().find((a) => a.name === 'alpha')?.capabilities).toMatchObject({
      push: true,
      push_preview: true,
    })

    const me = await human()
    const sent = await me.request<{
      message: Message
      deliveries: { via: string; state: string }[]
    }>({ type: 'send', to: 'alpha', text: 'knock knock' })
    expect(sent.deliveries[0]).toMatchObject({ via: 'push', state: 'written' })
    await waitFor(
      () => notifications.length,
      (n) => n >= 1,
    )
    expect(notifications[0]).toMatchObject({
      method: 'notifications/claude/channel',
      params: { meta: { from: 'me', room: 'dm:alpha|me' } },
    })
    expect(JSON.stringify(notifications[0])).toContain('knock knock')

    // nobody pulled inbox: after seen_timeout the delivery is relabelled as degraded
    const degraded = await waitFor(
      () => store.getDelivery(sent.message.id, 'alpha'),
      (d) => d?.via === 'push->mailbox',
      5000,
    )
    expect(degraded?.state).toBe('written')
    // the model pulls inbox eventually → seen, and the message is still there
    const inbox = await client.callTool({ name: 'inbox', arguments: {} })
    expect(JSON.stringify(inbox)).toContain('knock knock')
    expect(store.getDelivery(sent.message.id, 'alpha')?.state).toBe('seen')
    me.close()
  }, 30_000)

  it('ApiBackend drives an OpenAI-compatible model through the adapter tools', async () => {
    // Fake /v1/chat/completions: first call → tool call `send`, second call → done.
    const calls: unknown[] = []
    const fake = createServer(async (req, res) => {
      let body = ''
      for await (const c of req) body += c
      const parsed = JSON.parse(body) as {
        messages: { role: string; content: string | null }[]
        tools: { function: { name: string } }[]
      }
      calls.push(parsed)
      const hasToolResult = parsed.messages.some((m) => m.role === 'tool')
      const toolNames = parsed.tools.map((t) => t.function.name)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (!hasToolResult) {
        const user = parsed.messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''
        const from = /\|(\w+)\|human\|/.exec(user)?.[1] ?? 'me'
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'c1',
                      type: 'function',
                      function: {
                        name: 'send',
                        arguments: JSON.stringify({
                          to: from,
                          text: `api says hi (tools: ${toolNames.length})`,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        )
      } else {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }] }))
      }
    })
    extra.push(fake)
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
    const fakePort = (fake.address() as { port: number }).port

    const d = new Driver({
      bus: url,
      name: 'api',
      token: tokens.api as string,
      backendName: 'api',
      cwd: dataDir,
      kind: 'api',
      backend: new ApiBackend({
        baseUrl: `http://127.0.0.1:${fakePort}/v1`,
        model: 'fake-1',
        apiKey: 'k',
        log: () => undefined,
      }),
      adapterCommand: { command: process.execPath, args: [CLI_BIN, 'agent'] },
      batchWindowMs: 100,
      turnTimeoutMs: 20_000,
      maxAttempts: 1,
      log: (l) => process.stderr.write(`${l}\n`),
    })
    drivers.push(d)
    await d.start()
    const me = await human()
    await me.request({ type: 'send', to: 'api', text: 'hello embedded agent' })
    const reply = await me.request<{ messages: Message[] }>({ type: 'wait', timeout_s: 15 })
    expect(reply.messages[0]?.text).toMatch(/^api says hi \(tools: 1[0-9]\)$/)
    await waitFor(
      () => calls.length,
      (n) => n >= 2,
    )
    expect(bus.agents().find((a) => a.name === 'api')?.capabilities.driver).toEqual({ kind: 'api' })
    me.close()
  }, 30_000)

  it('CliBackend runs a command per turn and resumes with the captured session id', async () => {
    const log = join(dataDir, 'cli.log')
    const d = new Driver({
      bus: url,
      name: 'cli',
      token: tokens.cli as string,
      backendName: 'cli',
      cwd: dataDir,
      kind: 'cli',
      backend: new CliBackend({
        command: process.execPath,
        argsFirst: [FAKE_CLI, 'exec', '--cwd', '{cwd}', '--mcp', '{adapter_command}', '{prompt}'],
        argsResume: [FAKE_CLI, 'exec', '--resume', '{session}', '{prompt}'],
        sessionIdRegex: 'thread_id: (\\S+)',
        env: { FAKE_CLI_LOG: log },
        log: () => undefined,
      }),
      adapterCommand: { command: process.execPath, args: [CLI_BIN, 'agent'] },
      batchWindowMs: 100,
      turnTimeoutMs: 10_000,
      maxAttempts: 1,
      log: () => undefined,
    })
    drivers.push(d)
    await d.start()
    const me = await human()
    await me.request({ type: 'send', to: 'cli', text: 'first' })
    await waitFor(
      () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0),
      (n) => n >= 1,
    )
    await me.request({ type: 'send', to: 'cli', text: 'second' })
    const lines = await waitFor(
      () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
      (l) => l.length >= 2,
    )
    const first = JSON.parse(lines[0] as string) as string[]
    const second = JSON.parse(lines[1] as string) as string[]
    expect(first).toContain('--cwd')
    expect(first.at(-1)).toContain('first')
    expect(first.at(-1)).toContain('authority') // the rendered batch, data-framed
    expect(second.slice(0, 3)).toEqual(['exec', '--resume', 'sess-42'])
    // nothing the CLI printed was treated as a reply
    expect(store.history('dm:cli|me', 10).filter((m) => m.from === 'cli')).toHaveLength(0)
    me.close()
  }, 30_000)

  it('console actions: pause / resume / send / cancel; metrics and audit reflect it', async () => {
    const me = await human()
    await me.request({ type: 'join', room: 'ops' })
    // pause then bots are refused, resume lifts it
    const paused = await fetch(`${http}/api/console/rooms/ops/pause`, {
      method: 'POST',
      headers: humanHeaders(),
    })
    expect(await paused.json()).toEqual({ paused: true })
    expect(store.getRoom('ops')?.paused).toBe(true)
    const resumed = await fetch(`${http}/api/console/rooms/ops/resume`, {
      method: 'POST',
      headers: humanHeaders(),
    })
    expect(await resumed.json()).toEqual({ resumed: true })
    expect(store.getRoom('ops')?.paused).toBe(false)
    // speak as the human from the console
    const sent = await fetch(`${http}/api/console/rooms/ops/send`, {
      method: 'POST',
      headers: humanHeaders(),
      body: JSON.stringify({ text: 'from the console' }),
    })
    expect(((await sent.json()) as { message: Message }).message).toMatchObject({
      from: 'me',
      authority: 'human',
      room: 'ops',
    })
    // bots cannot use the console write API
    const bot = await fetch(`${http}/api/console/rooms/ops/pause`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.alpha}`, 'x-agentbus-name': 'alpha' },
    })
    expect(bot.status).toBe(401)
    // cancel a task from the console
    const t = bus.tasks.create({ name: 'me' }, { to: 'alpha', description: 'to be canceled' })
    const canceled = await fetch(`${http}/api/console/tasks/${t.id}/cancel`, {
      method: 'POST',
      headers: humanHeaders(),
      body: JSON.stringify({ reason: 'console' }),
    })
    expect(((await canceled.json()) as { task: { state: string } }).task.state).toBe('canceled')

    const metrics = await (await fetch(`${http}/metrics`)).text()
    expect(metrics).toContain('agentbus_tasks_total{state="canceled"} 1')
    expect(metrics).toContain('agentbus_events_total{kind="paused"} 1')
    expect(metrics).toMatch(/agentbus_deliveries_total\{via="mailbox",state="written"\} \d+/)

    // audit export through the CLI against the same database file
    store.db.pragma('wal_checkpoint(TRUNCATE)')
    const audit = await execFileP(process.execPath, [
      CLI_BIN,
      'audit',
      '--since',
      '1h',
      '--data-dir',
      dataDir,
    ])
    const records = audit.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { record: string })
    expect(records.map((r) => r.record)).toEqual(
      expect.arrayContaining(['message', 'event', 'task', 'task_event']),
    )
    me.close()
  }, 30_000)
})
