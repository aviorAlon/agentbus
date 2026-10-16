import { describe, expect, it } from 'vitest'
import { Store } from './store.js'

function mem(): Store {
  let t = 1_000_000
  return new Store(':memory:', { clock: () => t++ })
}

describe('Store', () => {
  it('creates agents, rooms, members', () => {
    const s = mem()
    s.createAgent({ name: 'alpha', token_hash: 'h', authority: 'bot', backend: 'claude-code' })
    expect(s.getAgent('alpha')?.backend).toBe('claude-code')
    expect(() => s.createAgent({ name: 'alpha', token_hash: 'h2' })).toThrow()
    s.ensureRoom('design', 'room')
    expect(s.addMember('design', 'alpha')).toBe(true)
    expect(s.addMember('design', 'alpha')).toBe(false)
    expect(s.isMember('design', 'alpha')).toBe(true)
    expect(s.roomsOf('alpha')).toEqual(['design'])
  })

  it('messages, history and messagesAfter', () => {
    const s = mem()
    s.ensureRoom('r', 'room')
    const ids: number[] = []
    for (let i = 0; i < 5; i++)
      ids.push(s.insertMessage({ room: 'r', from: 'a', authority: 'bot', text: `m${i}` }).id)
    expect(s.history('r', 2).map((m) => m.text)).toEqual(['m3', 'm4'])
    expect(s.history('r', 10, ids[3]).map((m) => m.text)).toEqual(['m0', 'm1', 'm2'])
    expect(s.messagesAfter('r', ids[2] as number, 10).map((m) => m.text)).toEqual(['m3', 'm4'])
    const withPayload = s.insertMessage({
      room: 'r',
      from: 'a',
      authority: 'human',
      text: 'p',
      payload: { k: [1, 2] },
      task_id: 't1',
    })
    expect(s.getMessage(withPayload.id)).toMatchObject({ payload: { k: [1, 2] }, task_id: 't1' })
  })

  it('blob refs attach to messages and bump refcount', () => {
    const s = mem()
    s.ensureRoom('r', 'room')
    const sha = 'a'.repeat(64)
    s.registerBlob(sha, 10, 'text/plain')
    const m = s.insertMessage({
      room: 'r',
      from: 'a',
      authority: 'bot',
      text: 'file',
      blobs: [{ id: sha, name: 'x.txt', size: 10 }],
    })
    expect(m.blobs).toEqual([{ id: sha, name: 'x.txt', size: 10, mime: 'text/plain' }])
    expect(s.getBlob(sha)?.refcount).toBe(1)
  })

  it('cursor is monotonic', () => {
    const s = mem()
    expect(s.getCursor('a', 'r')).toBe(0)
    expect(s.advanceCursor('a', 'r', 5)).toBe(5)
    expect(s.advanceCursor('a', 'r', 3)).toBe(5)
    expect(s.advanceCursor('a', 'r', 9)).toBe(9)
  })

  it('delivery three-state and pending mailbox', () => {
    const s = mem()
    s.ensureRoom('r', 'room')
    const m1 = s.insertMessage({ room: 'r', from: 'a', authority: 'bot', text: '1' })
    const m2 = s.insertMessage({ room: 'r', from: 'a', authority: 'bot', text: '2' })
    const d = s.insertDelivery(m1.id, 'b', 'mailbox')
    expect(d.state).toBe('written')
    s.insertDelivery(m2.id, 'b', 'mailbox')
    expect(s.pendingFor('b').map((m) => m.id)).toEqual([m1.id, m2.id])
    expect(s.pendingCount('b')).toBe(2)

    // re-insert bumps attempts
    expect(s.insertDelivery(m1.id, 'b', 'driver').attempts).toBe(2)

    expect(s.markSeenUpTo('b', 'r', m1.id)).toBe(1)
    expect(s.getDelivery(m1.id, 'b')?.state).toBe('seen')
    expect(s.pendingFor('b').map((m) => m.id)).toEqual([m2.id])

    const h = s.markHandled(m2.id, 'b')
    expect(h?.state).toBe('handled')
    expect(h?.seen_at).not.toBeNull()
    expect(s.pendingCount('b')).toBe(0)
  })

  it('expires old pending deliveries', () => {
    let t = 0
    const s = new Store(':memory:', { clock: () => t })
    s.ensureRoom('r', 'room')
    const m = s.insertMessage({ room: 'r', from: 'a', authority: 'bot', text: 'old' })
    s.insertDelivery(m.id, 'b', 'mailbox')
    t = 10_000
    expect(s.expirePending('b', 5_000)).toEqual([m.id])
    expect(s.getDelivery(m.id, 'b')?.error).toBe('expired')
  })

  it('events are appended and queryable', () => {
    const s = mem()
    s.appendEvent('paused', { count: 20 }, undefined, 'r')
    s.appendEvent('takeover', {}, 'alpha')
    expect(s.events({ room: 'r' })).toHaveLength(1)
    expect(s.events()).toHaveLength(2)
  })
})
