import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BlobStore,
  Bus,
  generateToken,
  hashToken,
  loadConfig,
  Store,
  WsServer,
} from '@agentbus/core'
import { AcpBackend, Driver } from '@agentbus/driver'
import type { Task } from '@agentbus/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

/** M2 acceptance: review-agent style hand-off, budget, console snapshot + stream. */

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const FAKE_AGENT = here('./dist/fake-agent.js')
const CLI_BIN = here('../packages/cli/dist/bin.js')

async function waitFor<T>(
  fn: () => T | Promise<T>,
  pred: (v: T) => boolean,
  ms = 15_000,
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (pred(v)) return v
    if (Date.now() - t0 > ms)
      throw new Error(`timeout; last value: ${JSON.stringify(v).slice(0, 300)}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}
const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content[0]?.text ?? ''

describe('M2 e2e', () => {
  let store: Store
  let bus: Bus
  let server: WsServer
  let url: string
  let http: string
  let dataDir: string
  const tokens: Record<string, string> = {}
  const drivers: Driver[] = []
  const mcpClients: Client[] = []

  beforeEach(async () => {
    expect(existsSync(FAKE_AGENT) && existsSync(CLI_BIN), 'build first').toBe(true)
    dataDir = mkdtempSync(join(tmpdir(), 'agentbus-m2-'))
    store = new Store(':memory:')
    for (const [name, authority] of [
      ['me', 'human'],
      ['review', 'bot'],
      ['fixer', 'bot'],
      ['idle', 'bot'],
    ] as const) {
      tokens[name] = generateToken()
      store.createAgent({ name, token_hash: hashToken(tokens[name] as string), authority })
    }
    bus = new Bus(
      store,
      loadConfig({ guard: { min_interval_ms: 0 }, tasks: { deadline_s: 3600, max_turns: 30 } }),
    )
    const blobs = new BlobStore(join(dataDir, 'blobs'), store, {
      maxBytes: 1 << 20,
      quotaBytes: 10 << 20,
    })
    server = new WsServer(bus, { bind: '127.0.0.1', port: 0, tickMs: 300, blobs })
    const { port } = await server.listen()
    url = `ws://127.0.0.1:${port}/ws`
    http = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await Promise.all(mcpClients.splice(0).map((c) => c.close().catch(() => undefined)))
    await Promise.all(drivers.splice(0).map((d) => d.stop()))
    await server.close()
    store.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  async function adapterFor(name: string, cwd: string): Promise<Client> {
    mkdirSync(cwd, { recursive: true })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_BIN, 'agent', '--bus', url, '--name', name, '--role', 'control'],
      env: { ...(process.env as Record<string, string>), AGENTBUS_TOKEN: tokens[name] as string },
      cwd,
      stderr: 'inherit',
    })
    const client = new Client({ name: `host-${name}`, version: '0' })
    await client.connect(transport)
    mcpClients.push(client)
    return client
  }

  async function startDriver(name: string, mode: string): Promise<Driver> {
    const cwd = join(dataDir, name)
    mkdirSync(cwd, { recursive: true })
    const d = new Driver({
      bus: url,
      name,
      token: tokens[name] as string,
      backendName: 'acp',
      cwd,
      backend: new AcpBackend({
        command: process.execPath,
        args: [FAKE_AGENT],
        env: { FAKE_AGENT_MODE: mode },
        autonomy: 'full',
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
    return d
  }

  it('review agent hands a finding to a fixer; the fixer completes with an artifact; the board shows it', async () => {
    await startDriver('fixer', 'task')
    const review = await adapterFor('review', join(dataDir, 'review'))

    const created = textOf(
      await review.callTool({
        name: 'task_create',
        arguments: {
          to: 'fixer',
          description: 'finding #1: null check missing in parse()',
          context: 'file src/parse.ts line 42',
          max_turns: 10,
        },
      }),
    )
    expect(created).toMatch(
      /created task t_[a-z0-9]+ \[submitted\] review → fixer in dm:fixer\|review/,
    )
    const taskId = /task (t_[a-z0-9]+)/.exec(created)?.[1] as string

    const task = await waitFor(
      () => store.getTask(taskId) as Task,
      (t) => t.state === 'completed',
      20_000,
    )
    expect(task.summary).toBe('done')
    expect(task.artifacts).toHaveLength(1)
    expect(task.artifacts[0]?.name).toBe(`result-${taskId}.txt`)
    expect(store.taskEvents(taskId).map((e) => e.to_state)).toEqual([
      'submitted',
      'working',
      'completed',
    ])

    // the dispatcher sees the board through its own tool
    const board = textOf(await review.callTool({ name: 'tasks', arguments: { open_only: false } }))
    expect(board.split('\n')[1]).toContain(
      `${taskId}|completed|review|fixer|dm:fixer${String.fromCharCode(92)}|review|`,
    )
    // ...and can fetch the artifact
    const files = textOf(
      await review.callTool({ name: 'list_files', arguments: { room: 'dm:fixer|review' } }),
    )
    expect(files).toContain(`result-${taskId}.txt`)
    // driver turns were recorded
    await waitFor(
      () => store.recentTurns(10, 'fixer').length,
      (n) => n >= 1,
    )
  }, 40_000)

  it('a task to an unresponsive agent fails on its deadline and the thread closes', async () => {
    const review = await adapterFor('review', join(dataDir, 'review'))
    const created = textOf(
      await review.callTool({
        name: 'task_create',
        arguments: { to: 'idle', description: 'never answered', deadline_s: 1 },
      }),
    )
    const taskId = /task (t_[a-z0-9]+)/.exec(created)?.[1] as string
    const t = await waitFor(
      () => store.getTask(taskId) as Task,
      (t) => t.state === 'failed',
      10_000,
    )
    expect(t.summary).toContain('deadline')
    const refused = textOf(
      await review.callTool({
        name: 'send',
        arguments: { to: 'idle', text: 'hello?', task_id: taskId },
      }),
    )
    expect(refused).toContain('error')
    expect(refused).toContain('failed')
  }, 20_000)

  it('console snapshot and stream are human-only and reflect tasks', async () => {
    const human = { authorization: `Bearer ${tokens.me}`, 'x-agentbus-name': 'me' }
    const bot = { authorization: `Bearer ${tokens.review}`, 'x-agentbus-name': 'review' }
    expect((await fetch(`${http}/api/console/snapshot`, { headers: bot })).status).toBe(401)

    const events: unknown[] = []
    const ws = new WebSocket(`${url.replace('/ws', '/console')}?name=me&token=${tokens.me}`)
    ws.on('message', (d) => events.push(JSON.parse(d.toString())))
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res())
      ws.once('error', rej)
    })
    const botWs = new WebSocket(
      `${url.replace('/ws', '/console')}?name=review&token=${tokens.review}`,
    )
    await new Promise<void>((res) => {
      botWs.once('error', () => res())
      botWs.once('unexpected-response', () => res())
    })

    const review = await adapterFor('review', join(dataDir, 'review'))
    const created = textOf(
      await review.callTool({
        name: 'task_create',
        arguments: { to: 'idle', description: 'show me on the board' },
      }),
    )
    const taskId = /task (t_[a-z0-9]+)/.exec(created)?.[1] as string

    const snap = (await (
      await fetch(`${http}/api/console/snapshot`, { headers: human })
    ).json()) as { agents: unknown[]; rooms: { name: string }[]; tasks: Task[] }
    expect(snap.tasks.map((t) => t.id)).toContain(taskId)
    expect(snap.rooms.map((r) => r.name)).toContain('dm:idle|review')
    const detail = (await (
      await fetch(`${http}/api/console/tasks/${taskId}`, { headers: human })
    ).json()) as { task: Task; events: unknown[] }
    expect(detail.events).toHaveLength(1)
    const hist = (await (
      await fetch(`${http}/api/console/rooms/${encodeURIComponent('dm:idle|review')}/messages`, {
        headers: human,
      })
    ).json()) as { messages: unknown[]; deliveries: Record<string, unknown[]> }
    expect(hist.messages).toHaveLength(1)

    await waitFor(
      () => events.filter((e) => (e as { event?: string }).event === 'task').length,
      (n) => n >= 1,
    )
    expect(events.some((e) => (e as { type?: string }).type === 'hello')).toBe(true)
    expect(events.some((e) => (e as { event?: string }).event === 'message')).toBe(true)
    expect(events.some((e) => (e as { event?: string }).event === 'presence')).toBe(true)
    ws.close()
  }, 20_000)
})
