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
  lastSeen: number
  /** Outstanding `wait` request, resolved by the delivery engine; `from` narrows it to one sender. */
  waiting: { requestId: string; timer: ReturnType<typeof setTimeout>; from?: string } | null
}

interface Slot {
  /** Bots: exactly one. Humans / relayers: any number (every terminal they open). */
  control: Session[]
  tool?: Session
}

/**
 * Who is connected as whom (PRODUCT_DESIGN §5.7). A bot has exactly one `control`
 * and at most one `tool` session; takeover follows F-R5: a live session of the same
 * role rejects the newcomer, a dead one (closed, or silent past the heartbeat timeout)
 * is replaced and recorded as a takeover. A human may hold several `control` sessions
 * at once (chat in one window, tasks in another): deliveries go to all of them.
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
    const multi = agent.authority !== 'bot' && req.role === 'control'
    let tookOver = false
    if (!multi) {
      const existing = req.role === 'control' ? slot.control[0] : slot.tool
      if (existing) {
        const silentFor = this.now() - existing.lastSeen
        if (silentFor < this.heartbeatTimeoutMs)
          throw new BusError('name_taken', `${req.name}/${req.role} is connected`)
        // Stale session: evict it.
        this.evict(existing, 'replaced by a new connection')
        tookOver = true
      } else if (req.role === 'control' && agent.online) {
        // DB says online but no live session: a previous process died without goodbye.
        tookOver = true
      }
    }

    const session: Session = {
      conn,
      name: req.name,
      role: req.role,
      lastSeen: this.now(),
      waiting: null,
    }
    this.byConn.set(conn, session)
    if (req.role === 'control') slot.control.push(session)
    else slot.tool = session
    this.byAgent.set(req.name, slot)

    if (req.role === 'control') {
      this.store.updateAgentRegistration(req.name, {
        capabilities: req.capabilities,
        ...(req.backend !== undefined ? { backend: req.backend } : {}),
        ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
        ...(req.session_id !== undefined ? { session_id: req.session_id } : {}),
        ...(req.version !== undefined ? { version: req.version } : {}),
      })
    } else {
      this.store.touchAgent(req.name)
    }
    if (tookOver) this.store.appendEvent('takeover', { role: req.role }, req.name)

    return { name: req.name, role: req.role, authority: agent.authority, took_over: tookOver }
  }

  unregister(conn: Connection): Session | null {
    const s = this.byConn.get(conn)
    if (!s) return null
    this.byConn.delete(conn)
    const slot = this.byAgent.get(s.name)
    if (slot) {
      if (s.role === 'control') slot.control = slot.control.filter((x) => x !== s)
      else if (slot.tool === s) delete slot.tool
      if (!slot.control.length && !slot.tool) this.byAgent.delete(s.name)
    }
    if (s.waiting) {
      clearTimeout(s.waiting.timer)
      s.waiting = null
    }
    // Offline only when the last control session is gone.
    if (s.role === 'control' && !(slot?.control.length ?? 0))
      this.store.setAgentOnline(s.name, false)
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

  /** Newest control session (bots have exactly one). */
  control(name: string): Session | null {
    const list = this.byAgent.get(name)?.control
    return list?.length ? (list[list.length - 1] as Session) : null
  }

  /** Every control session (a human may have several). */
  controls(name: string): Session[] {
    return this.byAgent.get(name)?.control ?? []
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
