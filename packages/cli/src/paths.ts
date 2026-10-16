import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return resolve(p)
}

export function ensureDir(p: string): string {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
  return p
}

export const OWNER_TOKEN_FILE = 'owner.token'

export function readOwnerToken(dataDir: string): string | null {
  const f = join(dataDir, OWNER_TOKEN_FILE)
  if (!existsSync(f)) return null
  return readFileSync(f, 'utf8').trim() || null
}

export function writeOwnerToken(dataDir: string, token: string): void {
  const f = join(dataDir, OWNER_TOKEN_FILE)
  writeFileSync(f, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(f, 0o600)
  } catch {
    // Windows ignores POSIX modes
  }
}
