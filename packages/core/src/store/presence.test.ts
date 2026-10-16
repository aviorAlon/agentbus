import { describe, expect, it } from 'vitest'
import { ACTIVITY_WINDOW_MS, EXPLICIT_STATE_TTL_MS, Store } from './store.js'

describe('presence synthesis', () => {
  it('explicit > activity > idle > unknown, and waiting never counts', () => {
    let t = 1_000_000
    const s = new Store(':memory:', { clock: () => t })
    s.createAgent({ name: 'a', token_hash: 'h' })
    const row = () => s.getAgent('a') as NonNullable<ReturnType<Store['getAgent']>>

    expect(s.presence(row(), false, t)).toBe('unknown')
    expect(s.presence(row(), true, t)).toBe('idle') // online, nothing known

    s.touchActivity('a')
    expect(s.presence(row(), true, t)).toBe('working')
    expect(s.presence(row(), true, t + ACTIVITY_WINDOW_MS + 1)).toBe('idle')

    t += 1000
    s.setAgentState('a', 'blocked', 'waiting for a human')
    expect(s.presence(row(), true, t)).toBe('blocked')
    // explicit state goes stale eventually
    expect(s.presence(row(), true, t + EXPLICIT_STATE_TTL_MS + 1)).toBe('idle')

    // newer activity supersedes the explicit report
    t += 1000
    s.touchActivity('a')
    expect(s.presence(row(), true, t)).toBe('working')
  })
})
