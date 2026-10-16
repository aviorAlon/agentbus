import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/** `agentbus up`: bus + drivers in one process, tokens minted automatically; `agentbus ping`. */
const execFileP = promisify(execFile)
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const CLI_BIN = here('../packages/cli/dist/bin.js')
const FAKE_AGENT = here('./dist/fake-agent.js')
const fwd = (p: string) => p.replace(/\\/g, '/')

describe('agentbus up', () => {
  let up: ChildProcess
  let dataDir: string
  let port = 0
  let log = ''

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'agentbus-up-'))
    mkdirSync(join(dataDir, 'work'))
    writeFileSync(join(dataDir, 'agentbus.yaml'), `port: 0\ndata_dir: '${fwd(dataDir)}'\n`)
    writeFileSync(
      join(dataDir, 'drivers.yaml'),
      `bus: unused-when-up\nagents:\n  - name: gamma\n    backend: acp\n    cwd: '${fwd(join(dataDir, 'work'))}'\n    batch_window_ms: 100\n    acp:\n      command: '${fwd(process.execPath)}'\n      args: ['${fwd(FAKE_AGENT)}']\n      env:\n        FAKE_AGENT_MODE: echo\n`,
    )
    up = spawn(
      process.execPath,
      [CLI_BIN, 'up', '-c', join(dataDir, 'agentbus.yaml'), '-d', join(dataDir, 'drivers.yaml')],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`up did not become ready:\n${log}`)), 40_000)
      up.stderr?.on('data', (d) => {
        log += d.toString()
        const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)\/ws/.exec(log)
        if (m) port = Number(m[1])
        if (port && log.includes('[up] ready')) {
          clearTimeout(t)
          resolve()
        }
      })
      up.once('exit', (code) => reject(new Error(`up exited ${code}:\n${log}`)))
    })
  }, 60_000)

  afterAll(async () => {
    up.kill()
    await new Promise((r) => setTimeout(r, 1500))
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      // sqlite handle may linger briefly on Windows
    }
  })

  it('mints the agent token itself and reports readiness', () => {
    expect(log).toContain('[up] gamma: created')
    expect(log).toMatch(/\[up\] ready: gamma/)
    expect(log).toMatch(/owner token/)
  })

  it('ping gets an answer from the driver-held agent through the same process', async () => {
    const r = await execFileP(process.execPath, [
      CLI_BIN,
      'ping',
      'gamma',
      '--bus',
      `ws://127.0.0.1:${port}/ws`,
      '--data-dir',
      dataDir,
      '--timeout',
      '30',
    ])
    expect(r.stdout).toMatch(/^gamma replied in \d+\.\ds: echo: ping/)
  }, 40_000)

  it('ping fails loudly for an agent that never answers', async () => {
    await execFileP(process.execPath, [
      CLI_BIN,
      'token',
      'create',
      '--name',
      'mute',
      '--data-dir',
      dataDir,
    ])
    await expect(
      execFileP(process.execPath, [
        CLI_BIN,
        'ping',
        'mute',
        '--bus',
        `ws://127.0.0.1:${port}/ws`,
        '--data-dir',
        dataDir,
        '--timeout',
        '2',
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('did not reply within 2s') })
  }, 20_000)
})
