import type { ResponseFrame, ServerFrame } from '@agentbus/protocol'
import { describe, expect, it } from 'vitest'
import { generateToken, hashToken } from '../auth/token.js'
import { loadConfig } from '../config.js'
import { Store } from '../store/store.js'
import { Bus, isPendingResponse } from './bus.js'
import type { Connection } from './registry.js'

class FakeConn implements Connection {
  frames: ServerFrame[] = []
  closed: { code: number; reason: string } | null = null
  send(frame: ServerFrame): void {
    this.frames.push(frame)
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason }
  }
  events(kind?: string): ServerFrame[] {
    return this.frames.filter((f) => f.type === 'event' && (!kind || f.event === kind))
  }
  /** Responses that arrived asynchronously (wait). */
  responses(): ResponseFrame[] {
    return this.frames.filter((f): f is ResponseFrame => f.type === 'response')
  }
}

let now = 1_000_000
const clock = () => now

function setup(cfg: Record<string, unknown> = {}) {
  now = 1_000_000
  const store = new Store(':memory:', { clock })
  const bus = new Bus(store, loadConfig({ guard: { cap: 4, min_interval_ms: 0 }, ...cfg }), clock)
  const tokens = new Map<string, string>()
  const mk = (name: string, authority: 'bot' | 'human' = 'bot') => {
    const t = generateToken()
    tokens.set(name, t)
    store.createAgent({ name, token_hash: hashToken(t), authority })
    return t
  }
  let seq = 0
  const call = (conn: Connection, frame: Record<string, unknown>) =>
    bus.handleRaw(conn, { id: String(++seq), ...frame })
  const ok = (conn: Connection, frame: Record<string, unknown>) => {
    const r = call(conn, frame)
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
    return r.result as Record<string, never>
  }
  const register = (
    conn: Connection,
    name: string,
    caps: Record<string, unknown> = {},
    role = 'control',
  ) =>
    call(conn, {
      type: 'register',
      name,
      token: tokens.get(name),
      role,
      capabilities: { inbox: true, push: false, ...caps },
    })
  return { store, bus, mk, call, ok, register }
}

describe('Bus registration', () => {
  it('rejects unknown agent, bad token, unregistered frames', () => {
    const { mk, call, register } = setup()
    mk('alpha')
    const c = new FakeConn()
    expect(call(c, { type: 'agents' })).toMatchObject({
      ok: false,
      error: { code: 'not_registered' },
    })
    expect(call(c, { type: 'register', name: 'ghost', token: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    })
    expect(call(c, { type: 'register', name: 'alpha', token: 'wrong' })).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    })
    expect(register(c, 'alpha')).toMatchObject({
      ok: true,
      result: { name: 'alpha', role: 'control', took_over: false },
    })
  })

  it('control + tool coexist; same role twice is name_taken; stale is taken over', () => {
    const { mk, register, bus, store } = setup({ heartbeat_timeout_ms: 1000 })
    mk('alpha')
    const ctl = new FakeConn()
    const tool = new FakeConn()
    const dup = new FakeConn()
    expect(register(ctl, 'alpha').ok).toBe(true)
    expect(register(tool, 'alpha', {}, 'tool').ok).toBe(true)
    expect(register(dup, 'alpha')).toMatchObject({ ok: false, error: { code: 'name_taken' } })
    // Old control goes silent past the heartbeat timeout: newcomer takes over.
    now += 5000
    expect(register(dup, 'alpha')).toMatchObject({ ok: true, result: { took_over: true } })
    expect(ctl.closed?.reason).toMatch(/replaced/)
    expect(store.events().some((e) => e.kind === 'takeover')).toBe(true)
    expect(bus.registry.control('alpha')?.conn).toBe(dup)
  })

  it('disconnect marks offline; crash without goodbye is reported as takeover', () => {
    const { mk, register, bus, store } = setup()
    mk('alpha')
    const c = new FakeConn()
    register(c, 'alpha')
    expect(bus.agents()[0]?.online).toBe(true)
    bus.disconnect(c)
    expect(bus.agents()[0]?.online).toBe(false)
    // Simulate crash: DB still says online, no live session.
    store.setAgentOnline('alpha', true)
    expect(register(new FakeConn(), 'alpha')).toMatchObject({
      ok: true,
      result: { took_over: true },
    })
  })
})

describe('Bus rooms and dm', () => {
  it('dm auto-creates with both members; room needs join; human may speak anywhere', () => {
    const { mk, ok, call, register, store } = setup()
    mk('alpha')
    mk('beta')
    mk('me', 'human')
    const a = new FakeConn()
    const b = new FakeConn()
    const h = new FakeConn()
    register(a, 'alpha')
    register(b, 'beta')
    register(h, 'me')

    const sent = ok(a, { type: 'send', to: 'beta', text: 'hi' }) as unknown as {
      message: { room: string }
    }
    expect(sent.message.room).toBe('dm:alpha|beta')
    expect(store.members('dm:alpha|beta')).toEqual(['alpha', 'beta'])
    expect(call(a, { type: 'send', to: 'nobody', text: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'unknown_agent' },
    })

    expect(call(a, { type: 'send', room: 'design', text: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'unknown_room' },
    })
    ok(a, { type: 'join', room: 'design' })
    expect(call(b, { type: 'send', room: 'design', text: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'not_member' },
    })
    expect(call(a, { type: 'join', room: 'Bad Room' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    })
    ok(h, { type: 'send', room: 'design', text: 'human here' })
    expect(store.members('design')).toEqual(['alpha', 'me'])
    const rooms = ok(h, { type: 'rooms' }) as unknown as { rooms: { name: string }[] }
    expect(rooms.rooms.map((r) => r.name).sort()).toEqual(['design', 'dm:alpha|beta'])
  })
})

describe('Bus delivery three-state', () => {
  it('mailbox → inbox (seen) → ack (handled); own messages are excluded from inbox', () => {
    const { mk, ok, register, store } = setup()
    mk('alpha')
    mk('beta')
    const a = new FakeConn()
    register(a, 'alpha')
    // beta is offline: mailbox
    const r1 = ok(a, { type: 'send', to: 'beta', text: 'one' }) as unknown as {
      message: { id: number }
      deliveries: { via: string; state: string }[]
    }
    expect(r1.deliveries).toEqual([
      expect.objectContaining({ recipient: 'beta', via: 'mailbox', state: 'written' }),
    ])
    ok(a, { type: 'send', to: 'beta', text: 'two' })
    expect(store.pendingCount('beta')).toBe(2)

    const b = new FakeConn()
    register(b, 'beta')
    const inbox = ok(b, { type: 'inbox' }) as unknown as {
      messages: { id: number; text: string }[]
    }
    expect(inbox.messages.map((m) => m.text)).toEqual(['one', 'two'])
    expect(store.getDelivery(r1.message.id, 'beta')?.state).toBe('seen')
    expect(store.pendingCount('beta')).toBe(0)
    // second inbox is empty
    expect((ok(b, { type: 'inbox' }) as unknown as { messages: unknown[] }).messages).toEqual([])

    const acked = ok(b, { type: 'ack', message_ids: [r1.message.id] }) as unknown as {
      deliveries: { state: string }[]
    }
    expect(acked.deliveries[0]?.state).toBe('handled')

    // beta replies: its own reply must not show up in its own inbox, but alpha's cursor sees it.
    ok(b, { type: 'send', to: 'alpha', text: 'reply' })
    expect((ok(b, { type: 'inbox' }) as unknown as { messages: unknown[] }).messages).toEqual([])
    const ai = ok(a, { type: 'inbox' }) as unknown as { messages: { text: string }[] }
    expect(ai.messages.map((m) => m.text)).toEqual(['reply'])
  })

  it('driver recipients get a message event immediately and flushed on reconnect', () => {
    const { mk, ok, register, store } = setup()
    mk('alpha')
    mk('gamma')
    const a = new FakeConn()
    register(a, 'alpha')
    // offline while alpha writes
    ok(a, { type: 'send', to: 'gamma', text: 'queued' })
    const g = new FakeConn()
    register(g, 'gamma', { driver: { kind: 'acp' } })
    expect(
      g.events('message').map((e) => (e as { message: { text: string } }).message.text),
    ).toEqual(['queued'])
    const r = ok(a, { type: 'send', to: 'gamma', text: 'live' }) as unknown as {
      deliveries: { via: string }[]
    }
    expect(r.deliveries[0]?.via).toBe('driver')
    expect(g.events('message')).toHaveLength(2)
    // still written until the driver's turn marks seen
    expect(store.pendingCount('gamma')).toBe(2)
    ok(g, { type: 'inbox' })
    expect(store.pendingCount('gamma')).toBe(0)
  })

  it('wait parks and resolves on delivery, or times out', async () => {
    const { mk, ok, call, register } = setup()
    mk('alpha')
    mk('beta')
    const a = new FakeConn()
    const b = new FakeConn()
    register(a, 'alpha')
    register(b, 'beta')
    const parked = call(b, { type: 'wait', timeout_s: 5 })
    expect(isPendingResponse(parked)).toBe(true)
    expect(call(b, { type: 'wait', timeout_s: 5 })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    })

    const r = ok(a, { type: 'send', to: 'beta', text: 'wake' }) as unknown as {
      deliveries: { via: string; state: string }[]
    }
    expect(r.deliveries[0]).toMatchObject({ via: 'wait', state: 'seen' })
    const late = b.responses()
    expect(late).toHaveLength(1)
    expect(late[0]).toMatchObject({
      ok: true,
      result: { timed_out: false, messages: [expect.objectContaining({ text: 'wake' })] },
    })

    // timeout path
    const t0 = call(b, { type: 'wait', timeout_s: 0.01 })
    expect(isPendingResponse(t0)).toBe(true)
    await new Promise((r) => setTimeout(r, 40))
    expect(b.responses().at(-1)).toMatchObject({
      ok: true,
      result: { timed_out: true, messages: [] },
    })

    // immediate path when something is already pending
    ok(a, { type: 'send', to: 'beta', text: 'already' })
    expect(call(b, { type: 'wait', timeout_s: 5 })).toMatchObject({
      ok: true,
      result: { timed_out: false },
    })
  })

  it('wait narrowed to one sender ignores the others and leaves their rows unread', () => {
    const { mk, ok, call, register } = setup()
    mk('alpha')
    mk('beta')
    mk('gamma')
    const a = new FakeConn()
    const b = new FakeConn()
    const g = new FakeConn()
    register(a, 'alpha')
    register(b, 'beta')
    register(g, 'gamma')

    const parked = call(b, { type: 'wait', timeout_s: 5, from: 'alpha' })
    expect(isPendingResponse(parked)).toBe(true)
    // gamma writes: goes to the mailbox, the wait stays parked
    const noise = ok(g, { type: 'send', to: 'beta', text: 'noise' }) as unknown as {
      deliveries: { via: string; state: string }[]
    }
    expect(noise.deliveries[0]).toMatchObject({ via: 'mailbox', state: 'written' })
    expect(b.responses()).toHaveLength(0)
    // alpha writes: the wait resolves with alpha's row only
    ok(a, { type: 'send', to: 'beta', text: 'answer' })
    const late = b.responses()
    expect(late).toHaveLength(1)
    expect(late[0]).toMatchObject({
      ok: true,
      result: { timed_out: false, messages: [expect.objectContaining({ text: 'answer' })] },
    })
    expect((late[0] as { result: { messages: unknown[] } }).result.messages).toHaveLength(1)
    // gamma's row is still unread, alpha's is not shown twice
    const inbox = ok(b, { type: 'inbox' }) as unknown as { messages: { text: string }[] }
    expect(inbox.messages.map((m) => m.text)).toEqual(['noise'])

    // immediate path: both already pending, only alpha's is taken
    ok(g, { type: 'send', to: 'beta', text: 'noise 2' })
    ok(a, { type: 'send', to: 'beta', text: 'answer 2' })
    const now = ok(b, { type: 'wait', timeout_s: 5, from: 'alpha' }) as unknown as {
      messages: { text: string }[]
    }
    expect(now.messages.map((m) => m.text)).toEqual(['answer 2'])
    const rest = ok(b, { type: 'inbox' }) as unknown as { messages: { text: string }[] }
    expect(rest.messages.map((m) => m.text)).toEqual(['noise 2'])
  })
})

describe('Bus guard integration', () => {
  it('pauses the room at cap, notifies members, human resumes', () => {
    const { mk, ok, call, register, store } = setup() // cap 4
    mk('alpha')
    mk('beta')
    mk('me', 'human')
    const a = new FakeConn()
    const b = new FakeConn()
    const h = new FakeConn()
    register(a, 'alpha')
    register(b, 'beta')
    register(h, 'me')
    ok(a, { type: 'join', room: 'loop' })
    ok(b, { type: 'join', room: 'loop' })
    ok(a, { type: 'send', room: 'loop', text: '1' })
    ok(b, { type: 'send', room: 'loop', text: '2' })
    ok(a, { type: 'send', room: 'loop', text: '3' })
    ok(b, { type: 'send', room: 'loop', text: '4' }) // reaches cap → paused
    expect(store.getRoom('loop')?.paused).toBe(true)
    expect(a.events('system').map((e) => (e as { kind: string }).kind)).toContain('paused')
    expect(call(a, { type: 'send', room: 'loop', text: '5' })).toMatchObject({
      ok: false,
      error: { code: 'paused' },
    })

    ok(h, { type: 'send', room: 'loop', text: 'stop it' })
    expect(store.getRoom('loop')?.paused).toBe(false)
    expect(b.events('system').map((e) => (e as { kind: string }).kind)).toContain('resumed')
    expect(call(a, { type: 'send', room: 'loop', text: 'ok' }).ok).toBe(true)
  })

  it('rate limit returns retry_in_ms and does not write', () => {
    const { mk, ok, call, register, store } = setup({ guard: { cap: 20, min_interval_ms: 1000 } })
    mk('alpha')
    mk('beta')
    const a = new FakeConn()
    register(a, 'alpha')
    ok(a, { type: 'send', to: 'beta', text: 'a' })
    const r = call(a, { type: 'send', to: 'beta', text: 'b' })
    expect(r).toMatchObject({ ok: false, error: { code: 'rate_limited', retry_in_ms: 1000 } })
    expect(store.history('dm:alpha|beta', 10)).toHaveLength(1)
    now += 1000
    expect(call(a, { type: 'send', to: 'beta', text: 'b' }).ok).toBe(true)
  })

  it('oversized text is rejected', () => {
    const { mk, call, register } = setup({ message: { max_text_bytes: 10 } })
    mk('alpha')
    mk('beta')
    const a = new FakeConn()
    register(a, 'alpha')
    expect(call(a, { type: 'send', to: 'beta', text: 'x'.repeat(11) })).toMatchObject({
      ok: false,
      error: { code: 'too_large' },
    })
  })
})

describe('Bus housekeeping', () => {
  it('tick expires mailbox past TTL and notifies sender', () => {
    const { mk, ok, register, bus, store } = setup({
      mailbox: { ttl_hours: 1 },
      heartbeat_timeout_ms: 10 * 3_600_000,
    })
    mk('alpha')
    mk('beta')
    const a = new FakeConn()
    register(a, 'alpha')
    ok(a, { type: 'send', to: 'beta', text: 'stale' })
    now += 2 * 3_600_000
    bus.tick()
    expect(store.pendingCount('beta')).toBe(0) // dropped: flagged, no longer pending
    expect(a.events('system').map((e) => (e as { kind: string }).kind)).toContain('undeliverable')
    expect(store.events().some((e) => e.kind === 'undeliverable')).toBe(true)
  })
})
