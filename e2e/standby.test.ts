import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BusClient } from '@agentbus/core'
import type { Delivery, Message, Task } from '@agentbus/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Standby: a joined directory whose person does not read in time is answered by a hosted
 * session of the same directory. `agentbus up` runs one standby driver per
 * `~/.agentbus/agents/<name>.standby` and hot-loads new ones on request; here the hosted
 * session is the fake ACP agent, so no model is involved.
 *
 *   pipa  — interactive session online (a control connection that never reads), standby in
 *           `task` mode: a task from tita is executed by the standby
 *   juno  — standby in `echo` mode: a dm from tita is answered by the standby, and juno's
 *           hook / inbox show the row once as "already handled"
 */
const execFileP = promisify(execFile)
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const CLI_BIN = here('../packages/cli/dist/bin.js')
const FAKE_AGENT = here('./dist/fake-agent.js')
const fwd = (p: string) => p.replace(/\\/g, '/')

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 20_000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (pred(v)) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout; last: ${JSON.stringify(v).slice(0, 400)}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

describe('standby e2e', () => {
  let up: ChildProcess
  let root: string
  let port = 0
  let log = ''
  let env: Record<string, string>
  let owner = ''
  const live: BusClient[] = []

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'agentbus-standby-'))
    for (const d of ['data', 'home', 'home/agents', 'pipa', 'tita', 'juno'])
      mkdirSync(join(root, d))
    env = { ...(process.env as Record<string, string>), AGENTBUS_HOME: join(root, 'home') }
    writeFileSync(
      join(root, 'agentbus.yaml'),
      `port: 0\ndata_dir: '${fwd(join(root, 'data'))}'\nstandby:\n  delay_s: 1\n`,
    )
    up = spawn(
      process.execPath,
      [CLI_BIN, 'up', '-c', join(root, 'agentbus.yaml'), '-d', join(root, 'none.yaml')],
      { stdio: ['ignore', 'ignore', 'pipe'], env },
    )
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`up did not start:\n${log}`)), 30_000)
      up.stderr?.on('data', (d) => {
        log += d.toString()
        const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)\/ws/.exec(log)
        if (m) port = Number(m[1])
        if (port && log.includes('[up] standby:')) {
          clearTimeout(t)
          resolve()
        }
      })
      up.once('exit', (code) => reject(new Error(`up exited ${code}:\n${log}`)))
    })
    owner = readFileSync(join(root, 'data', 'owner.token'), 'utf8').trim()
  }, 40_000)

  afterAll(async () => {
    for (const c of live) c.close()
    up?.kill()
    await new Promise((r) => setTimeout(r, 1500))
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // sqlite handle may linger on Windows
    }
  })

  const bus = () => `ws://127.0.0.1:${port}/ws`
  const http = () => `http://127.0.0.1:${port}`
  const ownerHeaders = () => ({ authorization: `Bearer ${owner}`, 'x-agentbus-name': 'owner' })
  const run = (args: string[], cwd: string) =>
    execFileP(process.execPath, [CLI_BIN, ...args], { env, cwd })

  /** What `agentbus join` leaves behind, minus the host CLI: token, bus and (for some) a standby file. */
  async function mint(name: string, standby?: { mode: string }): Promise<string> {
    const r = await fetch(`${http()}/api/console/agents`, {
      method: 'POST',
      headers: { ...ownerHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ name, authority: 'relayer', rotate: true }),
    })
    const { token } = (await r.json()) as { token: string }
    writeFileSync(join(root, 'home', 'agents', `${name}.token`), `${token}\n`)
    writeFileSync(join(root, 'home', 'agents', `${name}.bus`), `${bus()}\n`)
    if (standby)
      writeFileSync(
        join(root, 'home', 'agents', `${name}.standby`),
        JSON.stringify({
          host: 'codex',
          backend: 'acp',
          cwd: join(root, name),
          autonomy: 'full',
          bus: bus(),
          acp: {
            command: process.execPath,
            args: [FAKE_AGENT],
            env: { FAKE_AGENT_MODE: standby.mode },
          },
          batch_window_ms: 100,
          joined_at: Date.now(),
        }),
      )
    return token
  }

  async function reload(): Promise<{ name: string; state: string; error?: string }[]> {
    const r = await fetch(`${http()}/api/console/standby/reload`, {
      method: 'POST',
      headers: ownerHeaders(),
    })
    expect(r.status).toBe(200)
    return ((await r.json()) as { standby: { name: string; state: string }[] }).standby
  }

  async function roomState(
    room: string,
  ): Promise<{ messages: Message[]; deliveries: Record<string, Delivery[]> }> {
    const r = await fetch(`${http()}/api/console/rooms/${encodeURIComponent(room)}/messages`, {
      headers: ownerHeaders(),
    })
    return (await r.json()) as { messages: Message[]; deliveries: Record<string, Delivery[]> }
  }

  /** The person's interactive session: connected, but never reads (nobody at the keyboard). */
  async function idleSession(name: string, token: string): Promise<BusClient> {
    const c = new BusClient(bus())
    await c.connect()
    await c.request({
      type: 'register',
      name,
      token,
      role: 'control',
      capabilities: { inbox: true, push: false },
      backend: 'codex',
    })
    live.push(c)
    return c
  }

  it('reload hot-loads standby drivers for registered directories; unregistering stops them', async () => {
    expect(log).toContain('[up] standby: none yet')
    expect(await reload()).toEqual([])
    await mint('tita')
    const pipaToken = await mint('pipa', { mode: 'task' })
    await mint('juno', { mode: 'echo' })
    const st = await reload()
    expect(st.map((s) => `${s.name}:${s.state}`).sort()).toEqual(['juno:running', 'pipa:running'])
    expect(log).toContain('[standby pipa] ready')
    expect(log).toContain('[standby juno] ready')
    const status = await fetch(`${http()}/api/console/standby`, { headers: ownerHeaders() })
    expect(((await status.json()) as { standby: unknown[] }).standby).toHaveLength(2)
    // the names are online through their standby; the interactive session can still join under the same name
    await idleSession('pipa', pipaToken)
    const who = await run(['whoami'], join(root, 'pipa'))
    expect(who.stdout).toContain('pipa (relayer) · online')
    expect(who.stdout).toContain('standby: on')
    expect(who.stdout).toContain('juno [standby]')
    // a human token is required
    const anon = await fetch(`${http()}/api/console/standby/reload`, { method: 'POST' })
    expect(anon.status).toBe(401)
  }, 60_000)

  it('a dm nobody reads in time is answered by the standby; the person sees it once, flagged', async () => {
    const sent = await run(
      ['send', '--to', 'juno', 'hello juno', '--bus', bus()],
      join(root, 'tita'),
    )
    expect(sent.stdout).toMatch(/juno:mailbox\/written/)
    const room = 'dm:juno|tita'
    // after delay_s the row goes to the standby, which echoes it back as juno
    const { messages, deliveries } = await waitFor(
      () => roomState(room),
      (s) => s.messages.some((m) => m.from === 'juno' && m.text === 'echo: hello juno'),
    )
    const original = messages.find((m) => m.from === 'tita') as Message
    expect(deliveries[String(original.id)]?.find((d) => d.recipient === 'juno')).toMatchObject({
      via: 'standby',
      state: 'handled',
    })
    // tita gets the reply the normal way
    const titaInbox = await run(['inbox', '--bus', bus()], join(root, 'tita'))
    expect(titaInbox.stdout).toContain('echo: hello juno')

    // juno's person comes back: the hook shows the handled row once, as information
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
      p.stdin.end(JSON.stringify({ cwd: join(root, 'juno'), prompt: 'hi' }))
    })
    const ctx = (JSON.parse(hookRun) as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext
    expect(ctx).toContain('ALREADY HANDLED by the standby')
    expect(ctx).toContain('hello juno')
    expect(ctx).not.toContain('arrived for you') // not presented as something to answer
    // shown once: the agent's own inbox has nothing new and no standby section any more
    const junoInbox = await run(['inbox', '--bus', bus()], join(root, 'juno'))
    expect(junoInbox.stdout).toContain('no new messages')
    expect(junoInbox.stdout).not.toContain('already handled')
  }, 60_000)

  it('a row the person reads in time stays theirs', async () => {
    await run(['send', '--to', 'juno', 'quick one', '--bus', bus()], join(root, 'tita'))
    const junoInbox = await run(['inbox', '--bus', bus()], join(root, 'juno'))
    expect(junoInbox.stdout).toContain('quick one')
    await new Promise((r) => setTimeout(r, 2500))
    const { messages } = await roomState('dm:juno|tita')
    expect(messages.filter((m) => m.text === 'echo: quick one')).toHaveLength(0)
  }, 30_000)

  it('a task to a directory whose person is away is executed by the standby to completed', async () => {
    const created = await run(
      ['task', 'create', '--to', 'pipa', 'build the thing', '--bus', bus()],
      join(root, 'tita'),
    )
    const taskId = /task (t_[a-z0-9]+)/.exec(created.stdout)?.[1] as string
    expect(taskId).toBeTruthy()
    const task = await waitFor(
      async () => {
        const r = await fetch(`${http()}/api/console/tasks/${taskId}`, { headers: ownerHeaders() })
        return ((await r.json()) as { task: Task }).task
      },
      (t) => t?.state === 'completed',
      30_000,
    )
    expect(task.artifacts.length).toBeGreaterThan(0) // the fake executor attaches a result file
    // the task-create row: handed to the standby, handled when it reported
    const { messages, deliveries } = await roomState('dm:pipa|tita')
    const create = messages.find((m) => m.from === 'tita' && m.text.includes(taskId)) as Message
    expect(deliveries[String(create.id)]?.find((d) => d.recipient === 'pipa')).toMatchObject({
      via: 'standby',
      state: 'handled',
    })
    // the dispatcher saw working and completed
    const titaInbox = await run(['inbox', '--bus', bus()], join(root, 'tita'))
    expect(titaInbox.stdout).toContain('submitted → working')
    expect(titaInbox.stdout).toContain('working → completed')
    // pipa's person: the task row shown once under "already handled", nothing to answer, nothing twice
    const first = await run(['inbox', '--bus', bus()], join(root, 'pipa'))
    expect(first.stdout).toContain('no new messages')
    expect(first.stdout).toContain('already handled by your standby')
    expect(first.stdout).toContain(taskId)
    const second = await run(['inbox', '--bus', bus()], join(root, 'pipa'))
    expect(second.stdout).not.toContain('already handled')
    expect(log).toMatch(/\[standby pipa\] \d+ msg/)
  }, 60_000)

  it('removing the registration stops the driver on the next reload', async () => {
    unlinkSync(join(root, 'home', 'agents', 'juno.standby'))
    const st = await reload()
    expect(st.map((s) => s.name)).toEqual(['pipa'])
    expect(log).toContain('[standby juno] stopping (unregistered)')
    await run(['send', '--to', 'juno', 'anyone there', '--bus', bus()], join(root, 'tita'))
    await new Promise((r) => setTimeout(r, 2500))
    const { messages } = await roomState('dm:juno|tita')
    expect(messages.some((m) => m.text === 'echo: anyone there')).toBe(false)
  }, 30_000)
})
