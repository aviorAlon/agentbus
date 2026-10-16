import { type ChildProcess, spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type {
  Backend,
  BackendSession,
  McpServerSpec,
  PermissionAsk,
  PermissionDecision,
  PermissionHandler,
  TurnResult,
} from './backend.js'

export interface AcpBackendOptions {
  command: string
  args: string[]
  env?: Record<string, string>
  /** `full` auto-allows; `ask` routes to `onPermission` (M1: input-required to a human). */
  autonomy: 'full' | 'ask'
  /**
   * Session mode preference, first available wins (ACP `session/set_mode`). Agents ship
   * with an interactive default (Codex: "agent" = auto review, Claude: "default" = ask
   * for everything) that makes an unattended session stall or get its tool calls denied.
   */
  modes?: string[]
  onPermission?: (ask: PermissionAsk) => Promise<PermissionDecision>
  log?: (line: string) => void
}

interface Live {
  proc: ChildProcess
  conn: acp.ClientConnection
  loadSession: boolean
  closed: Promise<void>
  alive: boolean
}

class AcpSession implements BackendSession {
  constructor(
    public id: string,
    public live: Live,
  ) {}
  get closed(): Promise<void> {
    return this.live.closed
  }
  get alive(): boolean {
    return this.live.alive
  }
}

/**
 * ACP client backend (PRODUCT_DESIGN §4.3, F-D3). One long-lived agent process per
 * session; a turn is one `session/prompt`. Works for codex-acp, claude-agent-acp,
 * Gemini CLI, Kimi CLI, OpenCode and anything else on the ACP agent list.
 */
export class AcpBackend implements Backend {
  private readonly log: (line: string) => void
  private chunks = new Map<string, string[]>()
  private permissionHandler: PermissionHandler | null = null

  setPermissionHandler(handler: PermissionHandler): void {
    this.permissionHandler = handler
  }

  constructor(private readonly opts: AcpBackendOptions) {
    this.log = opts.log ?? ((l) => process.stderr.write(`${l}\n`))
  }

  async open(cwd: string, mcpServers: McpServerSpec[]): Promise<BackendSession> {
    const live = await this.launch()
    const res = await live.conn.agent.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: mcpServers.map(toAcpMcp),
    })
    await this.applyMode(live, res.sessionId, res.modes)
    return new AcpSession(res.sessionId, live)
  }

  /** Switch the session into the first preferred mode the agent offers. */
  private async applyMode(
    live: Live,
    sessionId: string,
    modes: acp.SessionModeState | null | undefined,
  ): Promise<void> {
    const prefs = this.opts.modes ?? []
    if (!prefs.length || !modes) return
    const available = new Set(modes.availableModes.map((m) => m.id))
    const pick = prefs.find((m) => available.has(m))
    if (!pick) {
      this.log(
        `[acp] none of the preferred modes [${prefs.join(', ')}] is offered; staying in "${modes.currentModeId}" (available: ${[...available].join(', ')})`,
      )
      return
    }
    if (pick === modes.currentModeId) return
    await live.conn.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: pick })
    this.log(`[acp] session mode "${modes.currentModeId}" → "${pick}"`)
  }

  async prompt(session: BackendSession, text: string, signal: AbortSignal): Promise<TurnResult> {
    const s = session as AcpSession
    if (!s.live.alive) throw new Error('backend process is not alive')
    this.chunks.set(s.id, [])
    const onAbort = () => {
      void s.live.conn.agent
        .notify(acp.methods.agent.session.cancel, { sessionId: s.id })
        .catch(() => undefined)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await s.live.conn.agent.request(acp.methods.agent.session.prompt, {
        sessionId: s.id,
        prompt: [{ type: 'text', text }],
      })
      return { stopReason: res.stopReason, text: (this.chunks.get(s.id) ?? []).join('') }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.chunks.delete(s.id)
    }
  }

  async cancel(session: BackendSession): Promise<void> {
    const s = session as AcpSession
    if (!s.live.alive) return
    await s.live.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: s.id })
  }

  async recover(
    previous: BackendSession,
    cwd: string,
    mcpServers: McpServerSpec[],
  ): Promise<BackendSession> {
    const prev = previous as AcpSession
    await this.close(prev)
    const live = await this.launch()
    const servers = mcpServers.map(toAcpMcp)
    if (live.loadSession) {
      try {
        const loaded = await live.conn.agent.request(acp.methods.agent.session.load, {
          sessionId: prev.id,
          cwd,
          mcpServers: servers,
        })
        await this.applyMode(live, prev.id, loaded?.modes)
        this.log(`[acp] recovered session ${prev.id} via session/load`)
        return new AcpSession(prev.id, live)
      } catch (e) {
        this.log(`[acp] session/load failed (${(e as Error).message}); starting a fresh session`)
      }
    }
    const res = await live.conn.agent.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: servers,
    })
    await this.applyMode(live, res.sessionId, res.modes)
    return new AcpSession(res.sessionId, live)
  }

  async close(session: BackendSession): Promise<void> {
    const s = session as AcpSession
    if (!s.live.alive) return
    s.live.alive = false
    try {
      s.live.conn.close()
    } catch {
      // ignore
    }
    s.live.proc.kill()
    await Promise.race([s.live.closed, new Promise((r) => setTimeout(r, 2000))])
  }

  // ------------------------------------------------------------------ internals

  private async launch(): Promise<Live> {
    const proc = spawn(this.opts.command, this.opts.args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...(this.opts.env ?? {}) },
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.opts.command),
    })
    if (!proc.stdin || !proc.stdout) throw new Error('failed to open agent stdio')
    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin),
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
    )

    const live: Partial<Live> & { alive: boolean } = { proc, alive: true }
    const conn = acp
      .client({ name: 'agentbus-driver' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.onPermission(ctx.params),
      )
      .onNotification(acp.methods.client.session.update, (ctx) => {
        const u = ctx.params.update
        if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
          this.chunks.get(ctx.params.sessionId)?.push(u.content.text)
        }
      })
      .connect(stream)

    const closed = new Promise<void>((resolve) => {
      const done = () => {
        live.alive = false
        resolve()
      }
      proc.once('exit', done)
      proc.once('error', done)
      conn.closed.then(done, done)
    })

    const init = await conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agentbus-driver', version: '0.0.0' },
    })
    return {
      proc,
      conn,
      loadSession: init.agentCapabilities?.loadSession === true,
      closed,
      get alive() {
        return live.alive
      },
      set alive(v: boolean) {
        live.alive = v
      },
    }
  }

  private async onPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const options = params.options
    const allow = () => {
      const pick =
        options.find((o) => o.kind === 'allow_always') ??
        options.find((o) => o.kind === 'allow_once') ??
        options[0]
      return pick
        ? { outcome: { outcome: 'selected' as const, optionId: pick.optionId } }
        : { outcome: { outcome: 'cancelled' as const } }
    }
    // The agentbus adapter's tools (send, inbox, task_update, ...) only talk to the bus;
    // asking a human whether the agent may *reply* would deadlock the conversation.
    if (isAgentbusTool(params.toolCall)) return allow()
    if (this.opts.autonomy === 'full') {
      const pick =
        options.find((o) => o.kind === 'allow_always') ??
        options.find((o) => o.kind === 'allow_once') ??
        options[0]
      if (!pick) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: pick.optionId } }
    }
    const handler = this.opts.onPermission ?? this.permissionHandler
    if (!handler) {
      this.log(
        `[acp] permission requested (${params.toolCall.title ?? 'tool'}) but no handler: rejecting`,
      )
      const rej =
        options.find((o) => o.kind === 'reject_once') ??
        options.find((o) => o.kind === 'reject_always')
      return rej
        ? { outcome: { outcome: 'selected', optionId: rej.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    }
    const decision = await handler({
      title: params.toolCall.title ?? 'tool call',
      kind: params.toolCall.kind ?? null,
      rawInput: params.toolCall.rawInput,
      options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    })
    return decision.optionId
      ? { outcome: { outcome: 'selected', optionId: decision.optionId } }
      : { outcome: { outcome: 'cancelled' } }
  }
}

/** Claude names MCP tools `mcp__<server>__<tool>`, Codex `mcp.<server>.<tool>`. */
export function isAgentbusTool(tc: {
  title?: string | null
  name?: string | null
  rawInput?: unknown
}): boolean {
  const names = [tc.title ?? '', tc.name ?? '']
  return names.some((n) => /^mcp(__|\.)agentbus(__|\.)/i.test(n.trim()))
}

function toAcpMcp(s: McpServerSpec): acp.McpServer {
  return {
    name: s.name,
    command: s.command,
    args: s.args,
    env: Object.entries(s.env).map(([name, value]) => ({ name, value })),
  }
}
