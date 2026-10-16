import { describe, expect, it } from 'vitest'
import { generateToken, hashToken, verifyToken } from './token.js'

describe('token', () => {
  it('generates distinct prefixed tokens', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).toMatch(/^ab_[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })

  it('hash verifies only the original', () => {
    const t = generateToken()
    const h = hashToken(t)
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(verifyToken(t, h)).toBe(true)
    expect(verifyToken(`${t}x`, h)).toBe(false)
    expect(verifyToken(t, 'garbage')).toBe(false)
  })
})
