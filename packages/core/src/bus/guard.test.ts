import { describe, expect, it } from 'vitest'
import { Guard } from './guard.js'

describe('Guard', () => {
  it('counts bot messages, pauses at cap, human clears', () => {
    const g = new Guard(3, 0)
    expect(g.check('r', 'a', 'bot', 1)).toMatchObject({
      kind: 'allow',
      count: 1,
      reachedCap: false,
    })
    expect(g.check('r', 'b', 'bot', 2)).toMatchObject({ kind: 'allow', count: 2 })
    expect(g.check('r', 'a', 'bot', 3)).toMatchObject({ kind: 'allow', count: 3, reachedCap: true })
    expect(g.check('r', 'b', 'bot', 4)).toEqual({ kind: 'paused', count: 3 })
    expect(g.check('r', 'h', 'human', 5)).toMatchObject({ kind: 'allow', clearedPause: true })
    expect(g.check('r', 'a', 'bot', 6)).toMatchObject({ kind: 'allow', count: 1 })
  })

  it('rate limits per agent without counting', () => {
    const g = new Guard(10, 1000)
    expect(g.check('r', 'a', 'bot', 0).kind).toBe('allow')
    expect(g.check('r', 'a', 'bot', 500)).toEqual({ kind: 'rate_limited', retryInMs: 500 })
    expect(g.check('r', 'b', 'bot', 500).kind).toBe('allow') // other agent unaffected
    expect(g.count('r')).toBe(2)
    expect(g.check('r', 'a', 'bot', 1000).kind).toBe('allow')
  })

  it('exempt messages do not count; relayer clears like human', () => {
    const g = new Guard(2, 0)
    g.check('r', 'a', 'bot', 1, { exempt: true })
    expect(g.count('r')).toBe(0)
    g.check('r', 'a', 'bot', 2)
    g.check('r', 'a', 'bot', 3)
    expect(g.check('r', 'a', 'bot', 4).kind).toBe('paused')
    expect(g.check('r', 'x', 'relayer', 5)).toMatchObject({ kind: 'allow', clearedPause: true })
  })

  it('rehydrates a durable pause and reset lifts it', () => {
    const g = new Guard(5, 0)
    expect(g.check('r', 'a', 'bot', 1, { pausedInStore: true }).kind).toBe('paused')
    expect(g.reset('r')).toBe(true)
    expect(g.check('r', 'a', 'bot', 2).kind).toBe('allow')
  })
})
