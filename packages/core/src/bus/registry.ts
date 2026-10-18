import type { Capabilities, RegisterResult, Role, ServerFrame } from '@agentbus/protocol'
import { verifyToken } from '../auth/token.js'
import type { Store } from '../store/store.js'
import { BusError } from './errors.js'

/** Transport-agnostic handle to a connected client. */
export interface Connection {
  send(frame: ServerFrame): void
  close(code: number, reason: string): void
}

export interface Session {
  conn: Connection
  name: string
  role: Role
  /** What this connection declared; the delivery path is chosen per connection, not per name. */
  capabilities: Capabilities
  /** A standby (hosted) connection for the name: it only ever gets rows handed to it. */
  standby: boolean
  lastSeen: number
  /** Outstanding `wait` request, resolved by the delivery engine; `from` narrows it to one sender. */
  waiting: { requestId: string; timer: ReturnType<typeof setTimeout>; from?: string } | null
}

interface Slot {
  /** Interactive controls. Bots: exactly one. Humans / relayers: any number (every terminal they open). */
  control: Session[]
  tool?: Session
  /** The standby driver for the name and its adapter: at most one of each, any authority. */
  standbyControl?: Session
  standbyTool?: Session
}

/**
 * Who is connected as whom (PRODUCT_DESIGN §5.7). A bot has exactly one `control`
 * and at most one `tool` session; takeover follows F-R5: a live session of the same
 * role rejects the newcomer, a dead one (closed, or silent past the heartbeat timeout)
 * is replaced and recorded as a takeover. A human may hold several `control` sessions
 * at once (chat in one window, tasks in another): deliveries go to all of them.
 *
 * A standby connection (`capabilities.standby`) lives in its own slot next to the
 * interactive ones: the same directory can be joined interactively and hosted on standby
 * under one name. A second standby for the name is `name_taken` like a second bot control.
 */
export class Registry {
  private byConn = new Map<Connection, Session>()
  private byAgent = new Map<string, Slot>()

  constructor(
    private readonly store: Store,
    private readonly heartbeatTimeoutMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  register(
    conn: Connection,
    req: {
      name: string
      token: string
      role: Role
      capabilities: Capabilities
      backend?: string | undefined
      cwd?: string | undefined
      session_id?: string | undefined
      version?: string | undefined
    },
  ): RegisterResult {
    if (this.byConn.has(conn)) throw new BusError('bad_request', 'connection already registered')
    const agent = this.store.getAgent(req.name)
    if (!agent || !verifyToken(req.token, agent.token_hash))
      throw new BusError('unauthorized', 'unknown agent or bad token')

    const slot = this.byAgent.get(req.name) ?? { control: [] }
    const standby = req.capabilities.standby === true
    const multi = !standby && agent.authority !== 'bot' && req.role === 'control'
    let tookOver = false
    if (!multi) {
      const existing = standby
        ? req.role === 'control'
          ? slot.standbyControl
          : slot.standbyTool
        : req.role === 'control'
          ? slot.control[0]
          : slot.tool
      if (existing) {
        const silentFor = this.now() - existing.lastSeen
        if (silentFor < this.heartbeatTimeoutMs)
          throw new BusError(
            'name_taken',
            `${req.name}/${req.role}${standby ? ' (standby)' : ''} is connected`,
          )
        // Stale session: evict it.
        this.evict(existing, 'replaced by a new connection')
        tookOver = true
      } else if (!standby && req.role === 'control' && agent.online && !slot.standbyControl) {
        // DB says online but no live session: a previous process died without goodbye.
        tookOver = true
      }
    }

    const session: Session = {
      conn,
      name: req.name,
      role: req.role,
      capabilities: req.capabilities,
      standby,
      lastSeen: this.now(),
      waiting: null,
    }
    this.byConn.set(conn, session)
    if (standby) {
      if (req.role === 'control') slot.standbyControl = session
      else slot.standbyTool = session
    } else if (req.role === 'control') slot.control.push(session)
    else slot.tool = session
    this.byAgent.set(req.name, slot)

    if (req.role === 'control' && !standby) {
      this.store.updateAgentRegistration(req.name, {
        capabilities: req.capabilities,
        ...(req.backend !== undefined ? { backend: req.backend } : {}),
        ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
        ...(req.session_id !== undefined ? { session_id: req.session_id } : {}),
        ...(req.version !== undefined ? { version: req.version } : {}),
      })
    } else if (req.role === 'control') {
      // The standby does not overwrite what the interactive session declared; it only keeps the name online.
      this.store.setAgentOnline(req.name, true)
    } else {
      this.store.touchAgent(req.name)
    }
    if (tookOver) this.store.appendEvent('takeover', { role: req.role, standby }, req.name)

    return { name: req.name, role: req.role, authority: agent.authority, took_over: tookOver }
  }

  unregister(conn: Connection): Session | null {
    const s = this.byConn.get(conn)
    if (!s) return null
    this.byConn.delete(conn)
    const slot = this.byAgent.get(s.name)
    if (slot) {
      if (s.standby) {
        if (slot.standbyControl === s) delete slot.standbyControl
        if (slot.standbyTool === s) delete slot.standbyTool
      } else if (s.role === 'control') slot.control = slot.control.filter((x) => x !== s)
      else if (slot.tool === s) delete slot.tool
      if (!slot.control.length && !slot.tool && !slot.standbyControl && !slot.standbyTool)
        this.byAgent.delete(s.name)
    }
    if (s.waiting) {
      clearTimeout(s.waiting.timer)
      s.waiting = null
    }
    // Offline only when the last control session (interactive or standby) is gone.
    if (s.role === 'control' && !this.isOnline(s.name)) this.store.setAgentOnline(s.name, false)
    return s
  }

  private evict(s: Session, reason: string): void {
    this.unregister(s.conn)
    try {
      s.conn.close(4000, reason)
    } catch {
      // already gone
    }
  }

  session(conn: Connection): Session | null {
    return this.byConn.get(conn) ?? null
  }

  /** The session that must be registered before any other frame. */
  require(conn: Connection): Session {
    const s = this.byConn.get(conn)
    if (!s) throw new BusError('not_registered', 'send register first')
    return s
  }

  /** Newest interactive control session (bots have exactly one). */
  control(name: string): Session | null {
    const list = this.byAgent.get(name)?.control
    return list?.length ? (list[list.length - 1] as Session) : null
  }

  /** Every interactive control session (a human may have several); the standby is not among them. */
  interactive(name: string): Session[] {
    return this.byAgent.get(name)?.control ?? []
  }

  /** The standby driver's control session for the name, if one is connected. */
  standby(name: string): Session | null {
    return this.byAgent.get(name)?.standbyControl ?? null
  }

  /** Every control session, interactive and standby: where events and broadcasts go. */
  controls(name: string): Session[] {
    const slot = this.byAgent.get(name)
    if (!slot) return []
    return slot.standbyControl ? [...slot.control, slot.standbyControl] : slot.control
  }

  /** Names that have a standby connected right now. */
  standbyNames(): string[] {
    const out: string[] = []
    for (const [name, slot] of this.byAgent) if (slot.standbyControl) out.push(name)
    return out
  }

  isOnline(name: string): boolean {
    return this.controls(name).length > 0
  }

  touch(conn: Connection): void {
    const s = this.byConn.get(conn)
    if (s) {
      s.lastSeen = this.now()
    }
  }

  /** Drop sessions silent past the heartbeat timeout. Returns names whose last control went away. */
  sweep(): string[] {
    const gone: string[] = []
    const cutoff = this.now() - this.heartbeatTimeoutMs
    for (const s of [...this.byConn.values()]) {
      if (s.lastSeen < cutoff) {
        this.evict(s, 'heartbeat timeout')
        if (s.role === 'control' && !this.isOnline(s.name)) gone.push(s.name)
      }
    }
    return gone
  }

  sessions(): Session[] {
    return [...this.byConn.values()]
  }
}
