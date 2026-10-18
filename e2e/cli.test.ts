import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execFileP = promisify(execFile)
const CLI_BIN = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url))

/** `agentbus serve` → `token create` → `status` → `history`, all through the real binary. */
describe('cli smoke', () => {
  let serve: ChildProcess
  let dataDir: string
  let busUrl = ''
  let ownerToken = ''
  let stderr = ''

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'agentbus-cli-'))
    serve = spawn(process.execPath, [CLI_BIN, 'serve', '--data-dir', dataDir, '--port', '0'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`serve did not start:\n${stderr}`)), 15_000)
      serve.stderr?.on('data', (d) => {
        stderr += d.toString()
        const m = /listening on (ws:\/\/[^\s]+)/.exec(stderr)
        const tok = /owner token.*: (ab_[A-Za-z0-9_-]+)/.exec(stderr)
        if (m && tok) {
          busUrl = m[1] as string
          ownerToken = tok[1] as string
          clearTimeout(t)
          resolve()
        }
      })
      serve.once('exit', (code) => reject(new Error(`serve exited ${code}:\n${stderr}`)))
    })
  }, 20_000)

  afterAll(async () => {
    const exited = new Promise<void>((r) => serve.once('exit', () => r()))
    serve.kill()
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))])
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      // Windows may still hold the sqlite handle for a moment; the temp dir is harmless.
    }
  })

  it('mints an owner token and serves', () => {
    expect(busUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/)
    expect(ownerToken.startsWith('ab_')).toBe(true)
  })

  it('token create prints a token once; status and history work with the owner token', async () => {
    const created = await execFileP(process.execPath, [
      CLI_BIN,
      'token',
      'create',
      '--name',
      'gamma',
      '--backend',
      'codex',
      '--data-dir',
      dataDir,
    ])
    const gammaToken = created.stdout.trim()
    expect(gammaToken.startsWith('ab_')).toBe(true)
    expect(created.stderr).toContain('not stored in plaintext')

    // duplicate names are refused
    await expect(
      execFileP(process.execPath, [
        CLI_BIN,
        'token',
        'create',
        '--name',
        'gamma',
        '--data-dir',
        dataDir,
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('already exists') })

    const status = await execFileP(process.execPath, [
      CLI_BIN,
      'status',
      '--bus',
      busUrl,
      '--data-dir',
      dataDir,
    ])
    const lines = status.stdout.trim().split('\n')
    expect(lines[0]).toBe('name|backend|authority|online|state|driver|standby|inbox|push')
    expect(lines.some((l) => l.startsWith('gamma|codex|bot|false'))).toBe(true)
    expect(lines.some((l) => l.startsWith('owner||human|true'))).toBe(true)

    // a wrong token is refused by the bus
    await expect(
      execFileP(process.execPath, [
        CLI_BIN,
        'status',
        '--bus',
        busUrl,
        '--token',
        'ab_wrong',
        '--data-dir',
        dataDir,
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('unknown agent or bad token') })

    const history = await execFileP(process.execPath, [
      CLI_BIN,
      'history',
      'dm:gamma|owner',
      '--bus',
      busUrl,
      '--data-dir',
      dataDir,
    ]).catch((e: { stderr: string }) => e)
    // no dm exists yet: unknown_room is the right answer, not a crash
    expect(JSON.stringify(history)).toContain('no room')
  }, 30_000)
})
