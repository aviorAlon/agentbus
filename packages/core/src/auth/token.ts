import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Per-agent tokens (F-S1). Plaintext appears once at issue time; the store keeps
 * `scrypt$<salt>$<hash>`. scrypt is built into Node, so no native dependency.
 */

const N = 16384
const KEYLEN = 32

export function generateToken(): string {
  // 32 random bytes, url-safe base64, prefixed so it is recognisable in logs.
  return `ab_${randomBytes(32).toString('base64url')}`
}

/** One-time invite code: random, high entropy, hashed with plain sha256 (no need for scrypt). */
export function generateInviteCode(): string {
  return `inv_${randomBytes(18).toString('base64url')}`
}

export function hashInviteCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

export function hashToken(token: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(token, salt, KEYLEN, { N })
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export function verifyToken(token: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !parts[1] || !parts[2]) return false
  const salt = Buffer.from(parts[1], 'base64url')
  const expected = Buffer.from(parts[2], 'base64url')
  const actual = scryptSync(token, salt, expected.length, { N })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
