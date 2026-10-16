import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BlobStore,
  Bus,
  BusClient,
  generateToken,
  hashToken,
  loadConfig,
  Store,
  WsServer,
} from '@agentbus/core'
import { AcpBackend, Driver } from '@agentbus/driver'
import type { Message } from '@agentbus/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** M1 acceptance: wait_for_message, autonomy: ask → human, file transfer, HTTP participants, hook. */

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const FAKE_AGENT = here('./dist/fake-agent.js')
const CLI_BIN = here('../packages/cli/dist/bin.js')

async function waitFor<T>(
  fn: () => T | Promise<T>,
  pred: (v: T) => boolean,
  ms = 15_000,
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (pred(v)) return v
    if (Date.now() - t0 > ms)
      throw new Error(`timeout; last value: ${JSON.stringify(v).slice(0, 300)}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

const textOf = (r: unknown): string =>
  (r as { content: { type: string; text?: string }[] }).content[0]?.text ?? ''

describe('M1 e2e', () => {
  let store: Store
  let bus: Bus
  let server: WsServer
  let url: string
  let http: string
  let dataDir: string
  const tokens: Record<string, string> = {}
  const drivers: Driver[] = []
  const mcpClients: Client[] = []

  beforeEach(async () => {
    expect(existsSync(FAKE_AGENT) && existsSync(CLI_BIN), 'build first').toBe(true)
    dataDir = mkdtempSync(join(tmpdir(), 'agentbus-m1-'))
    store = new Store(':memory:')
    for (const [name, authority] of [
      ['me', 'human'],
      ['alpha', 'bot'],
      ['beta', 'bot'],
      ['gamma', 'bot'],
    ] as const) {
      tokens[name] = generateToken()
      store.createAgent({ name, token_hash: hashToken(tokens[name] as string), authority })
    }
    bus = new Bus(store, loadConfig({ guard: { min_interval_ms: 0 } }))
    const blobs = new BlobStore(join(dataDir, 'blobs'), store, {
      maxBytes: 1 << 20,
      quotaBytes: 10 << 20,
    })
    server = new WsServer(bus, { bind: '127.0.0.1', port: 0, tickMs: 500, blobs })
    const { port } = await server.listen()
    url = `ws://127.0.0.1:${port}/ws`
    http = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await Promise.all(mcpClients.splice(0).map((c) => c.close().catch(() => undefined)))
    await Promise.all(drivers.splice(0).map((d) => d.stop()))
    await server.close()
    store.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  /** An "interactive" agent: the real adapter driven through an MCP client, like a host would. */
  async function adapterFor(name: string, cwd: string): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_BIN, 'agent', '--bus', url, '--name', name, '--role', 'control'],
      env: {
        ...(process.env as Record<string, string>),
        AGENTBUS_TOKEN: tokens[name] as string,
        AGENTBUS_MAX_WAIT_S: '3',
      },
      cwd,
      stderr: 'inherit',
    })
    const client = new Client({ name: `host-${name}`, version: '0' })
    await client.connect(transport)
    mcpClients.push(client)
    return client
  }

  async function human(): Promise<BusClient> {
    const c = new BusClient(url)
    await c.connect()
    await c.request({
      type: 'register',
      name: 'me',
      token: tokens.me as string,
      role: 'control',
      capabilities: { inbox: true, push: false },
    })
    return c
  }

  it('wait_for_message blocks, returns the message, and caps at the host limit', async () => {
    const alpha = await adapterFor('alpha', dataDir)
    const tools = await alpha.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      'ack',
      'agents',
      'get_file',
      'history',
      'inbox',
      'join',
      'leave',
      'list_files',
      'put_file',
      'rooms',
      'send',
      'status',
      'task_cancel',
      'task_create',
      'task_update',
      'tasks',
      'wait_for_message',
    ])
    // capped wait with nothing arriving
    const t0 = Date.now()
    const empty = textOf(
      await alpha.callTool({ name: 'wait_for_message', arguments: { timeout_s: 30 } }),
    )
    expect(Date.now() - t0).toBeLessThan(6000)
    expect(empty).toMatch(/no message within 3s.*capped from 30s/)
    // presence: waiting is not working
    expect(bus.agents().find((a) => a.name === 'alpha')?.state).toBe('idle')

    const me = await human()
    const waiting = alpha.callTool({ name: 'wait_for_message', arguments: { timeout_s: 3 } })
    await new Promise((r) => setTimeout(r, 200))
    await me.request({ type: 'send', to: 'alpha', text: 'wake up' })
    const got = textOf(await waiting)
    expect(got).toContain('wake up')
    expect(got).toContain('authority')
    // alpha replies → its activity shows as working
    await alpha.callTool({ name: 'send', arguments: { to: 'me', text: 'awake' } })
    expect(bus.agents().find((a) => a.name === 'alpha')?.state).toBe('working')
    me.close()
  }, 30_000)

  it('autonomy: ask routes a permission request to the human and back', async () => {
    const d = new Driver({
      bus: url,
      name: 'gamma',
      token: tokens.gamma as string,
      backendName: 'acp',
      cwd: dataDir,
      backend: new AcpBackend({
        command: process.execPath,
        args: [FAKE_AGENT],
        env: { FAKE_AGENT_MODE: 'permission' },
        autonomy: 'ask',
        log: () => undefined,
      }),
      adapterCommand: { command: process.execPath, args: [CLI_BIN, 'agent'] },
      batchWindowMs: 100,
      turnTimeoutMs: 20_000,
      maxAttempts: 1,
      permissionTimeoutMs: 15_000,
      log: (l) => process.stderr.write(`${l}\n`),
    })
    drivers.push(d)
    await d.start()
    const me = await human()
    await me.request({ type: 'send', to: 'gamma', text: 'do the thing' })

    // The driver asks the human in the dm, as an input-required style message.
    const ask = await waitFor(
      () => store.history('dm:gamma|me', 20),
      (h) =>
        h.some(
          (m) =>
            m.from === 'gamma' &&
            (m.payload as { kind?: string } | undefined)?.kind === 'permission_request',
        ),
    )
    const q = ask.find(
      (m) => (m.payload as { kind?: string } | undefined)?.kind === 'permission_request',
    ) as Message
    expect(q.text).toContain('write secret.txt')
    expect(q.text).toContain('1. Allow once')
    expect(bus.agents().find((a) => a.name === 'gamma')?.state).toBe('blocked')

    // A nonsense answer is bounced, then "1" is accepted.
    // Something that is not an answer is not bounced: it waits for the agent's next turn.
    await me.request({ type: 'send', to: 'gamma', text: 'maybe?' })
    await new Promise((r) => setTimeout(r, 300))
    expect(
      store.history('dm:gamma|me', 20).some((m) => m.text.includes('did not understand')),
    ).toBe(false)
    await me.request({ type: 'send', to: 'gamma', text: '1' })

    const done = await waitFor(
      () => store.history('dm:gamma|me', 20),
      (h) => h.some((m) => m.from === 'gamma' && m.text.startsWith('echo: do the thing')),
      20_000,
    )
    expect(done.some((m) => m.text === 'echo: do the thing [perm:allow]')).toBe(true)
    // The permission answers were consumed by the broker, not fed to the model as a new batch.
    expect(
      store.history('dm:gamma|me', 20).filter((m) => m.text.startsWith('echo: 1')),
    ).toHaveLength(0)
    me.close()
  }, 40_000)

  it('files travel alpha → beta through put_file / send / list_files / get_file', async () => {
    const alphaCwd = join(dataDir, 'alpha')
    const betaCwd = join(dataDir, 'beta')
    for (const d of [alphaCwd, betaCwd]) mkdirSync(d, { recursive: true })
    writeFileSync(join(dataDir, 'notes.md'), '# plan\n1. agree\n2. ship\n')
    const alpha = await adapterFor('alpha', alphaCwd)
    const beta = await adapterFor('beta', betaCwd)

    const put = textOf(
      await alpha.callTool({ name: 'put_file', arguments: { path: join(dataDir, 'notes.md') } }),
    )
    const [, row] = put.split('\n')
    const [id, name, size] = (row as string).split('|')
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(name).toBe('notes.md')
    expect(Number(size)).toBe(24)

    const sent = textOf(
      await alpha.callTool({
        name: 'send',
        arguments: { to: 'beta', text: 'here is the plan', blobs: [{ id, name }] },
      }),
    )
    expect(sent).toContain('beta:mailbox/written')

    const inbox = textOf(await beta.callTool({ name: 'inbox', arguments: {} }))
    expect(inbox).toContain('notes.md:')
    const list = textOf(
      await beta.callTool({ name: 'list_files', arguments: { room: 'dm:alpha|beta' } }),
    )
    expect(list).toContain(`${id}|notes.md|24`)

    const dest = textOf(await beta.callTool({ name: 'get_file', arguments: { blob_id: id, name } }))
    expect(dest.replace(/\\/g, '/')).toBe(
      join(betaCwd, '.agentbus', 'inbox', (id as string).slice(0, 12), 'notes.md').replace(
        /\\/g,
        '/',
      ),
    )
    expect(readFileSync(dest, 'utf8')).toBe('# plan\n1. agree\n2. ship\n')

    // path traversal in the name is neutralised
    const evil = textOf(
      await beta.callTool({
        name: 'get_file',
        arguments: { blob_id: id, name: '../../escape.md' },
      }),
    )
    expect(evil.replace(/\\/g, '/')).toContain('/.agentbus/inbox/')
    expect(evil).not.toContain('..')
  }, 30_000)

  it('hook user-prompt-submit prints unread messages as additional context', async () => {
    const me = await human()
    await me.request({ type: 'send', to: 'alpha', text: 'hook me' })
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const out = await run(process.execPath, [
      CLI_BIN,
      'hook',
      'user-prompt-submit',
      '--bus',
      url,
      '--name',
      'alpha',
      '--token',
      tokens.alpha as string,
    ])
    const parsed = JSON.parse(out.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string }
    }
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('hook me')
    // the hook only peeks: the row is still unread, so the agent's own inbox call shows it
    // (and a row the model ignored comes back at the next prompt instead of being lost)
    const hookArgs = [
      CLI_BIN,
      'hook',
      'user-prompt-submit',
      '--bus',
      url,
      '--name',
      'alpha',
      '--token',
      tokens.alpha as string,
    ]
    const again = await run(process.execPath, hookArgs)
    expect(again.stdout).toContain('hook me')
    const alpha = new BusClient(url)
    await alpha.connect()
    await alpha.request({
      type: 'register',
      name: 'alpha',
      token: tokens.alpha as string,
      role: 'tool',
    })
    const own = await alpha.request<{ messages: { text: string }[] }>({ type: 'inbox' })
    expect(own.messages.map((m) => m.text)).toContain('hook me')
    alpha.close()
    // now it is seen: nothing new → no output, exit 0
    const third = await run(process.execPath, hookArgs)
    expect(third.stdout).toBe('')
    me.close()
  }, 20_000)

  it('participants HTTP API lets a token-only client talk', async () => {
    const h = {
      authorization: `Bearer ${tokens.beta}`,
      'x-agentbus-name': 'beta',
      'content-type': 'application/json',
    }
    const me = await human()
    const r = await fetch(`${http}/api/participants/send`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ to: 'me', text: 'from http' }),
    })
    expect(r.status).toBe(200)
    const got = await me.request<{ messages: Message[] }>({ type: 'wait', timeout_s: 5 })
    expect(got.messages.map((m) => m.text)).toEqual(['from http'])
    await me.request({ type: 'send', to: 'beta', text: 'back to http' })
    const recv = (await (
      await fetch(`${http}/api/participants/receive?timeout_s=5`, { headers: h })
    ).json()) as { messages: Message[] }
    expect(recv.messages.map((m) => m.text)).toEqual(['back to http'])
    me.close()
  }, 20_000)
})
