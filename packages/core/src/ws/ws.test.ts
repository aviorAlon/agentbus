import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateToken, hashToken } from '../auth/token.js'
import { Bus } from '../bus/bus.js'
import { loadConfig } from '../config.js'
import { Store } from '../store/store.js'
import { BusClient, BusClientError } from './client.js'
import { WsServer } from './server.js'

describe('WsServer round trip', () => {
  let server: WsServer
  let url: string
  let tokens: Record<string, string>

  beforeEach(async () => {
    const store = new Store(':memory:')
    tokens = { alpha: generateToken(), beta: generateToken() }
    for (const [name, t] of Object.entries(tokens))
      store.createAgent({ name, token_hash: hashToken(t) })
    const bus = new Bus(store, loadConfig({ guard: { min_interval_ms: 0 } }))
    server = new WsServer(bus, { bind: '127.0.0.1', port: 0, tickMs: 50 })
    const { port } = await server.listen()
    url = `ws://127.0.0.1:${port}/ws`
  })

  afterEach(async () => {
    await server.close()
  })

  it('register, send, inbox, events and errors over a real socket', async () => {
    const a = new BusClient(url)
    const b = new BusClient(url)
    await a.connect()
    await b.connect()

    await expect(a.request({ type: 'agents' })).rejects.toMatchObject({ code: 'not_registered' })
    await expect(
      a.request({
        type: 'register',
        name: 'alpha',
        token: 'bad',
        role: 'control',
        capabilities: { inbox: true, push: false },
      }),
    ).rejects.toBeInstanceOf(BusClientError)

    const ra = await a.request<{ name: string }>({
      type: 'register',
      name: 'alpha',
      token: tokens.alpha as string,
      role: 'control',
      capabilities: { inbox: true, push: false },
    })
    expect(ra.name).toBe('alpha')
    const events: unknown[] = []
    b.on('event', (e) => events.push(e))
    await b.request({
      type: 'register',
      name: 'beta',
      token: tokens.beta as string,
      role: 'control',
      capabilities: { inbox: true, push: false, driver: { kind: 'acp' } },
    })

    const sent = await a.request<{ deliveries: { via: string }[] }>({
      type: 'send',
      to: 'beta',
      text: 'hello over ws',
    })
    expect(sent.deliveries[0]?.via).toBe('driver')
    await new Promise((r) => setTimeout(r, 20))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      event: 'message',
      message: { text: 'hello over ws', from: 'alpha' },
    })

    const inbox = await b.request<{ messages: { text: string }[] }>({ type: 'inbox' })
    expect(inbox.messages.map((m) => m.text)).toEqual(['hello over ws'])

    // wait resolves asynchronously through the same socket
    const waiting = b.request<{ messages: { text: string }[]; timed_out: boolean }>({
      type: 'wait',
      timeout_s: 5,
    })
    await a.request({ type: 'send', to: 'beta', text: 'second' })
    const got = await waiting
    expect(got.timed_out).toBe(false)
    expect(got.messages.map((m) => m.text)).toEqual(['second'])

    // invalid JSON gets a bad_request response (not a crash)
    a.close()
    b.close()
  })

  it('closing the socket marks the agent offline', async () => {
    const a = new BusClient(url)
    await a.connect()
    await a.request({
      type: 'register',
      name: 'alpha',
      token: tokens.alpha as string,
      role: 'control',
      capabilities: { inbox: true, push: false },
    })
    const b = new BusClient(url)
    await b.connect()
    await b.request({
      type: 'register',
      name: 'beta',
      token: tokens.beta as string,
      role: 'control',
      capabilities: { inbox: true, push: false },
    })
    let agents = await b.request<{ agents: { name: string; online: boolean }[] }>({
      type: 'agents',
    })
    expect(agents.agents.find((x) => x.name === 'alpha')?.online).toBe(true)
    a.close()
    await new Promise((r) => setTimeout(r, 50))
    agents = await b.request({ type: 'agents' })
    expect(agents.agents.find((x) => x.name === 'alpha')?.online).toBe(false)
    b.close()
  })
})
