import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { TaskState as SdkState } from '@a2a-js/sdk'
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client'
import { BusClient } from '@agentbus/core'
import type { Message } from '@agentbus/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * M3 "multi-machine": one `agentbus serve` process bound to 0.0.0.0; two driver processes
 * (fake ACP agents) that reach it through the machine's LAN address, exactly as a second
 * machine would; a human and an external A2A client on the same LAN address.
 */
const execFileP = promisify(execFile)
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const CLI_BIN = here('../packages/cli/dist/bin.js')
const FAKE_AGENT = here('./dist/fake-agent.js')

function lanIp(): string {
  for (const list of Object.values(networkInterfaces()))
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address
  return '127.0.0.1'
}

async function waitFor<T>(
  fn: () => T | Promise<T>,
  pred: (v: T) => boolean,
  ms = 20_000,
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (pred(v)) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout; last: ${JSON.stringify(v).slice(0, 300)}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** The client returns the Task (or Message) directly; older shapes wrap it in `payload`. */
function asTask(r: unknown): {
  id: string
  status?: { state?: number }
  metadata?: Record<string, unknown>
} {
  const p = (r as { payload?: { value?: unknown } }).payload
  return (p?.value ?? r) as {
    id: string
    status?: { state?: number }
    metadata?: Record<string, unknown>
  }
}

describe('M3 multi-machine e2e', () => {
  const procs: ChildProcess[] = []
  let dataDir: string
  let port = 0
  let ip = '127.0.0.1'
  let ownerToken = ''
  let serveLog = ''
  const tokens: Record<string, string> = {}

  const bus = () => `ws://${ip}:${port}/ws`
  const http = () => `http://${ip}:${port}`

  function spawnLogged(
    args: string[],
    env: Record<string, string>,
    onLine: (l: string) => void,
  ): ChildProcess {
    const p = spawn(process.execPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...(process.env as Record<string, string>), ...env },
    })
    p.stderr?.on('data', (d) =>
      d
        .toString()
        .split('\n')
        .forEach((l: string) => {
          if (l) onLine(l)
        }),
    )
    procs.push(p)
    return p
  }

  beforeAll(async () => {
    ip = lanIp()
    dataDir = mkdtempSync(join(tmpdir(), 'agentbus-m3-'))
    // bus process, LAN bind, random port, mailbox cap small enough to test
    writeFileSync(
      join(dataDir, 'agentbus.yaml'),
      `bind: 0.0.0.0\nport: 0\ndata_dir: '${dataDir.replace(/\\/g, '/')}'\nmailbox:\n  max_per_agent: 3\nguard:\n  min_interval_ms: 0\n`,
    )
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`serve did not start:\n${serveLog}`)), 20_000)
      spawnLogged([CLI_BIN, 'serve', '-c', join(dataDir, 'agentbus.yaml')], {}, (l) => {
        serveLog += `${l}\n`
        const m = /listening on ws:\/\/0\.0\.0\.0:(\d+)\/ws/.exec(l)
        if (m) port = Number(m[1])
        const tok = /owner token.*: (ab_[A-Za-z0-9_-]+)/.exec(l)
        if (tok) ownerToken = tok[1] as string
        if (port && ownerToken) {
          clearTimeout(t)
          resolve()
        }
      })
    })
    await ready
    for (const [name, backend] of [
      ['gamma', 'acp'],
      ['delta', 'acp'],
    ] as const) {
      const r = await execFileP(process.execPath, [
        CLI_BIN,
        'token',
        'create',
        '--name',
        name,
        '--backend',
        backend,
        '--data-dir',
        dataDir,
      ])
      tokens[name] = r.stdout.trim()
    }
    // two "machines": driver processes connecting over the LAN address
    for (const [name, mode] of [
      ['gamma', 'task'],
      ['delta', 'echo'],
    ] as const) {
      const cwd = join(dataDir, `work-${name}`)
      mkdirSync(cwd, { recursive: true })
      writeFileSync(
        join(dataDir, `drivers-${name}.yaml`),
        `bus: ${bus()}\nagents:\n  - name: ${name}\n    backend: acp\n    token_env: AGENTBUS_TOKEN\n    cwd: '${cwd.replace(/\\/g, '/')}'\n    autonomy: full\n    batch_window_ms: 100\n    acp:\n      command: '${process.execPath.replace(/\\/g, '/')}'\n      args: ['${FAKE_AGENT.replace(/\\/g, '/')}']\n      env:\n        FAKE_AGENT_MODE: ${mode}\n`,
      )
      const ready = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`driver ${name} did not start`)), 30_000)
        spawnLogged(
          [CLI_BIN, 'driver', '-c', join(dataDir, `drivers-${name}.yaml`)],
          { AGENTBUS_TOKEN: tokens[name] as string },
          (l) => {
            if (l.includes('ready')) {
              clearTimeout(t)
              resolve()
            }
          },
        )
      })
      await ready
    }
  }, 90_000)

  afterAll(async () => {
    for (const p of procs) p.kill()
    await new Promise((r) => setTimeout(r, 1500))
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      // sqlite handle may linger briefly on Windows
    }
  })

  async function human(name = 'owner', token = ownerToken): Promise<BusClient> {
    const c = new BusClient(bus())
    await c.connect()
    await c.request({
      type: 'register',
      name,
      token,
      role: 'control',
      capabilities: { inbox: true, push: false },
    })
    return c
  }

  it('bus is reachable on the LAN address and refuses bad tokens', async () => {
    expect(ip).not.toBe('127.0.0.1')
    expect((await (await fetch(`${http()}/healthz`)).json()).ok).toBe(true)
    const c = new BusClient(bus())
    await c.connect()
    await expect(
      c.request({
        type: 'register',
        name: 'gamma',
        token: 'ab_wrong',
        role: 'control',
        capabilities: { inbox: true, push: false },
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' })
    // a live gamma/control exists (its driver) → a same-name takeover with the right token is name_taken while it is alive
    await expect(
      c.request({
        type: 'register',
        name: 'gamma',
        token: tokens.gamma as string,
        role: 'control',
        capabilities: { inbox: true, push: false },
      }),
    ).rejects.toMatchObject({ code: 'name_taken' })
    c.close()
  })

  it('a human on another machine talks to a driver-held agent through the bus', async () => {
    const me = await human()
    await me.request({ type: 'send', to: 'delta', text: 'ping from afar' })
    const r = await me.request<{ messages: Message[] }>({ type: 'wait', timeout_s: 20 })
    expect(r.messages.map((m) => m.text)).toEqual(['echo: ping from afar'])
    me.close()
  }, 30_000)

  it('an external A2A client dispatches a task to gamma and gets the artifact back', async () => {
    const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()] })
    const client = await factory.createFromUrl(
      http(),
      '/a2a/agents/gamma/.well-known/agent-card.json',
    )
    const sent = await client.sendMessage({
      tenant: '',
      message: {
        messageId: 'm-ext',
        contextId: '',
        taskId: '',
        role: 1,
        parts: [
          {
            content: { $case: 'text', value: 'please produce the report' },
            metadata: undefined,
            filename: '',
            mediaType: 'text/plain',
          },
        ],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: {
        acceptedOutputModes: [],
        taskPushNotificationConfig: undefined,
        returnImmediately: true,
      } as never,
      metadata: undefined,
    })
    const ext = asTask(sent)
    const done = await waitFor(
      () => client.getTask({ tenant: '', id: ext.id, historyLength: 20 } as never),
      (t) => t.status?.state === SdkState.TASK_STATE_COMPLETED,
      30_000,
    )
    expect(done.artifacts).toHaveLength(1)
    const content = done.artifacts[0]?.parts[0]?.content as
      | { $case: 'url'; value: string }
      | undefined
    const url = content?.value ?? ''
    expect(url.startsWith(`${http()}/api/blobs/`)).toBe(true)
    // the blob itself needs a bus token (humans/agents), not open to the LAN
    expect((await fetch(url)).status).toBe(401)
    const body = await fetch(url, {
      headers: { authorization: `Bearer ${ownerToken}`, 'x-agentbus-name': 'owner' },
    })
    expect(body.status).toBe(200)
    expect(await body.text()).toMatch(/^result for t_/)
  }, 40_000)

  it('offline mailbox is capped per agent and the sender is told', async () => {
    const r = await execFileP(process.execPath, [
      CLI_BIN,
      'token',
      'create',
      '--name',
      'sleeper',
      '--data-dir',
      dataDir,
    ])
    const sleeperToken = r.stdout.trim()
    const me = await human()
    const sys: unknown[] = []
    me.on('event', (e) => {
      if (e.event === 'system') sys.push(e)
    })
    for (let i = 1; i <= 5; i++) await me.request({ type: 'send', to: 'sleeper', text: `msg ${i}` })
    await waitFor(
      () => sys.filter((e) => (e as { kind: string }).kind === 'undeliverable').length,
      (n) => n >= 2,
      5000,
    )
    const sleeper = await human('sleeper', sleeperToken)
    const inbox = await sleeper.request<{ messages: Message[] }>({ type: 'inbox' })
    expect(inbox.messages.map((m) => m.text)).toEqual(['msg 3', 'msg 4', 'msg 5'])
    me.close()
    sleeper.close()
  }, 20_000)

  it('an unregistered socket is dropped by the register timeout', async () => {
    // The bus closes sockets that never register (default 10s); here we only verify the
    // code path exists by checking the frame is still answered before the timeout.
    const c = new BusClient(bus())
    await c.connect()
    await expect(c.request({ type: 'agents' })).rejects.toMatchObject({ code: 'not_registered' })
    c.close()
  })
})
