import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Bus,
  BusClient,
  generateToken,
  hashToken,
  loadConfig,
  Store,
  WsServer,
} from '@agentbus/core'
import { AcpBackend, Driver } from '@agentbus/driver'
import type { Message } from '@agentbus/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * End-to-end: bus + driver + fake ACP agent + MCP adapter in tool role.
 * Needs `tsc -b` first (the fake agent and the adapter run from dist/).
 */

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

describe('driver e2e', () => {
  let store: Store
  let bus: Bus
  let server: WsServer
  let url: string
  const tokens: Record<string, string> = {}
  const drivers: Driver[] = []

  beforeEach(async () => {
    expect(existsSync(FAKE_AGENT), `build first: ${FAKE_AGENT}`).toBe(true)
    expect(existsSync(CLI_BIN), `build first: ${CLI_BIN}`).toBe(true)
    store = new Store(':memory:')
    for (const [name, authority] of [
      ['me', 'human'],
      ['gamma', 'bot'],
      ['delta', 'bot'],
    ] as const) {
      tokens[name] = generateToken()
      store.createAgent({ name, token_hash: hashToken(tokens[name] as string), authority })
    }
    bus = new Bus(store, loadConfig({ guard: { cap: 6, min_interval_ms: 0 } }))
    server = new WsServer(bus, { bind: '127.0.0.1', port: 0, tickMs: 500 })
    const { port } = await server.listen()
    url = `ws://127.0.0.1:${port}/ws`
  })

  afterEach(async () => {
    await Promise.all(drivers.splice(0).map((d) => d.stop()))
    await server.close()
    store.close()
  })

  function startDriver(name: string, mode = 'echo', batchWindowMs = 200): Promise<Driver> {
    const marker = join(mkdtempSync(join(tmpdir(), 'agentbus-e2e-')), 'crashed')
    const d = new Driver({
      bus: url,
      name,
      token: tokens[name] as string,
      backendName: 'acp',
      cwd: process.cwd(),
      backend: new AcpBackend({
        command: process.execPath,
        args: [FAKE_AGENT],
        env: { FAKE_AGENT_MODE: mode, FAKE_AGENT_CRASH_MARKER: marker },
        autonomy: 'full',
        log: () => undefined,
      }),
      adapterCommand: { command: process.execPath, args: [CLI_BIN, 'agent'] },
      batchWindowMs,
      turnTimeoutMs: 20_000,
      maxAttempts: 3,
      log: (l) => process.stderr.write(`${l}\n`),
    })
    drivers.push(d)
    return d.start().then(() => d)
  }

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

  it('a human dm wakes the driver; the agent replies through the adapter; delivery reaches handled', async () => {
    await startDriver('gamma')
    const me = await human()
    const sent = await me.request<{ message: Message }>({
      type: 'send',
      to: 'gamma',
      text: 'hello gamma',
    })

    const reply = await waitFor(
      () => store.history('dm:gamma|me', 10),
      (h) => h.some((m) => m.from === 'gamma' && m.text === 'echo: hello gamma'),
    )
    expect(reply.map((m) => m.from)).toEqual(['me', 'gamma'])
    // gamma's send marks what it received as handled; the human's cursor still shows the reply unseen.
    expect(store.getDelivery(sent.message.id, 'gamma')?.state).toBe('handled')
    const inbox = await me.request<{ messages: Message[] }>({ type: 'inbox' })
    expect(inbox.messages.map((m) => m.text)).toEqual(['echo: hello gamma'])
    const agents = bus.agents()
    expect(agents.find((a) => a.name === 'gamma')).toMatchObject({
      online: true,
      capabilities: { driver: { kind: 'acp' } },
    })
    me.close()
  }, 30_000)

  it('two driver agents echo until the guard pauses the room', async () => {
    await startDriver('gamma')
    await startDriver('delta')
    const me = await human()
    await me.request({ type: 'join', room: 'loop' })
    // Both bots must be members for delivery; a human kicks it off.
    bus.store.addMember('loop', 'gamma')
    bus.store.addMember('loop', 'delta')
    await me.request({ type: 'send', room: 'loop', text: 'go' })

    await waitFor(
      () => store.getRoom('loop')?.paused ?? false,
      (p) => p === true,
      25_000,
    )
    const bots = store.history('loop', 100).filter((m) => m.authority === 'bot')
    expect(bots.length).toBe(6) // exactly cap bot messages since the human spoke
    expect(store.events().some((e) => e.kind === 'paused' && e.room === 'loop')).toBe(true)
    me.close()
  }, 40_000)

  it('recovers when the backend process dies mid-turn and still answers', async () => {
    await startDriver('gamma', 'crash-once')
    const me = await human()
    await me.request({ type: 'send', to: 'gamma', text: 'survive this' })
    const h = await waitFor(
      () => store.history('dm:gamma|me', 10),
      (h) => h.some((m) => m.from === 'gamma'),
      25_000,
    )
    expect(h.at(-1)?.text).toBe('echo: survive this')
    me.close()
  }, 40_000)
})
