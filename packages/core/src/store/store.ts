import type {
  AgentInfo,
  Authority,
  BlobRef,
  Capabilities,
  Delivery,
  DeliveryVia,
  Message,
  PresenceState,
  Task,
  TaskEvent,
  TaskState,
} from '@agentbus/protocol'
import { Capabilities as CapabilitiesSchema } from '@agentbus/protocol'
import Database from 'better-sqlite3'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js'

export type Clock = () => number

export interface AgentRow {
  name: string
  backend: string | null
  authority: Authority
  token_hash: string
  capabilities: Capabilities
  cwd: string | null
  session_id: string | null
  online: boolean
  state: PresenceState
  status_text: string | null
  state_at: number | null
  activity_at: number | null
  last_seen: number | null
  version: string | null
  created_at: number
}

export interface RoomRow {
  name: string
  kind: 'dm' | 'room'
  paused: boolean
  created_at: number
}

export interface NewMessage {
  room: string
  from: string
  authority: Authority
  text: string
  payload?: unknown
  task_id?: string
  blobs?: BlobRef[]
}

export interface DeliveryRow extends Delivery {}

export interface DriverTurnRow {
  id: number
  agent: string
  session_id: string | null
  message_ids: number[]
  started_at: number
  ended_at: number | null
  tokens: number | null
  sent: boolean
  exit_reason: string | null
  recovered: boolean
}

export interface RoomBlob {
  message_id: number
  from: string
  id: string
  name: string
  size: number
  mime: string | null
  created_at: number
}

/**
 * Single-writer SQLite store (§5.4). Synchronous by design: better-sqlite3 is
 * faster than async wrappers for this workload and keeps invariants simple.
 */
export class Store {
  readonly db: Database.Database
  private readonly now: Clock

  constructor(path: string, opts: { clock?: Clock } = {}) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(SCHEMA_SQL)
    this.migrate()
    this.db
      .prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION))
    this.now = opts.clock ?? (() => Date.now())
  }

  close(): void {
    this.db.close()
  }

  /** Additive migrations for databases created by older schema versions. */
  private migrate(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((c) => c.name),
    )
    for (const [col, ddl] of [
      ['state_at', 'ALTER TABLE agents ADD COLUMN state_at INTEGER'],
      ['activity_at', 'ALTER TABLE agents ADD COLUMN activity_at INTEGER'],
    ] as const) {
      if (!cols.has(col)) this.db.exec(ddl)
    }
    const taskCols = new Set(
      (this.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name),
    )
    for (const [col, ddl] of [
      ['context', 'ALTER TABLE tasks ADD COLUMN context TEXT'],
      ['summary', 'ALTER TABLE tasks ADD COLUMN summary TEXT'],
      ['artifacts_json', "ALTER TABLE tasks ADD COLUMN artifacts_json TEXT NOT NULL DEFAULT '[]'"],
      ['escalated', 'ALTER TABLE tasks ADD COLUMN escalated INTEGER NOT NULL DEFAULT 0'],
    ] as const) {
      if (!taskCols.has(col)) this.db.exec(ddl)
    }
  }

  // ----------------------------------------------------------------- tasks

  createTask(t: {
    id: string
    room: string
    from: string
    to: string
    description: string
    context?: string
    deadline: number | null
    max_turns: number | null
  }): Task {
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO tasks(id, room, from_agent, to_agent, state, description, context, deadline, max_turns, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.room,
        t.from,
        t.to,
        t.description,
        t.context ?? null,
        t.deadline,
        t.max_turns,
        now,
        now,
      )
    this.appendTaskEvent(t.id, null, 'submitted', t.from, null, [])
    const task = this.getTask(t.id)
    if (!task) throw new Error('task insert failed')
    return task
  }

  getTask(id: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return r ? toTask(r) : null
  }

  listTasks(
    opts: { agent?: string; state?: TaskState; openOnly?: boolean; limit?: number } = {},
  ): Task[] {
    const where: string[] = []
    const args: unknown[] = []
    if (opts.agent) {
      where.push('(from_agent = ? OR to_agent = ?)')
      args.push(opts.agent, opts.agent)
    }
    if (opts.state) {
      where.push('state = ?')
      args.push(opts.state)
    } else if (opts.openOnly) where.push("state NOT IN ('completed','failed','canceled')")
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`
    args.push(opts.limit ?? 100)
    return (this.db.prepare(sql).all(...args) as Record<string, unknown>[]).map(toTask)
  }

  /** Open tasks past their deadline. */
  overdueTasks(now: number): Task[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM tasks WHERE deadline IS NOT NULL AND deadline < ? AND state NOT IN ('completed','failed','canceled')",
        )
        .all(now) as Record<string, unknown>[]
    ).map(toTask)
  }

  /** Apply a transition (already validated by the caller) and append the event. */
  transitionTask(
    id: string,
    to: TaskState,
    by: string,
    summary: string | null,
    artifacts: BlobRef[],
    opts: { escalated?: boolean } = {},
  ): Task {
    const prev = this.getTask(id)
    if (!prev) throw new Error(`no task ${id}`)
    const merged = artifacts.length ? [...prev.artifacts, ...artifacts] : prev.artifacts
    this.db
      .prepare(
        `UPDATE tasks SET state = ?, summary = COALESCE(?, summary), artifacts_json = ?,
           escalated = CASE WHEN ? THEN 1 ELSE escalated END, updated_at = ? WHERE id = ?`,
      )
      .run(to, summary, JSON.stringify(merged), opts.escalated ? 1 : 0, this.now(), id)
    this.appendTaskEvent(id, prev.state, to, by, summary, artifacts)
    return this.getTask(id) as Task
  }

  /** Count a bot message in the thread; returns the new count. */
  bumpTaskTurns(id: string): number {
    this.db
      .prepare('UPDATE tasks SET turns_used = turns_used + 1, updated_at = ? WHERE id = ?')
      .run(this.now(), id)
    return (
      this.db.prepare('SELECT turns_used FROM tasks WHERE id = ?').get(id) as { turns_used: number }
    ).turns_used
  }

  private appendTaskEvent(
    taskId: string,
    from: TaskState | null,
    to: TaskState,
    by: string,
    summary: string | null,
    artifacts: BlobRef[],
  ): void {
    this.db
      .prepare(
        `INSERT INTO task_events(task_id, from_state, to_state, by_agent, summary, artifacts_json, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(taskId, from, to, by, summary, JSON.stringify(artifacts), this.now())
  }

  taskEvents(taskId: string): TaskEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id')
        .all(taskId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      task_id: r.task_id as string,
      from_state: (r.from_state as TaskState | null) ?? null,
      to_state: r.to_state as TaskState,
      by: r.by_agent as string,
      summary: (r.summary as string | null) ?? null,
      artifacts: JSON.parse((r.artifacts_json as string) || '[]') as BlobRef[],
      at: r.at as number,
    }))
  }

  // ---------------------------------------------------------- driver turns

  recordTurn(t: {
    agent: string
    session_id: string | null
    message_ids: number[]
    started_at: number
    ended_at: number
    tokens: number | null
    sent: boolean
    exit_reason: string
    recovered: boolean
  }): number {
    const r = this.db
      .prepare(
        `INSERT INTO driver_turns(agent, session_id, message_ids_json, started_at, ended_at, tokens, sent, exit_reason, recovered)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.agent,
        t.session_id,
        JSON.stringify(t.message_ids),
        t.started_at,
        t.ended_at,
        t.tokens,
        t.sent ? 1 : 0,
        t.exit_reason,
        t.recovered ? 1 : 0,
      )
    return Number(r.lastInsertRowid)
  }

  recentTurns(limit = 50, agent?: string): DriverTurnRow[] {
    const rows = (
      agent
        ? this.db
            .prepare('SELECT * FROM driver_turns WHERE agent = ? ORDER BY id DESC LIMIT ?')
            .all(agent, limit)
        : this.db.prepare('SELECT * FROM driver_turns ORDER BY id DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as number,
      agent: r.agent as string,
      session_id: (r.session_id as string | null) ?? null,
      message_ids: JSON.parse(r.message_ids_json as string) as number[],
      started_at: r.started_at as number,
      ended_at: (r.ended_at as number | null) ?? null,
      tokens: (r.tokens as number | null) ?? null,
      sent: r.sent === 1,
      exit_reason: (r.exit_reason as string | null) ?? null,
      recovered: r.recovered === 1,
    }))
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  // ---------------------------------------------------------------- agents

  createAgent(a: {
    name: string
    token_hash: string
    authority?: Authority
    backend?: string
  }): AgentRow {
    this.db
      .prepare(
        `INSERT INTO agents(name, backend, authority, token_hash, created_at)
         VALUES (@name, @backend, @authority, @token_hash, @now)`,
      )
      .run({
        name: a.name,
        backend: a.backend ?? null,
        authority: a.authority ?? 'bot',
        token_hash: a.token_hash,
        now: this.now(),
      })
    const row = this.getAgent(a.name)
    if (!row) throw new Error('agent insert failed')
    return row
  }

  /** Rotate an agent's token (the old one stops working at once). */
  setTokenHash(name: string, tokenHash: string): void {
    this.db.prepare('UPDATE agents SET token_hash = ? WHERE name = ?').run(tokenHash, name)
  }

  getAgent(name: string): AgentRow | null {
    const r = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as
      | Record<string, unknown>
      | undefined
    return r ? toAgentRow(r) : null
  }

  listAgents(): AgentRow[] {
    return (
      this.db.prepare('SELECT * FROM agents ORDER BY name').all() as Record<string, unknown>[]
    ).map(toAgentRow)
  }

  /** Called on successful register: refreshes declared capabilities and session info. */
  updateAgentRegistration(
    name: string,
    u: {
      backend?: string
      capabilities: Capabilities
      cwd?: string
      session_id?: string
      version?: string
    },
  ): void {
    this.db
      .prepare(
        `UPDATE agents SET backend = COALESCE(@backend, backend), capabilities_json = @caps,
           cwd = COALESCE(@cwd, cwd), session_id = COALESCE(@session_id, session_id),
           version = COALESCE(@version, version), online = 1, last_seen = @now
         WHERE name = @name`,
      )
      .run({
        name,
        backend: u.backend ?? null,
        caps: JSON.stringify(u.capabilities),
        cwd: u.cwd ?? null,
        session_id: u.session_id ?? null,
        version: u.version ?? null,
        now: this.now(),
      })
  }

  setAgentOnline(name: string, online: boolean): void {
    this.db
      .prepare('UPDATE agents SET online = ?, last_seen = ? WHERE name = ?')
      .run(online ? 1 : 0, this.now(), name)
  }

  /** Explicit presence report (adapter `status`, driver, or disconnect). */
  setAgentState(name: string, state: PresenceState, statusText?: string | null): void {
    const now = this.now()
    this.db
      .prepare(
        `UPDATE agents SET state = ?, status_text = COALESCE(?, status_text), state_at = ?, last_seen = ?
         WHERE name = ?`,
      )
      .run(state, statusText ?? null, now, now, name)
  }

  /** Observed activity (send / task update). Waiting does not count. */
  touchActivity(name: string): void {
    const now = this.now()
    this.db
      .prepare('UPDATE agents SET activity_at = ?, last_seen = ? WHERE name = ?')
      .run(now, now, name)
  }

  /**
   * Presence synthesis (PRODUCT_DESIGN T1.5): an explicit report wins while it is newer
   * than observed activity and still fresh; otherwise recent activity means working, an
   * idle connection means idle, offline means unknown. Never pretend to know.
   */
  presence(row: AgentRow, online: boolean, now: number): PresenceState {
    if (!online) return 'unknown'
    const stateAt = row.state_at ?? 0
    const act = row.activity_at ?? 0
    if (stateAt > 0 && stateAt >= act && now - stateAt < EXPLICIT_STATE_TTL_MS) return row.state
    if (act > 0 && now - act < ACTIVITY_WINDOW_MS) return 'working'
    return 'idle'
  }

  touchAgent(name: string): void {
    this.db.prepare('UPDATE agents SET last_seen = ? WHERE name = ?').run(this.now(), name)
  }

  agentInfo(row: AgentRow): AgentInfo {
    return {
      name: row.name,
      backend: row.backend,
      authority: row.authority,
      online: row.online,
      state: row.state,
      capabilities: row.capabilities,
      cwd: row.cwd,
      last_seen: row.last_seen,
    }
  }

  // ----------------------------------------------------------------- rooms

  ensureRoom(name: string, kind: 'dm' | 'room'): RoomRow {
    this.db
      .prepare('INSERT OR IGNORE INTO rooms(name, kind, created_at) VALUES (?, ?, ?)')
      .run(name, kind, this.now())
    const row = this.getRoom(name)
    if (!row) throw new Error('room insert failed')
    return row
  }

  getRoom(name: string): RoomRow | null {
    const r = this.db.prepare('SELECT * FROM rooms WHERE name = ?').get(name) as
      | { name: string; kind: 'dm' | 'room'; paused: number; created_at: number }
      | undefined
    return r ? { ...r, paused: r.paused === 1 } : null
  }

  listRooms(): RoomRow[] {
    return (
      this.db.prepare('SELECT * FROM rooms ORDER BY created_at').all() as {
        name: string
        kind: 'dm' | 'room'
        paused: number
        created_at: number
      }[]
    ).map((r) => ({ ...r, paused: r.paused === 1 }))
  }

  setRoomPaused(room: string, paused: boolean): void {
    this.db.prepare('UPDATE rooms SET paused = ? WHERE name = ?').run(paused ? 1 : 0, room)
  }

  addMember(room: string, agent: string): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO room_members(room, agent_name, joined_at) VALUES (?, ?, ?)')
      .run(room, agent, this.now())
    return r.changes > 0
  }

  removeMember(room: string, agent: string): boolean {
    return (
      this.db.prepare('DELETE FROM room_members WHERE room = ? AND agent_name = ?').run(room, agent)
        .changes > 0
    )
  }

  isMember(room: string, agent: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM room_members WHERE room = ? AND agent_name = ?')
        .get(room, agent) !== undefined
    )
  }

  members(room: string): string[] {
    return (
      this.db
        .prepare('SELECT agent_name FROM room_members WHERE room = ? ORDER BY agent_name')
        .all(room) as { agent_name: string }[]
    ).map((r) => r.agent_name)
  }

  roomsOf(agent: string): string[] {
    return (
      this.db
        .prepare('SELECT room FROM room_members WHERE agent_name = ? ORDER BY room')
        .all(agent) as { room: string }[]
    ).map((r) => r.room)
  }

  // -------------------------------------------------------------- messages

  insertMessage(m: NewMessage): Message {
    const now = this.now()
    const info = this.db
      .prepare(
        `INSERT INTO messages(room, from_agent, authority, text, payload_json, task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.room,
        m.from,
        m.authority,
        m.text,
        m.payload === undefined ? null : JSON.stringify(m.payload),
        m.task_id ?? null,
        now,
      )
    const id = Number(info.lastInsertRowid)
    if (m.blobs?.length) {
      const ins = this.db.prepare(
        'INSERT OR IGNORE INTO message_blobs(message_id, blob_id, name) VALUES (?, ?, ?)',
      )
      const bump = this.db.prepare('UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = ?')
      for (const b of m.blobs) {
        ins.run(id, b.id, b.name)
        bump.run(b.id)
      }
    }
    const msg = this.getMessage(id)
    if (!msg) throw new Error('message insert failed')
    return msg
  }

  getMessage(id: number): Message | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return r ? this.toMessage(r) : null
  }

  /** Newest `limit` messages in a room (optionally before an id), returned oldest-first. */
  history(room: string, limit: number, before?: number): Message[] {
    const rows = (
      before === undefined
        ? this.db
            .prepare('SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?')
            .all(room, limit)
        : this.db
            .prepare('SELECT * FROM messages WHERE room = ? AND id < ? ORDER BY id DESC LIMIT ?')
            .all(room, before, limit)
    ) as Record<string, unknown>[]
    return rows.reverse().map((r) => this.toMessage(r))
  }

  /**
   * Unread for `recipient` in `room`: messages after the cursor that were delivered to it,
   * not yet seen (a `wait --from` picks single rows out ahead of the cursor) and not dropped
   * (TTL / mailbox cap). Own messages have no delivery row and are skipped.
   */
  unreadFor(recipient: string, room: string, afterId: number, limit: number): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN deliveries d ON d.message_id = m.id AND d.recipient = ?
         WHERE m.room = ? AND m.id > ? AND d.seen_at IS NULL AND d.error IS NULL AND d.via != 'standby'
         ORDER BY m.id ASC LIMIT ?`,
      )
      .all(recipient, room, afterId, limit) as Record<string, unknown>[]
    return rows.map((r) => this.toMessage(r))
  }

  /** Rows in `room` the standby took over (via=standby) after `afterId`, whatever their state. */
  standbyRowsFor(recipient: string, room: string, afterId: number, limit: number): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN deliveries d ON d.message_id = m.id AND d.recipient = ?
         WHERE m.room = ? AND m.id > ? AND d.via = 'standby' AND d.error IS NULL
         ORDER BY m.id ASC LIMIT ?`,
      )
      .all(recipient, room, afterId, limit) as Record<string, unknown>[]
    return rows.map((r) => this.toMessage(r))
  }

  /** The standby's inbox: rows handed to it that it has not pulled yet, oldest first. */
  pendingStandby(recipient: string, limit = 500): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE d.recipient = ? AND d.via = 'standby' AND d.seen_at IS NULL AND d.error IS NULL
         ORDER BY m.id ASC LIMIT ?`,
      )
      .all(recipient, limit) as Record<string, unknown>[]
    return rows.map((r) => this.toMessage(r))
  }

  /**
   * Rows the interactive session could still read (mailbox / push, unseen, not dropped),
   * oldest first, with when they were written — what a standby may take over once overdue.
   */
  pendingInteractive(recipient: string, limit = 500): Delivery[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM deliveries WHERE recipient = ? AND seen_at IS NULL AND error IS NULL
           AND via IN ('mailbox', 'push', 'push->mailbox') ORDER BY message_id ASC LIMIT ?`,
        )
        .all(recipient, limit) as Record<string, unknown>[]
    ).map(toDelivery)
  }

  /**
   * The standby replied in `room`: the rows it pulled there up to `upTo` are handled. The
   * person's rows are untouched, and a row handed to it mid-turn stays in its inbox.
   */
  markStandbyHandledUpTo(recipient: string, room: string, upTo: number): number {
    const now = this.now()
    const r = this.db
      .prepare(
        `UPDATE deliveries SET seen_at = COALESCE(seen_at, ?), handled_at = ?
         WHERE recipient = ? AND via = 'standby' AND handled_at IS NULL AND seen_at IS NOT NULL
           AND message_id IN (SELECT id FROM messages WHERE room = ? AND id <= ?)`,
      )
      .run(now, now, recipient, room, upTo)
    return r.changes
  }

  messagesAfter(room: string, afterId: number, limit: number): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE room = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(room, afterId, limit) as Record<string, unknown>[]
    return rows.map((r) => this.toMessage(r))
  }

  private toMessage(r: Record<string, unknown>): Message {
    const id = r.id as number
    const blobRows = this.db
      .prepare(
        `SELECT mb.blob_id AS id, mb.name AS name, b.mime AS mime, b.size AS size
         FROM message_blobs mb JOIN blobs b ON b.sha256 = mb.blob_id WHERE mb.message_id = ?`,
      )
      .all(id) as { id: string; name: string; mime: string | null; size: number }[]
    const msg: Message = {
      id,
      room: r.room as string,
      from: r.from_agent as string,
      authority: r.authority as Authority,
      text: r.text as string,
      created_at: r.created_at as number,
    }
    if (r.payload_json) msg.payload = JSON.parse(r.payload_json as string)
    if (r.task_id) msg.task_id = r.task_id as string
    if (blobRows.length)
      msg.blobs = blobRows.map((b) => ({
        id: b.id,
        name: b.name,
        size: b.size,
        ...(b.mime ? { mime: b.mime } : {}),
      }))
    return msg
  }

  // --------------------------------------------------------------- cursors

  getCursor(agent: string, room: string): number {
    const r = this.db
      .prepare('SELECT last_seen_id FROM cursors WHERE agent_name = ? AND room = ?')
      .get(agent, room) as { last_seen_id: number } | undefined
    return r?.last_seen_id ?? 0
  }

  /** Monotonic: never moves a cursor backwards. Returns the resulting cursor. */
  advanceCursor(agent: string, room: string, id: number): number {
    this.db
      .prepare(
        `INSERT INTO cursors(agent_name, room, last_seen_id) VALUES (?, ?, ?)
         ON CONFLICT(agent_name, room) DO UPDATE SET last_seen_id = MAX(last_seen_id, excluded.last_seen_id)`,
      )
      .run(agent, room, id)
    return this.getCursor(agent, room)
  }

  /** Newest via=standby row the interactive session has been shown in `room`. */
  getStandbyCursor(agent: string, room: string): number {
    const r = this.db
      .prepare('SELECT last_seen_id FROM standby_cursors WHERE agent_name = ? AND room = ?')
      .get(agent, room) as { last_seen_id: number } | undefined
    return r?.last_seen_id ?? 0
  }

  advanceStandbyCursor(agent: string, room: string, id: number): void {
    this.db
      .prepare(
        `INSERT INTO standby_cursors(agent_name, room, last_seen_id) VALUES (?, ?, ?)
         ON CONFLICT(agent_name, room) DO UPDATE SET last_seen_id = MAX(last_seen_id, excluded.last_seen_id)`,
      )
      .run(agent, room, id)
  }

  // ------------------------------------------------------------ deliveries

  insertDelivery(messageId: number, recipient: string, via: DeliveryVia): Delivery {
    this.db
      .prepare(
        `INSERT INTO deliveries(message_id, recipient, via, written_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id, recipient) DO UPDATE SET attempts = attempts + 1, via = excluded.via`,
      )
      .run(messageId, recipient, via, this.now())
    const d = this.getDelivery(messageId, recipient)
    if (!d) throw new Error('delivery insert failed')
    return d
  }

  getDelivery(messageId: number, recipient: string): Delivery | null {
    const r = this.db
      .prepare('SELECT * FROM deliveries WHERE message_id = ? AND recipient = ?')
      .get(messageId, recipient) as Record<string, unknown> | undefined
    return r ? toDelivery(r) : null
  }

  deliveriesOf(messageId: number): Delivery[] {
    return (
      this.db
        .prepare('SELECT * FROM deliveries WHERE message_id = ? ORDER BY recipient')
        .all(messageId) as Record<string, unknown>[]
    ).map(toDelivery)
  }

  setDeliveryVia(messageId: number, recipient: string, via: DeliveryVia, error?: string): void {
    this.db
      .prepare('UPDATE deliveries SET via = ?, error = ? WHERE message_id = ? AND recipient = ?')
      .run(via, error ?? null, messageId, recipient)
  }

  markSeen(messageId: number, recipient: string): Delivery | null {
    this.db
      .prepare(
        'UPDATE deliveries SET seen_at = COALESCE(seen_at, ?) WHERE message_id = ? AND recipient = ?',
      )
      .run(this.now(), messageId, recipient)
    return this.getDelivery(messageId, recipient)
  }

  /** Mark seen every delivery for `recipient` in `room` with message id <= upTo. */
  markSeenUpTo(recipient: string, room: string, upTo: number): number {
    const r = this.db
      .prepare(
        `UPDATE deliveries SET seen_at = ? WHERE recipient = ? AND seen_at IS NULL
           AND message_id IN (SELECT id FROM messages WHERE room = ? AND id <= ?)`,
      )
      .run(this.now(), recipient, room, upTo)
    return r.changes
  }

  markHandled(messageId: number, recipient: string): Delivery | null {
    const now = this.now()
    this.db
      .prepare(
        `UPDATE deliveries SET seen_at = COALESCE(seen_at, ?), handled_at = COALESCE(handled_at, ?)
         WHERE message_id = ? AND recipient = ?`,
      )
      .run(now, now, messageId, recipient)
    return this.getDelivery(messageId, recipient)
  }

  /**
   * Sending in a room means the sender acted on what it had received there, but only on what
   * it could know about: rows it has seen, or rows pushed into its context. A row that arrived
   * while it was busy (unseen, in the mailbox) stays unread; otherwise two sessions asking each
   * other at once swallow each other's answers. The standby's rows are its own business.
   */
  markHandledUpTo(recipient: string, room: string, upTo: number): number {
    const now = this.now()
    const r = this.db
      .prepare(
        `UPDATE deliveries SET seen_at = COALESCE(seen_at, ?), handled_at = ?
         WHERE recipient = ? AND handled_at IS NULL AND via != 'standby'
           AND (seen_at IS NOT NULL OR via IN ('push', 'push->mailbox'))
           AND message_id IN (SELECT id FROM messages WHERE room = ? AND id <= ?)`,
      )
      .run(now, now, recipient, room, upTo)
    return r.changes
  }

  /** Messages written to `recipient` but not yet seen, oldest first (the mailbox); the standby's rows excluded. */
  pendingFor(recipient: string, limit = 500): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE d.recipient = ? AND d.seen_at IS NULL AND d.error IS NULL AND d.via != 'standby'
         ORDER BY m.id ASC LIMIT ?`,
      )
      .all(recipient, limit) as Record<string, unknown>[]
    return rows.map((r) => this.toMessage(r))
  }

  pendingCount(recipient: string): number {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM deliveries WHERE recipient = ? AND seen_at IS NULL AND error IS NULL',
      )
      .get(recipient) as { n: number }
    return r.n
  }

  /** Keep at most `max` unseen deliveries per recipient; the oldest beyond that are expired. */
  capPending(recipient: string, max: number): number[] {
    const ids = (
      this.db
        .prepare(
          `SELECT message_id FROM deliveries WHERE recipient = ? AND seen_at IS NULL AND error IS NULL
           ORDER BY message_id DESC LIMIT -1 OFFSET ?`,
        )
        .all(recipient, max) as { message_id: number }[]
    ).map((r) => r.message_id)
    if (ids.length) {
      const upd = this.db.prepare(
        "UPDATE deliveries SET error = 'mailbox_full' WHERE recipient = ? AND message_id = ?",
      )
      for (const id of ids) upd.run(recipient, id)
    }
    return ids
  }

  /** Drop unseen deliveries older than `olderThan` (mailbox TTL). Returns message ids dropped. */
  expirePending(recipient: string, olderThan: number): number[] {
    const ids = (
      this.db
        .prepare(
          'SELECT message_id FROM deliveries WHERE recipient = ? AND seen_at IS NULL AND error IS NULL AND written_at < ?',
        )
        .all(recipient, olderThan) as { message_id: number }[]
    ).map((r) => r.message_id)
    if (ids.length) {
      this.db
        .prepare(
          `UPDATE deliveries SET error = 'expired' WHERE recipient = ? AND seen_at IS NULL AND written_at < ?`,
        )
        .run(recipient, olderThan)
    }
    return ids
  }

  // ----------------------------------------------------------------- blobs

  totalBlobBytes(): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM blobs').get() as {
      n: number
    }
    return r.n
  }

  /** Blob refs attached to messages in a room, newest first. */
  blobsInRoom(room: string, limit = 200): RoomBlob[] {
    return this.db
      .prepare(
        `SELECT mb.message_id, m.from_agent AS "from", mb.blob_id AS id, mb.name, b.size, b.mime, m.created_at
         FROM message_blobs mb JOIN messages m ON m.id = mb.message_id JOIN blobs b ON b.sha256 = mb.blob_id
         WHERE m.room = ? ORDER BY mb.message_id DESC LIMIT ?`,
      )
      .all(room, limit) as RoomBlob[]
  }

  /** Link already-registered blobs to a message (bumps refcounts). */
  attachBlobs(messageId: number, blobs: BlobRef[]): void {
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO message_blobs(message_id, blob_id, name) VALUES (?, ?, ?)',
    )
    const bump = this.db.prepare('UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = ?')
    for (const b of blobs) {
      if (ins.run(messageId, b.id, b.name).changes > 0) bump.run(b.id)
    }
  }

  registerBlob(sha256: string, size: number, mime?: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO blobs(sha256, size, mime, created_at) VALUES (?, ?, ?, ?)')
      .run(sha256, size, mime ?? null, this.now())
  }

  getBlob(
    sha256: string,
  ): { sha256: string; size: number; mime: string | null; refcount: number } | null {
    const r = this.db
      .prepare('SELECT sha256, size, mime, refcount FROM blobs WHERE sha256 = ?')
      .get(sha256)
    return (
      (r as { sha256: string; size: number; mime: string | null; refcount: number } | undefined) ??
      null
    )
  }

  // --------------------------------------------------------------- invites

  createInvite(i: {
    code_hash: string
    name: string | null
    authority: 'bot' | 'relayer'
    backend: string | null
    created_by: string
    ttl_ms: number
  }): { expires_at: number } {
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO invites(code_hash, name, authority, backend, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(i.code_hash, i.name, i.authority, i.backend, i.created_by, now, now + i.ttl_ms)
    return { expires_at: now + i.ttl_ms }
  }

  /** Look at an invite without consuming it. */
  peekInvite(codeHash: string): { name: string | null; usable: boolean } | null {
    const row = this.db
      .prepare('SELECT name, used_at, expires_at FROM invites WHERE code_hash = ?')
      .get(codeHash) as
      | { name: string | null; used_at: number | null; expires_at: number }
      | undefined
    if (!row) return null
    return { name: row.name, usable: row.used_at === null && row.expires_at > this.now() }
  }

  /** Atomically consume an invite; null when unknown, expired or already used. */
  redeemInvite(
    codeHash: string,
    usedBy: string,
  ): { name: string | null; authority: 'bot' | 'relayer'; backend: string | null } | null {
    const now = this.now()
    const r = this.db
      .prepare(
        'UPDATE invites SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?',
      )
      .run(now, usedBy, codeHash, now)
    if (r.changes === 0) return null
    const row = this.db
      .prepare('SELECT name, authority, backend FROM invites WHERE code_hash = ?')
      .get(codeHash) as
      | { name: string | null; authority: 'bot' | 'relayer'; backend: string | null }
      | undefined
    return row ?? null
  }

  openInvites(): {
    name: string | null
    created_by: string
    created_at: number
    expires_at: number
  }[] {
    return this.db
      .prepare(
        'SELECT name, created_by, created_at, expires_at FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC',
      )
      .all(this.now()) as {
      name: string | null
      created_by: string
      created_at: number
      expires_at: number
    }[]
  }

  // ---------------------------------------------------------------- events

  appendEvent(
    kind: string,
    detail: Record<string, unknown> = {},
    agent?: string,
    room?: string,
  ): void {
    this.db
      .prepare('INSERT INTO events(kind, agent, room, detail_json, at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, agent ?? null, room ?? null, JSON.stringify(detail), this.now())
  }

  events(opts: { room?: string; since?: number; limit?: number } = {}): {
    id: number
    kind: string
    agent: string | null
    room: string | null
    detail: Record<string, unknown>
    at: number
  }[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE (? IS NULL OR room = ?) AND at >= ? ORDER BY id ASC LIMIT ?`,
      )
      .all(opts.room ?? null, opts.room ?? null, opts.since ?? 0, opts.limit ?? 1000) as {
      id: number
      kind: string
      agent: string | null
      room: string | null
      detail_json: string
      at: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      agent: r.agent,
      room: r.room,
      detail: JSON.parse(r.detail_json),
      at: r.at,
    }))
  }
}

export const EXPLICIT_STATE_TTL_MS = 10 * 60_000
export const ACTIVITY_WINDOW_MS = 60_000

function toAgentRow(r: Record<string, unknown>): AgentRow {
  return {
    name: r.name as string,
    backend: (r.backend as string | null) ?? null,
    authority: r.authority as Authority,
    token_hash: r.token_hash as string,
    capabilities: CapabilitiesSchema.parse(JSON.parse(r.capabilities_json as string)),
    cwd: (r.cwd as string | null) ?? null,
    session_id: (r.session_id as string | null) ?? null,
    online: r.online === 1,
    state: r.state as PresenceState,
    status_text: (r.status_text as string | null) ?? null,
    state_at: (r.state_at as number | null) ?? null,
    activity_at: (r.activity_at as number | null) ?? null,
    last_seen: (r.last_seen as number | null) ?? null,
    version: (r.version as string | null) ?? null,
    created_at: r.created_at as number,
  }
}

function toTask(r: Record<string, unknown>): Task {
  const ctx = (r.context as string | null) ?? null
  return {
    id: r.id as string,
    room: r.room as string,
    from: r.from_agent as string,
    to: r.to_agent as string,
    state: r.state as TaskState,
    description: r.description as string,
    ...(ctx ? { context: ctx } : {}),
    deadline: (r.deadline as number | null) ?? null,
    max_turns: (r.max_turns as number | null) ?? null,
    turns_used: r.turns_used as number,
    summary: (r.summary as string | null) ?? null,
    artifacts: JSON.parse(((r.artifacts_json as string) || '[]') as string) as BlobRef[],
    escalated: r.escalated === 1,
    created_at: r.created_at as number,
    updated_at: r.updated_at as number,
  }
}

function toDelivery(r: Record<string, unknown>): Delivery {
  const seen = (r.seen_at as number | null) ?? null
  const handled = (r.handled_at as number | null) ?? null
  return {
    message_id: r.message_id as number,
    recipient: r.recipient as string,
    state: handled ? 'handled' : seen ? 'seen' : 'written',
    via: r.via as DeliveryVia,
    written_at: r.written_at as number,
    seen_at: seen,
    handled_at: handled,
    attempts: r.attempts as number,
    error: (r.error as string | null) ?? null,
  }
}
