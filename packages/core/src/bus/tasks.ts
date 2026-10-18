import { randomBytes } from 'node:crypto'
import type { BlobRef, Message, Task, TaskEventPayload, TaskState } from '@agentbus/protocol'
import { canTransition, dmRoom, TERMINAL_TASK_STATES } from '@agentbus/protocol'
import type { BusConfig } from '../config.js'
import type { Store } from '../store/store.js'
import type { Actor } from './bus.js'
import { BusError } from './errors.js'

/** What the task service needs from the bus; keeps this module testable in isolation. */
export interface TaskHost {
  store: Store
  config: BusConfig
  now(): number
  /** Resolve `{id,name}` references into full refs; throws bad_request for unknown blobs. */
  resolveBlobs(refs: { id: string; name: string }[] | undefined): BlobRef[]
  /** Post a message into a room on behalf of an actor (guard-exempt when task_id is set). */
  post(from: Actor, room: string, text: string, payload: TaskEventPayload, taskId: string): Message
  /** Humans with authority who can be escalated to: in the room first, then anywhere. */
  humansFor(room: string): string[]
  ensureDmRoom(a: string, b: string): string
  authorityOf(name: string): 'bot' | 'relayer' | 'human'
  emitTask(task: Task): void
}

export function newTaskId(now: number): string {
  return `t_${now.toString(36)}${randomBytes(3).toString('hex')}`
}

/**
 * Task state machine (PRODUCT_DESIGN §4.5, F-T1–F-T5). The bus validates every transition,
 * `task_events` is append-only, tasks live in the room they were created in, and the
 * budget (`deadline`, `max_turns`) is enforced here rather than by the exchange guard.
 */
export class TaskService {
  constructor(private readonly h: TaskHost) {}

  create(
    actor: Actor,
    req: {
      to: string
      description: string
      context?: string | undefined
      room?: string | undefined
      blobs?: { id: string; name: string }[] | undefined
      deadline_s?: number | null | undefined
      max_turns?: number | null | undefined
    },
  ): Task {
    const from = actor.name
    if (req.to === from) throw new BusError('bad_request', 'cannot assign a task to yourself')
    if (!this.h.store.getAgent(req.to)) throw new BusError('unknown_agent', `no agent ${req.to}`)
    const room = req.room ?? this.h.ensureDmRoom(from, req.to)
    if (req.room) {
      if (!this.h.store.getRoom(room)) throw new BusError('unknown_room', `no room ${room}`)
      if (!this.h.store.isMember(room, req.to))
        throw new BusError('not_member', `${req.to} is not in ${room}`)
    }
    const now = this.h.now()
    const deadlineS = req.deadline_s === undefined ? this.h.config.tasks.deadline_s : req.deadline_s
    const maxTurns = req.max_turns === undefined ? this.h.config.tasks.max_turns : req.max_turns
    const task = this.h.store.createTask({
      id: newTaskId(now),
      room,
      from,
      to: req.to,
      description: req.description,
      ...(req.context ? { context: req.context } : {}),
      deadline: deadlineS === null ? null : now + deadlineS * 1000,
      max_turns: maxTurns,
    })
    const blobs = this.h.resolveBlobs(req.blobs)
    const lines = [
      `[task ${task.id}] ${from} → ${req.to}: ${req.description}`,
      req.context ? `context: ${req.context}` : '',
      `budget: ${task.max_turns ?? '∞'} bot messages, deadline ${task.deadline ? new Date(task.deadline).toISOString() : 'none'}. ` +
        `Executor: report with task_update(state=working|input-required|completed|failed).`,
    ].filter(Boolean)
    this.postWithBlobs(actor, room, lines.join('\n'), task, null, blobs)
    this.h.emitTask(task)
    return task
  }

  update(
    actor: Actor,
    req: {
      task_id: string
      state: 'working' | 'input-required' | 'completed' | 'failed'
      summary?: string | undefined
      blobs?: { id: string; name: string }[] | undefined
      escalate?: boolean | undefined
    },
  ): Task {
    const by = actor.name
    const task = this.require(req.task_id)
    const authority = this.h.authorityOf(by)
    if (by !== task.to && authority !== 'human')
      throw new BusError(
        'unauthorized',
        `only ${task.to} (executor) or a human may update ${task.id}`,
      )
    this.assertTransition(task, req.state)
    const blobs = this.h.resolveBlobs(req.blobs)
    const escalateNow =
      req.state === 'input-required' &&
      (req.escalate === true || this.h.authorityOf(task.from) === 'bot')
    const updated = this.h.store.transitionTask(
      task.id,
      req.state,
      by,
      req.summary ?? null,
      blobs,
      {
        escalated: escalateNow,
      },
    )
    const text = `[task ${task.id}] ${task.state} → ${req.state}${req.summary ? `: ${req.summary}` : ''}`
    this.postWithBlobs(actor, task.room, text, updated, task.state, blobs, escalateNow)
    if (escalateNow) this.escalate(updated, req.summary ?? null)
    this.h.emitTask(updated)
    return updated
  }

  cancel(actor: Actor, taskId: string, reason?: string): Task {
    const by = actor.name
    const task = this.require(taskId)
    const authority = this.h.authorityOf(by)
    if (by !== task.from && authority !== 'human')
      throw new BusError(
        'unauthorized',
        `only ${task.from} (dispatcher) or a human may cancel ${task.id}`,
      )
    this.assertTransition(task, 'canceled')
    const updated = this.h.store.transitionTask(task.id, 'canceled', by, reason ?? null, [])
    this.h.post(
      actor,
      task.room,
      `[task ${task.id}] ${task.state} → canceled${reason ? `: ${reason}` : ''}`,
      {
        kind: 'task_event',
        task_id: task.id,
        state: 'canceled',
        from_state: task.state,
        ...(reason ? { reason } : {}),
      },
      task.id,
    )
    this.h.emitTask(updated)
    return updated
  }

  /**
   * Called by the bus for every message carrying `task_id`. Validates membership, counts
   * bot messages against `max_turns` and fails the task when the budget is exhausted.
   * Returns false when the message must be refused (closed task).
   */
  onThreadMessage(from: string, taskId: string, authority: 'bot' | 'relayer' | 'human'): void {
    const task = this.require(taskId)
    if (TERMINAL_TASK_STATES.includes(task.state))
      throw new BusError('bad_request', `task ${task.id} is ${task.state}; send without task_id`)
    if (authority !== 'bot') return
    const used = this.h.store.bumpTaskTurns(task.id)
    if (task.max_turns !== null && used >= task.max_turns) {
      // This message is the last one allowed; the thread is now closed.
      this.failBudget(this.h.store.getTask(task.id) as Task, `max_turns ${task.max_turns} reached`)
    }
    void from
  }

  /** Housekeeping: deadlines. */
  sweep(now: number): Task[] {
    const failed: Task[] = []
    for (const t of this.h.store.overdueTasks(now))
      failed.push(this.failBudget(t, 'deadline passed'))
    return failed
  }

  // ------------------------------------------------------------- internals

  private require(id: string): Task {
    const t = this.h.store.getTask(id)
    if (!t) throw new BusError('bad_request', `no task ${id}`)
    return t
  }

  private assertTransition(task: Task, to: TaskState): void {
    if (!canTransition(task.state, to))
      throw new BusError('bad_request', `task ${task.id}: illegal transition ${task.state} → ${to}`)
  }

  private failBudget(task: Task, reason: string): Task {
    const updated = this.h.store.transitionTask(task.id, 'failed', 'bus', `budget: ${reason}`, [])
    this.h.post(
      { name: 'bus' },
      task.room,
      `[task ${task.id}] ${task.state} → failed (budget: ${reason}). ${task.from} and ${task.to}: stop; a human may open a new task.`,
      {
        kind: 'task_event',
        task_id: task.id,
        state: 'failed',
        from_state: task.state,
        reason: `budget: ${reason}`,
      },
      task.id,
    )
    this.h.emitTask(updated)
    return updated
  }

  /** input-required with a bot dispatcher (or explicit escalate): make sure a human hears it. */
  private escalate(task: Task, summary: string | null): void {
    const humans = this.h.humansFor(task.room)
    const inRoom = humans.filter((h) => this.h.store.isMember(task.room, h))
    if (inRoom.length) return // room members already received the input-required message
    const target = humans[0]
    if (!target) return
    const dm = this.h.ensureDmRoom(task.to, target)
    this.h.post(
      { name: task.to },
      dm,
      `[task ${task.id}] needs input and its dispatcher ${task.from} is a bot. ${summary ?? task.description}\nReply in room ${task.room} (or here) to unblock.`,
      {
        kind: 'task_event',
        task_id: task.id,
        state: 'input-required',
        from_state: task.state,
        escalated: true,
      },
      task.id,
    )
  }

  private postWithBlobs(
    from: Actor,
    room: string,
    text: string,
    task: Task,
    fromState: TaskState | null,
    blobs: BlobRef[],
    escalated = false,
  ): void {
    const payload: TaskEventPayload = {
      kind: 'task_event',
      task_id: task.id,
      state: task.state,
      from_state: fromState,
      ...(escalated ? { escalated: true } : {}),
    }
    const msg = this.h.post(from, room, text, payload, task.id)
    if (blobs.length) this.h.store.attachBlobs(msg.id, blobs)
  }
}

export { dmRoom }
