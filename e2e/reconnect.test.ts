import { Adapter } from '@agentbus/adapter'
import { Bus, generateToken, hashToken, loadConfig, Store, WsServer } from '@agentbus/core'
import { afterEach, describe, expect, it } from 'vitest'

/** A session outlives bus restarts: the adapter must get back on by itself. */
describe('adapter reconnect', () => {
  const servers: WsServer[] = []
  const adapters: Adapter[] = []

  afterEach(async () => {
    for (const a of adapters.splice(0)) await a.close()
    for (const s of servers.splice(0)) await s.close().catch(() => undefined)
  })

  async function startBus(
    port: number,
    store: Store,
  ): Promise<{ server: WsServer; port: number; bus: Bus }> {
    const bus = new Bus(store, loadConfig({ guard: { min_interval_ms: 0 } }))
    const server = new WsServer(bus, { bind: '127.0.0.1', port, tickMs: 500 })
    const r = await server.listen()
    servers.push(server)
    return { server, port: r.port, bus }
  }

  async function waitFor<T>(fn: () => T, pred: (v: T) => boolean, ms = 10_000): Promise<T> {
    const t0 = Date.now()
    for (;;) {
      const v = fn()
      if (pred(v)) return v
      if (Date.now() - t0 > ms) throw new Error(`timeout; last ${JSON.stringify(v)}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  it('re-registers after the bus restarts and the tools work again', async () => {
    const store = new Store(':memory:')
    const token = generateToken()
    store.createAgent({ name: 'alpha', token_hash: hashToken(token) })
    const first = await startBus(0, store)
    const log: string[] = []
    const adapter = new Adapter({
      bus: `ws://127.0.0.1:${first.port}/ws`,
      name: 'alpha',
      token,
      role: 'control',
      log: (l) => log.push(l),
    })
    adapters.push(adapter)
    await adapter.connect()
    expect(first.bus.agents().find((a) => a.name === 'alpha')?.online).toBe(true)

    // the bus goes away (e.g. `agentbus up --build`) …
    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)
    await waitFor(
      () => adapter.connected,
      (c) => c === false,
    )
    // … and comes back on the same port with the same store
    const second = await startBus(first.port, store)
    await waitFor(
      () => adapter.connected,
      (c) => c === true,
      15_000,
    )
    expect(log.some((l) => l.includes('reconnected'))).toBe(true)
    expect(second.bus.agents().find((a) => a.name === 'alpha')?.online).toBe(true)
    // a tool call goes through the fresh connection
    const r = await adapter.client.request<{ agents: { name: string }[] }>({ type: 'agents' })
    expect(r.agents.map((a) => a.name)).toContain('alpha')
  }, 30_000)

  it('explains a name held by someone else and keeps waiting', async () => {
    const store = new Store(':memory:')
    const token = generateToken()
    store.createAgent({ name: 'alpha', token_hash: hashToken(token) })
    const { port, bus } = await startBus(0, store)
    // a driver already holds alpha/control
    const holder = new Adapter({
      bus: `ws://127.0.0.1:${port}/ws`,
      name: 'alpha',
      token,
      role: 'control',
      log: () => undefined,
    })
    adapters.push(holder)
    await holder.connect()
    const log: string[] = []
    const late = new Adapter({
      bus: `ws://127.0.0.1:${port}/ws`,
      name: 'alpha',
      token,
      role: 'control',
      log: (l) => log.push(l),
    })
    adapters.push(late)
    await expect(late.connect()).rejects.toMatchObject({ code: 'name_taken' })
    expect(bus.registry.controls('alpha')).toHaveLength(1)
  })
})
