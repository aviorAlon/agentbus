import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * `agentbus join` / `leave` against the real host CLIs, isolated through
 * CLAUDE_CONFIG_DIR and CODEX_HOME so the user's own configs are never touched.
 */
const execFileP = promisify(execFile)
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const CLI_BIN = here('../packages/cli/dist/bin.js')
const fwd = (p: string) => p.replace(/\\/g, '/')

function hasCli(name: string): boolean {
  try {
    execFileSync(name, ['--version'], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    })
    return true
  } catch {
    return false
  }
}
const HAS_CLAUDE = hasCli('claude')
const HAS_CODEX = hasCli('codex')

describe('agentbus join / leave', () => {
  let up: ChildProcess
  let root: string
  let port = 0
  let log = ''
  let env: Record<string, string>

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'agentbus-join-'))
    for (const d of [
      'data',
      'claude-config',
      'codex-home',
      'agentbus-home',
      'proj-frontend',
      'proj-backend',
    ])
      mkdirSync(join(root, d))
    env = {
      ...(process.env as Record<string, string>),
      CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
      CODEX_HOME: join(root, 'codex-home'),
      AGENTBUS_HOME: join(root, 'agentbus-home'),
    }
    up = spawn(
      process.execPath,
      [
        CLI_BIN,
        'up',
        '-d',
        join(root, 'drivers.yaml'),
        '--port',
        '0',
        '--data-dir',
        join(root, 'data'),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env },
    )
    // no drivers: an empty agents list is rejected by the schema, so give `up` a harmless one? No: use serve-like path via a minimal drivers file.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`up did not start:\n${log}`)), 30_000)
      up.stderr?.on('data', (d) => {
        log += d.toString()
        const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)\/ws/.exec(log)
        if (m) port = Number(m[1])
        if (port && /\[up\] ready|error:/.test(log)) {
          clearTimeout(t)
          resolve()
        }
      })
      up.once('exit', (code) => {
        if (!port) reject(new Error(`up exited ${code}:\n${log}`))
      })
    })
  }, 40_000)

  afterAll(async () => {
    up?.kill()
    await new Promise((r) => setTimeout(r, 1000))
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // sqlite handle may linger briefly on Windows
    }
  })

  const bus = () => `ws://127.0.0.1:${port}/ws`
  const run = (args: string[]) => execFileP(process.execPath, [CLI_BIN, ...args], { env })

  it.skipIf(!HAS_CLAUDE)(
    'join --claude mints a token, configures the project and installs the hook; leave undoes it',
    async () => {
      const dir = join(root, 'proj-frontend')
      const r = await run([
        'join',
        '--claude',
        '--dir',
        dir,
        '--bus',
        bus(),
        '--data-dir',
        join(root, 'data'),
      ])
      expect(r.stdout).toContain('joined as "proj-frontend" (claude, relayer)')
      expect(existsSync(join(root, 'agentbus-home', 'agents', 'proj-frontend.token'))).toBe(true)
      const settings = JSON.parse(
        readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'),
      ) as { hooks: { UserPromptSubmit: { hooks: { command: string }[] }[] } }
      expect(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toContain(
        'hook user-prompt-submit',
      )
      const listed = await execFileP('claude', ['mcp', 'get', 'agentbus'], {
        cwd: dir,
        env,
        shell: process.platform === 'win32',
      })
      expect(listed.stdout).toContain('agentbus')
      // the agent exists on the bus as a relayer (online only if the standby driver already came up)
      const status = await run(['status', '--bus', bus(), '--data-dir', join(root, 'data')])
      expect(status.stdout).toMatch(/proj-frontend\|claude-code\|relayer\|(true|false)/)
      // standby is the default: the directory is registered for hosting and `up` was told
      const standbyFile = join(root, 'agentbus-home', 'agents', 'proj-frontend.standby')
      expect(existsSync(standbyFile)).toBe(true)
      expect(JSON.parse(readFileSync(standbyFile, 'utf8'))).toMatchObject({
        host: 'claude',
        backend: 'claude-code',
        cwd: dir,
        autonomy: 'full',
        bus: bus(),
      })
      expect(r.stdout).toMatch(/standby: (running|starting|failed|registered)/)
      // --no-standby takes the registration back
      const off = await run([
        'join',
        '--claude',
        '--dir',
        dir,
        '--bus',
        bus(),
        '--data-dir',
        join(root, 'data'),
        '--no-standby',
      ])
      expect(off.stderr).toContain('standby registration removed')
      expect(existsSync(standbyFile)).toBe(false)

      const l = await run(['leave', '--claude', '--dir', dir, '--purge'])
      expect(l.stdout).toContain('left as "proj-frontend"')
      expect(existsSync(join(root, 'agentbus-home', 'agents', 'proj-frontend.token'))).toBe(false)
      await expect(
        execFileP('claude', ['mcp', 'get', 'agentbus'], {
          cwd: dir,
          env,
          shell: process.platform === 'win32',
        }),
      ).rejects.toBeTruthy()
    },
    60_000,
  )

  it.skipIf(!HAS_CODEX)(
    'join --codex writes one global entry; the adapter resolves name and token from the directory',
    async () => {
      const dir = join(root, 'proj-backend')
      const r = await run([
        'join',
        '--codex',
        '--dir',
        dir,
        '--bus',
        bus(),
        '--data-dir',
        join(root, 'data'),
      ])
      expect(r.stdout).toContain('joined as "proj-backend" (codex, relayer)')
      const toml = readFileSync(join(root, 'codex-home', 'config.toml'), 'utf8')
      expect(toml).toContain('[mcp_servers.agentbus]')
      expect(toml).not.toContain('--name') // name comes from the cwd at launch
      expect(r.stdout).toContain('/hooks') // Codex must trust the new hook once
      const hooks = JSON.parse(readFileSync(join(root, 'codex-home', 'hooks.json'), 'utf8')) as {
        hooks: { UserPromptSubmit: { hooks: { command: string }[] }[] }
      }
      const cmd = hooks.hooks.UserPromptSubmit.flatMap((g) => g.hooks).find((h) =>
        h.command.includes('hook user-prompt-submit'),
      )
      expect(cmd?.command).not.toContain('--name') // global: the hook learns the directory from stdin
      // joining a second directory keeps one byte-identical entry (Codex trusts hooks by hash)
      const again = await run([
        'join',
        '--codex',
        '--dir',
        join(root, 'proj-frontend'),
        '--bus',
        bus(),
        '--data-dir',
        join(root, 'data'),
      ])
      expect(again.stderr).toContain('hook already in') // steps are logged to stderr
      // the hook itself: stdin says which directory; bus comes from the join record; messages render with guidance
      const owner = readFileSync(join(root, 'data', 'owner.token'), 'utf8').trim()
      await fetch(
        `http://127.0.0.1:${port}/api/console/rooms/${encodeURIComponent('dm:owner|proj-backend')}/send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${owner}`,
            'x-agentbus-name': 'owner',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ text: 'ping from the console' }),
        },
      )
      const hookRun = await new Promise<string>((res, rej) => {
        const p = spawn(process.execPath, [CLI_BIN, 'hook', 'user-prompt-submit'], {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let out = ''
        p.stdout.on('data', (d) => {
          out += d
        })
        p.on('exit', (code) => (code === 0 ? res(out) : rej(new Error(`hook exited ${code}`))))
        p.stdin.end(JSON.stringify({ cwd: dir, prompt: 'proj-frontend 你那边的接口好了吗' }))
      })
      const ctx = (JSON.parse(hookRun) as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext
      expect(ctx).toContain('ping from the console')
      expect(ctx).toContain('arrived for you (proj-backend)')
      // the prompt names the other joined agent: the hook says so, so the model sends instead of answering
      expect(ctx).toContain('addressed to proj-frontend')
      await run(['leave', '--codex', '--dir', join(root, 'proj-frontend')])
      expect(existsSync(join(root, 'agentbus-home', 'agents', 'proj-frontend.standby'))).toBe(false)
      // the adapter, started the way Codex would start it in that directory, logs in by itself
      const probe = spawn(
        process.execPath,
        [CLI_BIN, 'agent', '--bus', bus(), '--backend', 'codex'],
        { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      let err = ''
      probe.stderr.on('data', (d) => {
        err += d
      })
      await new Promise((r) => setTimeout(r, 2500))
      const status = await run(['status', '--bus', bus(), '--data-dir', join(root, 'data')])
      probe.kill()
      expect(err).not.toContain('no token')
      expect(status.stdout).toMatch(/proj-backend\|codex\|relayer\|true/)
      const l = await run(['leave', '--codex', '--dir', dir])
      expect(l.stdout).toContain('left as "proj-backend"')
      expect(readFileSync(join(root, 'codex-home', 'config.toml'), 'utf8')).not.toContain(
        '[mcp_servers.agentbus]',
      )
      expect(readFileSync(join(root, 'codex-home', 'hooks.json'), 'utf8')).not.toContain(
        'hook user-prompt-submit',
      )
    },
    90_000,
  )

  it('`agentbus invite` prints a join command another machine redeems once, no owner token needed there', async () => {
    const r = await run([
      'invite',
      '--bus',
      bus(),
      '--data-dir',
      join(root, 'data'),
      '--name',
      'laptop',
    ])
    const cmd = r.stdout.trim()
    expect(cmd).toMatch(/^agentbus join --claude --bus ws:\/\/\S+ --invite inv_\S+ --name laptop$/)
    const code = /--invite (\S+)/.exec(cmd)?.[1] ?? ''
    // the other machine has no owner token: the data dir is elsewhere. Redeem by hand like join does.
    const redeem = (body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${port}/api/invites/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const ok = await redeem({ code, backend: 'claude-code' })
    expect(ok.status).toBe(200)
    const got = (await ok.json()) as { name: string; token: string }
    expect(got.name).toBe('laptop')
    expect(got.token.startsWith('ab_')).toBe(true)
    expect((await redeem({ code })).status).toBe(401) // single use
    const status = await run(['status', '--bus', bus(), '--data-dir', join(root, 'data')])
    expect(status.stdout).toMatch(/laptop/)
    // the console learns the public addresses from /api/console/info
    const info = (await (await fetch(`http://127.0.0.1:${port}/api/console/info`)).json()) as {
      bus: string
    }
    expect(cmd).toContain(info.bus)
  }, 30_000)

  it('join through the console API (same machine) returns the steps and next action', async () => {
    const owner = readFileSync(join(root, 'data', 'owner.token'), 'utf8').trim()
    const dir = join(root, 'proj-frontend')
    const r = await fetch(`http://127.0.0.1:${port}/api/console/join`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${owner}`,
        'x-agentbus-name': 'owner',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ host: HAS_CLAUDE ? 'claude' : 'codex', dir, name: 'ui-joined' }),
    })
    if (!HAS_CLAUDE && !HAS_CODEX) {
      expect(r.status).toBe(400)
      return
    }
    expect(r.status).toBe(200)
    const body = (await r.json()) as { name: string; steps: string[]; next: string }
    expect(body.name).toBe('ui-joined')
    expect(body.next).toMatch(/看看 agentbus/)
    // bots cannot use it
    const bot = await fetch(`http://127.0.0.1:${port}/api/console/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(bot.status).toBe(401)
    void fwd
  }, 60_000)
})
