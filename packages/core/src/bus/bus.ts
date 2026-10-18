import { EventEmitter } from 'node:events'
import type {
  AgentInfo,
  BlobRef,
  ClientFrame,
  Delivery,
  DeliveryVia,
  InboxResult,
  Message,
  ResponseFrame,
  SendResult,
  ServerFrame,
  SystemKind,
  Task,
  TaskEventPayload,
  WaitResult,
} from '@agentbus/protocol'
import { dmParties, dmRoom, isDmRoom, isValidRoom, parseClientFrame } from '@agentbus/protocol'
import type { BusConfig } from '../config.js'
import type { Store } from '../store/store.js'
import { BusError } from './errors.js'
import { Guard } from './guard.js'
import { type Connection, Registry, type Session } from './registry.js'
import { TaskService } from './tasks.js'

/**
 * Whoever is acting: a WS session, or an HTTP participant identified by token. A standby
 * actor speaks for the name while the person is away: its sends mark only the rows it was
 * handed as handled and never move the interactive session's cursor.
 */
export interface Actor {
  name: string
  standby?: boolean
}
export type SendInput = Omit<Extract<ClientFrame, { type: 'send' }>, 'id' | 'type'>

export interface BusEvents {
  message: [Message, Delivery[]]
  delivery: [Delivery]
  system: [{ kind: SystemKind; room?: string; detail: Record<string, unknown> }]
  task: [Task]
  /** Agent list changed (register / disconnect / status). */
  presence: []
  /** A row the interactive session left unread was handed to the standby. */
  standby: [{ message: Message; recipient: string }]
}

/**
 * The bus core: one object that owns the store, registry, guard and delivery
 * engine (PRODUCT_DESIGN §4.2–§4.4, §5.5). Transport-agnostic: the WS server
 * feeds it parsed frames and `Connection`s; tests feed it fakes.
 */
export class Bus extends EventEmitter<BusEvents> {
  readonly registry: Registry
  readonly guard: Guard
  readonly tasks: TaskService

  constructor(
    readonly store: Store,
    readonly config: BusConfig,
    private readonly now: () => number = () => Date.now(),
  ) {
    super()
    this.registry = new Registry(store, config.heartbeat_timeout_ms, now)
    this.guard = new Guard(config.guard.cap, config.guard.min_interval_ms)
    this.tasks = new TaskService({
      store,
      config,
      now,
      resolveBlobs: (refs) => this.resolveBlobs(refs),
      post: (from, room, text, payload, taskId) => this.post(from, room, text, payload, taskId),
      humansFor: (room) => this.humansFor(room),
      ensureDmRoom: (a, b) => this.ensureDm(a, b),
      authorityOf: (name) => this.authorityOf(name),
      emitTask: (task) => this.emitTask(task),
    })
  }

  // ------------------------------------------------------------ dispatch

  /** Handle one raw client frame; always produces exactly one response. */
  handleRaw(conn: Connection, raw: unknown): ResponseFrame {
    let frame: ClientFrame
    try {
      frame = parseClientFrame(raw)
    } catch (e) {
      const id =
        typeof raw === 'object' && raw && typeof (raw as { id?: unknown }).id === 'string'
          ? (raw as { id: string }).id
          : '?'
      return fail(id, new BusError('bad_request', (e as Error).message))
    }
    return this.handle(conn, frame)
  }

  handle(conn: Connection, frame: ClientFrame): ResponseFrame {
    try {
      const result = this.dispatch(conn, frame)
      if (result === PENDING) return PENDING_RESPONSE(frame.id)
      return { type: 'response', id: frame.id, ok: true, result }
    } catch (e) {
      if (e instanceof BusError) return fail(frame.id, e)
      return fail(frame.id, new BusError('internal', (e as Error).message))
    }
  }

  private dispatch(conn: Connection, f: ClientFrame): unknown {
    if (f.type === 'register') {
      const res = this.registry.register(conn, f)
      // Flush whatever is waiting for this agent (mailbox) to a fresh control connection;
      // a fresh standby takes what is already overdue and starts the clock on the rest.
      if (f.role === 'control') {
        if (f.capabilities.standby) this.flushStandby(f.name)
        else this.flushPending(f.name)
      }
      this.emit('presence')
      return res
    }
    const s = this.registry.require(conn)
    this.registry.touch(conn)
    switch (f.type) {
      case 'heartbeat':
        this.store.touchAgent(s.name)
        return { now: this.now() }
      case 'agents':
        return { agents: this.agents() }
      case 'rooms':
        return { rooms: this.roomsFor(s.name) }
      case 'join':
        return this.join(s, f.room)
      case 'leave':
        return this.leave(s, f.room)
      case 'history':
        return { messages: this.history(s, f.room, f.limit, f.before) }
      case 'send':
        return this.send(s, f)
      case 'inbox':
        return s.standby
          ? ({ messages: this.standbyInbox(s.name), standby: [] } satisfies InboxResult)
          : this.inboxFull(s.name, f.peek === true)
      case 'ack':
        return { deliveries: this.ack(s.name, f.message_ids) }
      case 'status':
        return this.status(s, f.state, f.text)
      case 'wait':
        return this.wait(s, f.id, f.timeout_s, f.from)
      case 'task_create':
        return { task: this.tasks.create(s, f) }
      case 'task_update':
        return { task: this.tasks.update(s, f) }
      case 'task_cancel':
        return { task: this.tasks.cancel(s, f.task_id, f.reason) }
      case 'tasks':
        return {
          tasks: this.store.listTasks({
            ...(this.authorityOf(s.name) === 'human' ? {} : { agent: s.name }),
            ...(f.state ? { state: f.state } : {}),
            openOnly: f.open_only,
            limit: f.limit,
          }),
        }
      case 'turn_report':
        return {
          id: this.store.recordTurn({
            agent: s.name,
            session_id: f.session_id,
            message_ids: f.message_ids,
            started_at: f.started_at,
            ended_at: f.ended_at,
            tokens: f.tokens ?? null,
            sent: f.sent,
            exit_reason: f.exit_reason,
            recovered: f.recovered,
          }),
        }
    }
  }

  /** Transport hook: the connection went away. */
  disconnect(conn: Connection): void {
    const s = this.registry.unregister(conn)
    if (s?.role === 'control' && !this.registry.isOnline(s.name))
      this.store.setAgentState(s.name, 'unknown')
    if (s) this.emit('presence')
  }

  // ------------------------------------------------------------- queries

  agents(): AgentInfo[] {
    const now = this.now()
    return this.store.listAgents().map((a) => {
      const online = this.registry.isOnline(a.name)
      return {
        ...this.store.agentInfo(a),
        online,
        state: this.store.presence(a, online, now),
        standby: this.registry.standby(a.name) !== null,
      }
    })
  }

  roomsFor(
    name: string,
  ): { name: string; kind: 'dm' | 'room'; paused: boolean; members: string[] }[] {
    const authority = this.authorityOf(name)
    const rooms =
      authority === 'human'
        ? this.store.listRooms()
        : this.store
            .roomsOf(name)
            .map((r) => this.store.getRoom(r))
            .filter((r): r is NonNullable<typeof r> => r !== null)
    return rooms.map((r) => ({
      name: r.name,
      kind: r.kind,
      paused: r.paused,
      members: this.store.members(r.name),
    }))
  }

  history(s: Actor, room: string, limit: number, before?: number): Message[] {
    this.requireRoom(room)
    this.requireMember(s.name, room)
    return this.store.history(room, limit, before)
  }

  // ---------------------------------------------------------------- rooms

  join(s: Actor, room: string): { room: string; joined: boolean; members: string[] } {
    if (!isValidRoom(room) || isDmRoom(room))
      throw new BusError(
        'bad_request',
        'room name must be [a-z0-9][a-z0-9-]{0,63}; dms are implicit',
      )
    this.store.ensureRoom(room, 'room')
    const joined = this.store.addMember(room, s.name)
    if (joined) this.store.appendEvent('joined', {}, s.name, room)
    return { room, joined, members: this.store.members(room) }
  }

  /** Leave a named room: no more deliveries from it. The dm with someone cannot be left. */
  leave(s: Actor, room: string): { room: string; left: boolean } {
    if (isDmRoom(room)) throw new BusError('bad_request', 'a dm cannot be left; just stop replying')
    this.requireRoom(room)
    const left = this.store.removeMember(room, s.name)
    if (left) this.store.appendEvent('left', {}, s.name, room)
    return { room, left }
  }

  private requireRoom(room: string): void {
    if (!this.store.getRoom(room)) throw new BusError('unknown_room', `no room ${room}`)
  }

  private requireMember(name: string, room: string): void {
    if (this.store.isMember(room, name)) return
    if (this.authorityOf(name) === 'human') {
      // Humans may speak anywhere; speaking (or reading) joins them (§5.7).
      this.store.addMember(room, name)
      return
    }
    throw new BusError('not_member', `${name} is not a member of ${room}`)
  }

  private authorityOf(name: string): 'bot' | 'relayer' | 'human' {
    return this.store.getAgent(name)?.authority ?? 'bot'
  }

  // ----------------------------------------------------------------- send

  send(s: Actor, f: SendInput): SendResult {
    const sender = this.store.getAgent(s.name)
    if (!sender) throw new BusError('not_registered', 'sender vanished')
    if (Buffer.byteLength(f.text, 'utf8') > this.config.message.max_text_bytes)
      throw new BusError(
        'too_large',
        `text exceeds ${this.config.message.max_text_bytes} bytes; use a blob`,
      )
    const blobs = this.resolveBlobs(f.blobs)

    // Resolve target room (§5.7 membership rules).
    let room: string
    if (f.to) {
      if (f.to === s.name) throw new BusError('bad_request', 'cannot dm yourself')
      if (!this.store.getAgent(f.to)) throw new BusError('unknown_agent', `no agent ${f.to}`)
      room = dmRoom(s.name, f.to)
      this.store.ensureRoom(room, 'dm')
      this.store.addMember(room, s.name)
      this.store.addMember(room, f.to)
    } else {
      room = f.room as string
      // A dm addressed by room name (console, CLI) is created on first use, like one addressed by `to`.
      const parties = dmParties(room)
      if (parties && !this.store.getRoom(room)) {
        if (!parties.includes(s.name)) throw new BusError('not_member', `not a party of ${room}`)
        const other = parties[0] === s.name ? parties[1] : parties[0]
        if (other === s.name) throw new BusError('bad_request', 'cannot dm yourself')
        if (!this.store.getAgent(other)) throw new BusError('unknown_agent', `no agent ${other}`)
        this.ensureDm(s.name, other)
      }
      this.requireRoom(room)
      this.requireMember(s.name, room)
    }

    // Task threads are governed by the task budget, not the exchange guard (§4.4).
    if (f.task_id) {
      const task = this.store.getTask(f.task_id)
      if (!task) throw new BusError('bad_request', `no task ${f.task_id}`)
      if (task.room !== room)
        throw new BusError('bad_request', `task ${task.id} lives in ${task.room}, not ${room}`)
    }
    const roomRow = this.store.getRoom(room)
    const verdict = this.guard.check(room, s.name, sender.authority, this.now(), {
      pausedInStore: roomRow?.paused ?? false,
      exempt: f.task_id !== undefined,
    })
    if (verdict.kind === 'paused')
      throw new BusError(
        'paused',
        `room ${room} is paused after ${verdict.count} bot messages; a human must speak`,
      )
    if (verdict.kind === 'rate_limited')
      throw new BusError('rate_limited', `slow down`, verdict.retryInMs)

    const result = this.store.transaction(() => {
      const message = this.store.insertMessage({
        room,
        from: s.name,
        authority: sender.authority,
        text: f.text,
        ...(f.payload !== undefined ? { payload: f.payload } : {}),
        ...(f.task_id !== undefined ? { task_id: f.task_id } : {}),
        ...(blobs.length ? { blobs } : {}),
      })
      // Sending is activity: the sender has handled everything it received in this room so far.
      this.markSentHandled(s, room, message.id)
      const deliveries = this.deliver(message)
      return { message, deliveries }
    })
    // Count the thread message against the task budget (may close the task).
    if (f.task_id) this.tasks.onThreadMessage(s.name, f.task_id, sender.authority)

    if (verdict.clearedPause && roomRow?.paused) {
      this.store.setRoomPaused(room, false)
      this.system('resumed', room, { by: s.name })
    }
    if (verdict.reachedCap && !roomRow?.paused) {
      this.store.setRoomPaused(room, true)
      this.system('paused', room, { count: verdict.count, cap: this.guard.cap })
    }

    this.emit('message', result.message, result.deliveries)
    return result
  }

  /**
   * What a send implies for the sender's own deliveries in that room: what it had read (or had
   * pushed into its context) there is handled. The read cursor does not move, so a reply that
   * arrived while the sender was busy is still unread afterwards. The standby only answers for
   * the rows it pulled and never touches the person's rows or cursor.
   */
  private markSentHandled(s: Actor, room: string, upTo: number): void {
    if (s.standby) this.store.markStandbyHandledUpTo(s.name, room, upTo)
    else this.store.markHandledUpTo(s.name, room, upTo)
    this.store.touchActivity(s.name)
  }

  // ------------------------------------------------------------- delivery

  /**
   * Write one delivery per recipient and pick the path (§4.2) from what the recipient's
   * newest interactive connection declared: driver / push (event to the live control
   * connections), wait (resolve the parked request, counts as seen), or mailbox (written
   * only). A row that waits on the person (mailbox or push) also starts the standby clock
   * when a standby is connected for the name.
   */
  private deliver(message: Message): Delivery[] {
    const out: Delivery[] = []
    for (const recipient of this.store.members(message.room)) {
      if (recipient === message.from) continue
      const agent = this.store.getAgent(recipient)
      if (!agent) continue
      const ctls = this.registry.interactive(recipient)
      const ctl = ctls[ctls.length - 1] ?? null
      // A wait narrowed to one sender ignores everyone else: their rows go the normal way.
      const waiting = ctls.filter(
        (c) => c.waiting && (!c.waiting.from || c.waiting.from === message.from),
      )

      // A parked wait is the recipient asking for exactly this; honour it first.
      let via: DeliveryVia = 'mailbox'
      if (waiting.length) via = 'wait'
      else if (ctl?.capabilities.driver) via = 'driver'
      else if (ctl?.capabilities.push) via = 'push'

      const d = this.store.insertDelivery(message.id, recipient, via)
      if (via === 'mailbox') {
        for (const dropped of this.store.capPending(recipient, this.config.mailbox.max_per_agent)) {
          const m = this.store.getMessage(dropped)
          if (m) this.notifyUndeliverable(m, recipient, 'mailbox_full')
        }
      }

      if (via === 'wait') {
        for (const w of waiting) this.resolveWait(w) // marks seen through the cursor
        out.push(this.store.getDelivery(message.id, recipient) ?? d)
      } else {
        if (via === 'driver' || via === 'push')
          for (const c of ctls) c.conn.send({ type: 'event', event: 'message', message })
        if (via === 'push') this.armPushDegrade(message.id, recipient)
        if (via === 'mailbox' || via === 'push') this.armStandby(message.id, recipient)
        out.push(d)
      }
    }
    return out
  }

  // -------------------------------------------------------------- standby

  /**
   * The person's session has `standby.delay_s` to read a row; after that a connected standby
   * takes it. The timer is the prompt path; `tick()` sweeps the same condition so nothing is
   * lost across a bus restart or a standby that connects later.
   */
  private armStandby(messageId: number, recipient: string, delayMs?: number): void {
    if (!this.registry.standby(recipient)) return
    const timer = setTimeout(
      () => this.handToStandby(messageId, recipient),
      delayMs ?? this.config.standby.delay_s * 1000,
    )
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  }

  /** Relabel one unread interactive row as the standby's and push it to the standby connection. */
  private handToStandby(messageId: number, recipient: string): boolean {
    const d = this.store.getDelivery(messageId, recipient)
    if (!d || d.seen_at !== null || d.error !== null) return false
    if (d.via !== 'mailbox' && d.via !== 'push' && d.via !== 'push->mailbox') return false
    const sb = this.registry.standby(recipient)
    if (!sb) return false
    const message = this.store.getMessage(messageId)
    if (!message) return false
    this.store.setDeliveryVia(messageId, recipient, 'standby')
    this.store.appendEvent(
      'standby',
      { message_id: messageId, recipient, from: d.via },
      recipient,
      message.room,
    )
    sb.conn.send({ type: 'event', event: 'message', message })
    const updated = this.store.getDelivery(messageId, recipient)
    if (updated) this.emit('delivery', updated)
    this.emit('standby', { message, recipient })
    return true
  }

  /** Hand every overdue interactive row of `name` to its standby; returns how many moved. */
  private standbySweep(name: string): number {
    const cutoff = this.now() - this.config.standby.delay_s * 1000
    let n = 0
    for (const d of this.store.pendingInteractive(name))
      if (d.written_at <= cutoff && this.handToStandby(d.message_id, name)) n++
    return n
  }

  /** A standby just connected: take what is overdue now, time the rest. */
  private flushStandby(name: string): void {
    const delayMs = this.config.standby.delay_s * 1000
    const now = this.now()
    for (const d of this.store.pendingInteractive(name)) {
      const due = d.written_at + delayMs - now
      if (due <= 0) this.handToStandby(d.message_id, name)
      else this.armStandby(d.message_id, name, due)
    }
  }

  /** The standby's inbox: only rows handed to it, marked seen one by one; the person's cursor is untouched. */
  standbyInbox(name: string): Message[] {
    const rows = this.store.pendingStandby(name)
    for (const m of rows) this.store.markSeen(m.id, name)
    return rows
  }

  /**
   * push never gets past `written` by itself (Claude Code does not acknowledge channel
   * notifications, §4.1). If the adapter has not pulled it within `push.seen_timeout_s`
   * the delivery is relabelled as having fallen back to the mailbox (F-D9).
   */
  private armPushDegrade(messageId: number, recipient: string): void {
    const timer = setTimeout(() => {
      const d = this.store.getDelivery(messageId, recipient)
      if (!d || d.seen_at !== null || d.via !== 'push') return
      this.store.setDeliveryVia(messageId, recipient, 'push->mailbox')
      const updated = this.store.getDelivery(messageId, recipient)
      if (updated) this.emit('delivery', updated)
    }, this.config.push.seen_timeout_s * 1000)
    // Never keep the process alive just for this.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  }

  /** On (re)connect of an interactive control session: hand over everything still unseen. */
  private flushPending(name: string): void {
    const ctl = this.registry.control(name)
    if (!ctl) return
    const pending = this.store.pendingFor(name)
    if (!pending.length) return
    if (ctl.capabilities.driver || ctl.capabilities.push) {
      const via: DeliveryVia = ctl.capabilities.driver ? 'driver' : 'push'
      for (const m of pending) {
        this.store.setDeliveryVia(m.id, name, via)
        ctl.conn.send({ type: 'event', event: 'message', message: m })
      }
    }
    // inbox-only agents fetch on their next turn; nothing to do.
  }

  /** `inbox()`: unread across all rooms, oldest first; advances cursors (= seen) unless peeking. */
  inbox(name: string, peek = false): Message[] {
    return this.inboxFull(name, peek).messages
  }

  /**
   * The interactive session's full look: unread rows, plus the rows its standby took over
   * that it has not been shown yet. Those are shown exactly once (their own cursor moves
   * even on a peek, since a hook is the usual reader) and are never counted as unread.
   */
  inboxFull(name: string, peek = false): InboxResult {
    const messages: Message[] = []
    const standby: Message[] = []
    for (const room of this.store.roomsOf(name)) {
      const after = this.store.getCursor(name, room)
      const msgs = this.store.unreadFor(name, room, after, 500)
      // Advance past everything (including own / dropped messages) up to the newest in the room.
      const newest = this.store.history(room, 1)[0]
      if (!peek && newest && newest.id > after) this.markRoomSeen(name, room, newest.id)
      for (const m of msgs) messages.push(m)
      const shown = Math.max(after, this.store.getStandbyCursor(name, room))
      const taken = this.store.standbyRowsFor(name, room, shown, 500)
      if (taken.length) {
        this.store.advanceStandbyCursor(name, room, (taken[taken.length - 1] as Message).id)
        for (const m of taken) standby.push(m)
      }
    }
    messages.sort((a, b) => a.id - b.id)
    standby.sort((a, b) => a.id - b.id)
    return { messages, standby }
  }

  private markRoomSeen(name: string, room: string, upTo: number): void {
    this.store.advanceCursor(name, room, upTo)
    this.store.markSeenUpTo(name, room, upTo)
  }

  /** Explicit `ack`: the agent acted on these messages (handled). */
  ack(name: string, ids: number[]): Delivery[] {
    const out: Delivery[] = []
    for (const id of ids) {
      const d = this.store.markHandled(id, name)
      if (d) {
        out.push(d)
        this.emit('delivery', d)
      }
    }
    return out
  }

  status(s: Actor, state?: 'working' | 'idle' | 'blocked', text?: string): { ok: true } {
    this.store.setAgentState(s.name, state ?? 'working', text ?? null)
    this.emit('presence')
    return { ok: true }
  }

  // ----------------------------------------------------------------- tasks

  private resolveBlobs(refs: { id: string; name: string }[] | undefined): BlobRef[] {
    const out: BlobRef[] = []
    for (const b of refs ?? []) {
      const row = this.store.getBlob(b.id)
      if (!row) throw new BusError('bad_request', `unknown blob ${b.id.slice(0, 12)}`)
      out.push({ id: b.id, name: b.name, size: row.size, ...(row.mime ? { mime: row.mime } : {}) })
    }
    return out
  }

  private ensureDm(a: string, b: string): string {
    const room = dmRoom(a, b)
    this.store.ensureRoom(room, 'dm')
    this.store.addMember(room, a)
    this.store.addMember(room, b)
    return room
  }

  /** Humans (or relayers) who could be asked for input: room members first, then anyone online. */
  private humansFor(room: string): string[] {
    const humans = this.store
      .listAgents()
      .filter((a) => a.authority !== 'bot')
      .map((a) => ({ name: a.name, online: this.registry.isOnline(a.name) }))
    const members = new Set(this.store.members(room))
    const score = (h: { name: string; online: boolean }) =>
      (members.has(h.name) ? 2 : 0) + (h.online ? 1 : 0) + (h.name === 'owner' ? 0.5 : 0)
    return humans.sort((a, b) => score(b) - score(a)).map((h) => h.name)
  }

  /**
   * Bus- or task-originated message: bypasses the exchange guard (task threads have their
   * own budget) and the rate limit, but is delivered and recorded like any other message.
   */
  private post(
    from: Actor,
    room: string,
    text: string,
    payload: TaskEventPayload,
    taskId: string,
  ): Message {
    const authority = from.name === 'bus' ? 'bot' : this.authorityOf(from.name)
    const result = this.store.transaction(() => {
      const message = this.store.insertMessage({
        room,
        from: from.name,
        authority,
        text,
        payload,
        task_id: taskId,
      })
      if (from.name !== 'bus') this.markSentHandled(from, room, message.id)
      const deliveries = this.deliver(message)
      return { message, deliveries }
    })
    this.emit('message', result.message, result.deliveries)
    return result.message
  }

  private emitTask(task: Task): void {
    const frame: ServerFrame = { type: 'event', event: 'task', task }
    for (const name of this.store.members(task.room))
      for (const c of this.registry.controls(name)) c.conn.send(frame)
    this.emit('task', task)
  }

  // ----------------------------------------------------------------- wait

  /**
   * `wait_for_message`: respond at once if anything is pending, otherwise park the
   * request until a delivery arrives or the timeout elapses (§4.1 inbox/wait).
   */
  private wait(s: Session, requestId: string, timeoutS: number, from?: string): unknown {
    if (s.role !== 'control' || s.standby)
      throw new BusError('bad_request', 'only an interactive control connection can wait')
    if (s.waiting) throw new BusError('bad_request', 'already waiting')
    // Rows the standby already took are information, not a reason to return: they ride along
    // with the next real batch. Look first, take only when there is something to take.
    if (this.glanceUnread(s.name).some((m) => !from || m.from === from)) {
      const taken = this.takeForWait(s.name, from)
      return { ...taken, timed_out: false } satisfies WaitResult
    }
    const timer = setTimeout(() => {
      if (s.waiting?.requestId !== requestId) return
      s.waiting = null
      s.conn.send({
        type: 'response',
        id: requestId,
        ok: true,
        result: { messages: [], standby: [], timed_out: true } satisfies WaitResult,
      })
    }, timeoutS * 1000)
    s.waiting = { requestId, timer, ...(from ? { from } : {}) }
    return PENDING
  }

  /** Unread rows without touching any cursor (not even the standby's shown-once cursor). */
  private glanceUnread(name: string): Message[] {
    const out: Message[] = []
    for (const room of this.store.roomsOf(name))
      for (const m of this.store.unreadFor(name, room, this.store.getCursor(name, room), 500))
        out.push(m)
    return out
  }

  /**
   * What a wait hands back: the whole inbox (marks everything seen), or — narrowed to one
   * sender — only that sender's rows, marked seen one by one so everyone else's stay unread
   * for the next `inbox` / hook pull instead of being swallowed by the cursor.
   */
  private takeForWait(name: string, from?: string): InboxResult {
    if (!from) return this.inboxFull(name)
    const all = this.inboxFull(name, true)
    const mine = all.messages.filter((m) => m.from === from)
    for (const m of mine) this.store.markSeen(m.id, name)
    return { messages: mine, standby: all.standby }
  }

  private resolveWait(s: Session): void {
    const w = s.waiting
    if (!w) return
    clearTimeout(w.timer)
    s.waiting = null
    const taken = this.takeForWait(s.name, w.from)
    s.conn.send({
      type: 'response',
      id: w.requestId,
      ok: true,
      result: { ...taken, timed_out: false } satisfies WaitResult,
    })
  }

  // --------------------------------------------------------------- system

  private system(
    kind: SystemKind,
    room: string | undefined,
    detail: Record<string, unknown>,
  ): void {
    this.store.appendEvent(kind, detail, undefined, room)
    const frame: ServerFrame = {
      type: 'event',
      event: 'system',
      kind,
      ...(room !== undefined ? { room } : {}),
      detail,
    }
    const targets = room ? this.store.members(room) : this.store.listAgents().map((a) => a.name)
    for (const name of targets) for (const c of this.registry.controls(name)) c.conn.send(frame)
    this.emit('system', { kind, ...(room !== undefined ? { room } : {}), detail })
  }

  /** Operator action: pause a room (bots cannot send until a human speaks or resumes). */
  pause(room: string, by: string): boolean {
    const row = this.store.getRoom(room)
    if (!row) throw new BusError('unknown_room', `no room ${room}`)
    if (row.paused) return false
    this.guard.forcePause(room)
    this.store.setRoomPaused(room, true)
    this.system('paused', room, { by, forced: true })
    return true
  }

  /** Operator action (console / CLI): lift a pause without a human message. */
  resume(room: string, by: string): boolean {
    const was = this.guard.reset(room)
    const row = this.store.getRoom(room)
    if (row?.paused) {
      this.store.setRoomPaused(room, false)
      this.system('resumed', room, { by, forced: true })
      return true
    }
    return was
  }

  /** Periodic housekeeping: dead connections and mailbox TTL. */
  tick(): void {
    const swept = this.registry.sweep()
    for (const name of swept) this.store.setAgentState(name, 'unknown')
    if (swept.length) this.emit('presence')
    for (const t of this.tasks.sweep(this.now()))
      this.system('task_budget', t.room, { task_id: t.id, reason: 'deadline' })
    for (const name of this.registry.standbyNames()) this.standbySweep(name)
    const cutoff = this.now() - this.config.mailbox.ttl_hours * 3_600_000
    for (const a of this.store.listAgents()) {
      const dropped = this.store.expirePending(a.name, cutoff)
      for (const id of dropped) {
        const m = this.store.getMessage(id)
        if (m) this.notifyUndeliverable(m, a.name, 'expired')
      }
    }
  }

  private notifyUndeliverable(m: Message, recipient: string, reason: string): void {
    const detail = { message_id: m.id, recipient, reason }
    this.store.appendEvent('undeliverable', detail, m.from, m.room)
    for (const c of this.registry.controls(m.from))
      c.conn.send({ type: 'event', event: 'system', kind: 'undeliverable', room: m.room, detail })
    this.emit('system', { kind: 'undeliverable', room: m.room, detail })
  }

  /** Human/room helpers used by the CLI. */
  dmPartnerOf(room: string, me: string): string | null {
    const p = dmParties(room)
    if (!p) return null
    return p[0] === me ? p[1] : p[0]
  }
}

// A sentinel for requests whose response is sent later (wait).
const PENDING = Symbol('pending')
const PENDING_RESPONSE = (id: string): ResponseFrame =>
  ({ type: 'response', id, ok: true, result: PENDING }) as unknown as ResponseFrame

export function isPendingResponse(r: ResponseFrame): boolean {
  return r.ok && (r as { result: unknown }).result === PENDING
}

function fail(id: string, e: BusError): ResponseFrame {
  return {
    type: 'response',
    id,
    ok: false,
    error: {
      code: e.code,
      message: e.message,
      ...(e.retryInMs !== undefined ? { retry_in_ms: e.retryInMs } : {}),
    },
  }
}
