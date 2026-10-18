import { BusClient, BusClientError } from '@agentbus/core'
import type { AgentInfo, InboxResult, Message, Role } from '@agentbus/protocol'
import { encodeRecords } from '@agentbus/protocol'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { httpBaseFromBus } from './files.js'
import { adapterInstructions, renderInbox, renderMessages } from './render.js'
import { registerM1Tools } from './tools-m1.js'
import { registerTaskTools } from './tools-m2.js'

export interface AdapterOptions {
  bus: string
  name: string
  token: string
  role: Role
  backend?: string
  cwd?: string
  version?: string
  /** Declare push capability (Claude Code channel). Off by default (F-A12). */
  push?: boolean
  /** This adapter serves the name's standby driver: `send` / `task_update` act for the standby. */
  standby?: boolean
  log?: (line: string) => void
}

type ToolText = { content: { type: 'text'; text: string }[]; isError?: boolean }

const text = (t: string): ToolText => ({ content: [{ type: 'text', text: t }] })
const fail = (e: unknown): ToolText => ({
  content: [
    {
      type: 'text',
      text:
        e instanceof BusClientError && e.code === 'closed'
          ? 'error: not connected to the bus right now (it may be restarting); the adapter reconnects by itself — try again in a few seconds'
          : e instanceof BusClientError
            ? `error ${e.code}: ${e.message}${e.retryInMs ? ` (retry in ${e.retryInMs}ms)` : ''}`
            : `error: ${(e as Error).message}`,
    },
  ],
  isError: true,
})

/**
 * The MCP stdio adapter (PRODUCT_DESIGN §2.1). One binary for every backend: the
 * host model talks to the bus through these tools; the adapter holds one WS
 * connection to the bus in the given role.
 */
export class Adapter {
  readonly client: BusClient
  readonly server: McpServer
  private readonly log: (line: string) => void

  constructor(private readonly opts: AdapterOptions) {
    this.log = opts.log ?? ((l) => process.stderr.write(`${l}\n`))
    this.client = new BusClient(opts.bus)
    this.server = new McpServer(
      { name: 'agentbus', version: opts.version ?? '0.0.0' },
      {
        instructions: adapterInstructions(opts.name, opts.role, opts.standby === true),
        // Claude Code channels (research preview): declaring this lets the host accept
        // `notifications/claude/channel` from us. Off unless --push on (F-A12).
        ...(opts.push ? { capabilities: { experimental: { 'claude/channel': {} } } } : {}),
      },
    )
    this.registerTools()
    registerM1Tools(this.server, {
      client: this.client,
      http: { base: httpBaseFromBus(opts.bus), name: opts.name, token: opts.token },
      cwd: opts.cwd ?? process.cwd(),
    })
    registerTaskTools(this.server, this.client)
  }

  private closing = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** True between a successful register and the next close. */
  connected = false

  async connect(): Promise<void> {
    this.client.on('event', (e) => {
      if (e.event === 'system')
        this.log(`[agentbus] ${e.kind} ${e.room ?? ''} ${JSON.stringify(e.detail)}`)
      else if (e.event === 'message' && this.opts.push) void this.pushToHost(e.message)
    })
    this.client.on('close', () => {
      this.connected = false
      if (this.closing) return
      this.log('[agentbus] bus connection closed; reconnecting')
      this.scheduleReconnect(1000)
    })
    await this.register()
  }

  private async register(): Promise<void> {
    await this.client.connect()
    await this.client.request({
      type: 'register',
      name: this.opts.name,
      token: this.opts.token,
      role: this.opts.role,
      capabilities: {
        inbox: true,
        push: this.opts.push ?? false,
        ...(this.opts.push ? { push_preview: true } : {}),
        ...(this.opts.standby ? { standby: true } : {}),
      },
      ...(this.opts.backend ? { backend: this.opts.backend } : {}),
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      version: `agentbus-adapter/${this.opts.version ?? '0.0.0'}`,
    })
    this.connected = true
  }

  /**
   * The host session outlives bus restarts (`agentbus up --build`), so the adapter keeps
   * trying to get back on: exponential backoff up to 30s. A `name_taken` means another
   * process (usually a driver hosting the same directory) owns this identity; we keep
   * trying slowly in case it goes away, and say so.
   */
  private scheduleReconnect(delayMs: number): void {
    if (this.closing || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.closing) return
      try {
        await this.register()
        this.log('[agentbus] reconnected')
      } catch (e) {
        const code = e instanceof BusClientError ? e.code : 'error'
        if (code === 'name_taken')
          this.log(
            `[agentbus] "${this.opts.name}" is held by another connection (a driver hosting this directory?); ` +
              'retrying in 30s — use --name for a separate identity',
          )
        else if (code === 'unauthorized')
          this.log('[agentbus] token rejected; run "agentbus join" again in this directory')
        else this.log(`[agentbus] reconnect failed: ${(e as Error).message}`)
        try {
          this.client.close()
        } catch {
          // already closed
        }
        this.scheduleReconnect(Math.min(delayMs * 2, 30_000))
      }
    }, delayMs)
    this.reconnectTimer.unref?.()
  }

  /**
   * push path: inject a bus message into the running interactive session through the
   * channel notification. The host does not acknowledge; the bus marks `seen` only when the
   * model actually pulls `inbox`, and degrades to mailbox after `push.seen_timeout_s`.
   */
  async pushToHost(m: Message): Promise<void> {
    try {
      await this.server.server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: renderMessages([m]),
          meta: { from: m.from, room: m.room, authority: m.authority, message_id: String(m.id) },
        },
      })
      this.pushed += 1
    } catch (e) {
      this.log(`[agentbus] push failed: ${(e as Error).message}`)
    }
  }

  /** Notifications pushed so far (tests / status). */
  pushed = 0

  /**
   * Serve MCP over stdio until the host closes it. When stdin ends (the host
   * session or backend process is gone) the adapter must go away too, otherwise
   * it lingers holding the agent's `tool` connection open (F-R5 would then reject
   * the replacement until the heartbeat timeout).
   */
  async serveStdio(onClosed: () => void = () => process.exit(0)): Promise<void> {
    const transport = new StdioServerTransport()
    let done = false
    const finish = () => {
      if (done) return
      done = true
      this.closing = true
      this.client.close()
      onClosed()
    }
    transport.onclose = finish
    process.stdin.once('end', finish)
    process.stdin.once('close', finish)
    await this.server.connect(transport)
  }

  async close(): Promise<void> {
    this.closing = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.client.close()
    await this.server.close()
  }

  private registerTools(): void {
    const c = this.client
    const s = this.server

    s.registerTool(
      'agents',
      { description: 'List agents on the bus with backend, online state and capabilities.' },
      async () => {
        try {
          const r = await c.request<{ agents: AgentInfo[] }>({ type: 'agents' })
          return text(
            encodeRecords(
              ['name', 'backend', 'authority', 'online', 'state', 'driver', 'inbox', 'push'],
              r.agents.map((a) => ({
                name: a.name,
                backend: a.backend ?? '',
                authority: a.authority,
                online: a.online,
                state: a.state,
                driver: a.capabilities.driver?.kind ?? '',
                inbox: a.capabilities.inbox,
                push: a.capabilities.push,
              })),
            ),
          )
        } catch (e) {
          return fail(e)
        }
      },
    )

    s.registerTool(
      'rooms',
      { description: 'List rooms you are a member of (humans see all rooms).' },
      async () => {
        try {
          const r = await c.request<{
            rooms: { name: string; kind: string; paused: boolean; members: string[] }[]
          }>({ type: 'rooms' })
          return text(
            encodeRecords(
              ['name', 'kind', 'paused', 'members'],
              r.rooms.map((x) => ({ ...x, members: x.members.join(',') })),
            ),
          )
        } catch (e) {
          return fail(e)
        }
      },
    )

    s.registerTool(
      'join',
      {
        description: 'Join (creating if needed) a named room. Room names: [a-z0-9][a-z0-9-]{0,63}.',
        inputSchema: { room: z.string() },
      },
      async ({ room }) => {
        try {
          const r = await c.request<{ room: string; joined: boolean; members: string[] }>({
            type: 'join',
            room,
          })
          return text(`joined ${r.room} (members: ${r.members.join(', ')})`)
        } catch (e) {
          return fail(e)
        }
      },
    )

    s.registerTool(
      'leave',
      {
        description: 'Leave a named room: you stop receiving its messages. (A dm cannot be left.)',
        inputSchema: { room: z.string() },
      },
      async ({ room }) => {
        try {
          const r = await c.request<{ room: string; left: boolean }>({ type: 'leave', room })
          return text(r.left ? `left ${r.room}` : `you were not in ${r.room}`)
        } catch (e) {
          return fail(e)
        }
      },
    )

    s.registerTool(
      'history',
      {
        description: 'Recent messages in a room, oldest first.',
        inputSchema: {
          room: z.string(),
          limit: z.number().int().min(1).max(500).default(50),
        },
      },
      async ({ room, limit }) => {
        try {
          const r = await c.request<{ messages: Message[] }>({ type: 'history', room, limit })
          return text(renderMessages(r.messages))
        } catch (e) {
          return fail(e)
        }
      },
    )

    s.registerTool(
      'inbox',
      {
        description:
          'Pull every message that arrived since your last turn (all rooms) and mark them seen. Call this first in each turn.',
      },
      async () => {
        try {
          const r = await c.request<InboxResult>({ type: 'inbox' })
          return text(renderInbox(r))
        } catch (e) {
          return fail(e)
        }
      },
    )

    s.registerTool(
      'send',
      {
        description:
          'Send a message. Give exactly one of `to` (agent name, opens a dm) or `room`. Returns delivery state per recipient.',
        inputSchema: {
          to: z.string().optional(),
          room: z.string().optional(),
          text: z.string(),
          task_id: z.string().optional(),
          payload: z.record(z.unknown()).optional(),
          blobs: z
            .array(z.object({ id: z.string().length(64), name: z.string().min(1) }))
            .optional()
            .describe('attachments previously uploaded with put_file'),
        },
      },
      async (args) => {
        try {
          const r = await c.request<{
            message: Message
            deliveries: { recipient: string; via: string; state: string }[]
          }>({
            type: 'send',
            text: args.text,
            ...(args.to ? { to: args.to } : {}),
            ...(args.room ? { room: args.room } : {}),
            ...(args.task_id ? { task_id: args.task_id } : {}),
            ...(args.payload ? { payload: args.payload } : {}),
            ...(args.blobs?.length ? { blobs: args.blobs } : {}),
          })
          const d = r.deliveries.map((x) => `${x.recipient}:${x.via}/${x.state}`).join(', ')
          return text(
            `sent #${r.message.id} to ${r.message.room}${d ? ` → ${d}` : ' (no other members yet)'}`,
          )
        } catch (e) {
          return fail(e)
        }
      },
    )

    s.registerTool(
      'ack',
      {
        description: 'Mark messages as handled without replying (e.g. you acted on them silently).',
        inputSchema: { message_ids: z.array(z.number().int()).min(1) },
      },
      async ({ message_ids }) => {
        try {
          await c.request({ type: 'ack', message_ids })
          return text(`handled ${message_ids.length} message(s)`)
        } catch (e) {
          return fail(e)
        }
      },
    )

    s.registerTool(
      'status',
      {
        description: 'Report what you are doing (working / idle / blocked) for humans watching.',
        inputSchema: {
          state: z.enum(['working', 'idle', 'blocked']).optional(),
          text: z.string().max(200).optional(),
        },
      },
      async ({ state, text: t }) => {
        try {
          await c.request({
            type: 'status',
            ...(state ? { state } : {}),
            ...(t ? { text: t } : {}),
          })
          return text('ok')
        } catch (e) {
          return fail(e)
        }
      },
    )
  }
}

/** Entry used by `agentbus agent`: connect to the bus, then serve MCP on stdio. */
export async function runAdapter(opts: AdapterOptions): Promise<Adapter> {
  const a = new Adapter(opts)
  await a.connect()
  await a.serveStdio()
  return a
}
