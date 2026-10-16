import { describe, expect, it } from 'vitest'
import { parseClientFrame } from './frames.js'
import { dmRoom, isValidRoom } from './names.js'

describe('frames', () => {
  it('register defaults role and capabilities', () => {
    const f = parseClientFrame({ id: '1', type: 'register', name: 'alpha', token: 't' })
    expect(f.type).toBe('register')
    if (f.type === 'register') {
      expect(f.role).toBe('control')
      expect(f.capabilities).toEqual({ inbox: false, push: false })
    }
  })

  it('send requires exactly one of room/to', () => {
    expect(() => parseClientFrame({ id: '1', type: 'send', text: 'hi' })).toThrow()
    expect(() =>
      parseClientFrame({ id: '1', type: 'send', text: 'hi', room: 'r', to: 'b' }),
    ).toThrow()
    expect(parseClientFrame({ id: '1', type: 'send', text: 'hi', to: 'beta' }).type).toBe('send')
  })

  it('rejects unknown frame types and bad names', () => {
    expect(() => parseClientFrame({ id: '1', type: 'nope' })).toThrow()
    expect(() =>
      parseClientFrame({ id: '1', type: 'register', name: 'Bad Name', token: 't' }),
    ).toThrow()
  })
})

describe('names', () => {
  it('dm room is order independent and valid', () => {
    expect(dmRoom('beta', 'alpha')).toBe('dm:alpha|beta')
    expect(isValidRoom('dm:alpha|beta')).toBe(true)
    expect(isValidRoom('dm:beta|alpha')).toBe(false)
    expect(isValidRoom('design-sync')).toBe(true)
    expect(isValidRoom('Design')).toBe(false)
  })
})
