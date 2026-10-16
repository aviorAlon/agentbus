import type { ServerFrame } from '@agentbus/protocol'
import { describe, expect, it } from 'vitest'
import { generateToken, hashToken } from '../auth/token.js'
import { loadConfig } from '../config.js'
import { Store } from '../store/store.js'
import { Bus, isPendingResponse } from './bus.js'
import type { Connection } from './registry.js'

class FakeConn implements Connection {
  frames: ServerFrame[] = []
  send(f: ServerFrame): void {
    this.frames.push(f)
  }
  close(): void {}
}

/** A human opens several terminals: every one must stay connected and hear the bus. */
describe('humans with several control sessions', () => {
  it('registers all, delivers to all, resolves every parked wait, stays online until the last leaves', () => {
    const store = new Store(':memory:')
    const bus = new Bus(store, loadConfig({ guard: { min_interval_ms: 0 } }))
    const tokens: Record<string, string> = {}
    for (const [name, authority] of [
      ['me', 'human'],
      ['alpha', 'bot'],
    ] as const) {
      tokens[name] = generateToken()
      store.createAgent({ name, token_hash: hashToken(tokens[name] as string), authority })
    }
    let seq = 0
    const call = (c: Connection, f: Record<string, unknown>) =>
      bus.handleRaw(c, { id: String(++seq), ...f })
    const reg = (c: Connection, name: string) =>
      call(c, {
        type: 'register',
        name,
        token: tokens[name],
        role: 'control',
        capabilities: { inbox: true, push: false },
      })

    const chat = new FakeConn()
    const tasks = new FakeConn()
    const tail = new FakeConn()
    expect(reg(chat, 'me').ok).toBe(true)
    expect(reg(tasks, 'me').ok).toBe(true) // second window: allowed for humans
    expect(reg(tail, 'me').ok).toBe(true)
    expect(bus.registry.controls('me')).toHaveLength(3)
    // bots still get exactly one
    const a1 = new FakeConn()
    const a2 = new FakeConn()
    expect(reg(a1, 'alpha').ok).toBe(true)
    expect(reg(a2, 'alpha')).toMatchObject({ ok: false, error: { code: 'name_taken' } })

    // two windows park a wait, the third does not
    expect(isPendingResponse(call(chat, { type: 'wait', timeout_s: 5 }))).toBe(true)
    expect(isPendingResponse(call(tail, { type: 'wait', timeout_s: 5 }))).toBe(true)
    const r = call(a1, { type: 'send', to: 'me', text: 'hello human' })
    expect(r.ok).toBe(true)
    expect(
      (r as { result: { deliveries: { via: string; state: string }[] } }).result.deliveries[0],
    ).toMatchObject({ via: 'wait', state: 'seen' })
    const got = (c: FakeConn) => c.frames.filter((f) => f.type === 'response')
    expect(got(chat)).toHaveLength(1)
    expect(got(tail)).toHaveLength(1)
    // only one of them actually receives the message body (the cursor moved once); the other sees an empty batch
    const texts = [...got(chat), ...got(tail)].flatMap((f) =>
      ((f as { result: { messages: { text: string }[] } }).result.messages ?? []).map(
        (m) => m.text,
      ),
    )
    expect(texts).toEqual(['hello human'])

    // system broadcasts reach every window
    bus.pause('dm:alpha|me', 'me')
    for (const c of [chat, tasks, tail])
      expect(c.frames.some((f) => f.type === 'event' && f.event === 'system')).toBe(true)

    // closing two windows keeps the human online; closing the last takes it offline
    bus.disconnect(chat)
    bus.disconnect(tasks)
    expect(bus.agents().find((a) => a.name === 'me')?.online).toBe(true)
    bus.disconnect(tail)
    expect(bus.agents().find((a) => a.name === 'me')?.online).toBe(false)
  })
})
