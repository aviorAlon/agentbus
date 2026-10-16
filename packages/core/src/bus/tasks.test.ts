import type { ServerFrame, Task } from '@agentbus/protocol'
import { describe, expect, it } from 'vitest'
import { generateToken, hashToken } from '../auth/token.js'
import { loadConfig } from '../config.js'
import { Store } from '../store/store.js'
import { Bus } from './bus.js'
import type { Connection } from './registry.js'

class FakeConn implements Connection {
  frames: ServerFrame[] = []
  send(f: ServerFrame): void {
    this.frames.push(f)
  }
  close(): void {}
  tasks(): Task[] {
    return this.frames
      .filter((f) => f.type === 'event' && f.event === 'task')
      .map((f) => (f as { task: Task }).task)
  }
}

function setup(cfg: Record<string, unknown> = {}) {
  let now = 1_000_000
  const store = new Store(':memory:', { clock: () => now })
  const bus = new Bus(
    store,
    loadConfig({
      guard: { cap: 3, min_interval_ms: 0 },
      tasks: { max_turns: 4, deadline_s: 60 },
      ...cfg,
    }),
    () => now,
  )
  const tokens = new Map<string, string>()
  const conns = new Map<string, FakeConn>()
  let seq = 0
  const call = (name: string, frame: Record<string, unknown>) =>
    bus.handleRaw(conns.get(name) as FakeConn, { id: String(++seq), ...frame })
  const ok = <T = Record<string, unknown>>(name: string, frame: Record<string, unknown>): T => {
    const r = call(name, frame)
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
    return r.result as T
  }
  const mk = (name: string, authority: 'bot' | 'human' = 'bot', driver = false) => {
    const t = generateToken()
    tokens.set(name, t)
    store.createAgent({ name, token_hash: hashToken(t), authority })
    const c = new FakeConn()
    conns.set(name, c)
    const r = bus.handleRaw(c, {
      id: 'r',
      type: 'register',
      name,
      token: t,
      role: 'control',
      capabilities: { inbox: true, push: false, ...(driver ? { driver: { kind: 'acp' } } : {}) },
    })
    if (!r.ok) throw new Error('register failed')
    return c
  }
  return {
    store,
    bus,
    mk,
    call,
    ok,
    conns,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('tasks', () => {
  it('create → working → completed with artifacts; events append-only; thread messages tagged', () => {
    const { store, mk, ok, call, conns } = setup()
    mk('alpha')
    mk('gamma', 'bot', true)
    const sha = 'b'.repeat(64)
    store.registerBlob(sha, 5, 'text/plain')

    const { task } = ok<{ task: Task }>('alpha', {
      type: 'task_create',
      to: 'gamma',
      description: 'fix it',
      context: 'see PR 12',
    })
    expect(task).toMatchObject({
      state: 'submitted',
      from: 'alpha',
      to: 'gamma',
      room: 'dm:alpha|gamma',
      max_turns: 4,
    })
    expect(task.deadline).toBe(1_000_000 + 60_000)
    // the task message landed in the dm and reached gamma (driver event) with task_id
    const msgs = store.history('dm:alpha|gamma', 10)
    expect(msgs[0]).toMatchObject({ from: 'alpha', task_id: task.id })
    expect(msgs[0]?.text).toContain('fix it')
    expect((conns.get('gamma') as FakeConn).tasks().at(-1)?.state).toBe('submitted')

    // only the executor may update; dispatcher cannot
    expect(
      call('alpha', { type: 'task_update', task_id: task.id, state: 'working' }),
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    // illegal transition rejected
    expect(
      call('gamma', { type: 'task_update', task_id: task.id, state: 'completed' }),
    ).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    ok('gamma', { type: 'task_update', task_id: task.id, state: 'working', summary: 'on it' })
    // thread message from executor counts as a turn
    ok('gamma', { type: 'send', to: 'alpha', text: 'question?', task_id: task.id })
    expect(store.getTask(task.id)?.turns_used).toBe(1)
    const done = ok<{ task: Task }>('gamma', {
      type: 'task_update',
      task_id: task.id,
      state: 'completed',
      summary: 'patched',
      blobs: [{ id: sha, name: 'patch.diff' }],
    })
    expect(done.task.state).toBe('completed')
    expect(done.task.artifacts).toEqual([
      { id: sha, name: 'patch.diff', size: 5, mime: 'text/plain' },
    ])
    expect(store.taskEvents(task.id).map((e) => e.to_state)).toEqual([
      'submitted',
      'working',
      'completed',
    ])
    // closed thread refuses further tagged messages
    expect(
      call('alpha', { type: 'send', to: 'gamma', text: 'thanks', task_id: task.id }),
    ).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    // tasks listing
    expect(ok<{ tasks: Task[] }>('alpha', { type: 'tasks', open_only: false }).tasks).toHaveLength(
      1,
    )
    expect(ok<{ tasks: Task[] }>('alpha', { type: 'tasks' }).tasks).toHaveLength(0)
  })

  it('max_turns budget fails the task and task threads bypass the exchange guard', () => {
    const { store, mk, ok, call } = setup() // guard cap 3, max_turns 4
    mk('alpha')
    mk('gamma')
    const { task } = ok<{ task: Task }>('alpha', {
      type: 'task_create',
      to: 'gamma',
      description: 'chat',
      max_turns: 4,
    })
    // 4 bot messages in the thread would trip the guard (cap 3) if they counted; they must not.
    ok('gamma', { type: 'send', to: 'alpha', text: '1', task_id: task.id })
    ok('alpha', { type: 'send', to: 'gamma', text: '2', task_id: task.id })
    ok('gamma', { type: 'send', to: 'alpha', text: '3', task_id: task.id })
    expect(store.getRoom('dm:alpha|gamma')?.paused).toBe(false)
    ok('alpha', { type: 'send', to: 'gamma', text: '4', task_id: task.id }) // reaches max_turns → failed
    const t = store.getTask(task.id) as Task
    expect(t.state).toBe('failed')
    expect(t.summary).toContain('max_turns')
    const last = store.history('dm:alpha|gamma', 1)[0]
    expect(last).toMatchObject({ from: 'bus', task_id: task.id })
    expect(last?.text).toContain('budget')
    expect(call('gamma', { type: 'send', to: 'alpha', text: '5', task_id: task.id })).toMatchObject(
      { ok: false },
    )
    // untagged chatter still falls under the guard (cap 3)
    ok('gamma', { type: 'send', to: 'alpha', text: 'a' })
    ok('alpha', { type: 'send', to: 'gamma', text: 'b' })
    ok('gamma', { type: 'send', to: 'alpha', text: 'c' })
    expect(store.getRoom('dm:alpha|gamma')?.paused).toBe(true)
  })

  it('deadline sweep fails open tasks and notifies', () => {
    const { store, bus, mk, ok, advance, conns } = setup()
    mk('alpha')
    mk('gamma')
    const { task } = ok<{ task: Task }>('alpha', {
      type: 'task_create',
      to: 'gamma',
      description: 'slow',
      deadline_s: 10,
    })
    advance(5_000)
    bus.tick()
    expect(store.getTask(task.id)?.state).toBe('submitted')
    advance(6_000)
    bus.tick()
    expect(store.getTask(task.id)?.state).toBe('failed')
    expect(store.getTask(task.id)?.summary).toContain('deadline')
    const sys = (conns.get('alpha') as FakeConn).frames.find(
      (f) =>
        f.type === 'event' &&
        f.event === 'system' &&
        (f as { kind: string }).kind === 'task_budget',
    )
    expect(sys).toBeDefined()
  })

  it('input-required from a bot dispatcher escalates to a human outside the room; cancel is dispatcher/human only', () => {
    const { store, mk, ok, call } = setup()
    mk('alpha')
    mk('gamma')
    mk('me', 'human')
    const { task } = ok<{ task: Task }>('alpha', {
      type: 'task_create',
      to: 'gamma',
      description: 'needs a decision',
    })
    ok('gamma', { type: 'task_update', task_id: task.id, state: 'working' })
    const upd = ok<{ task: Task }>('gamma', {
      type: 'task_update',
      task_id: task.id,
      state: 'input-required',
      summary: 'which db?',
    })
    expect(upd.task.escalated).toBe(true)
    // the human, not a member of the dm, got a dm from the executor about it
    const dm = store.history('dm:gamma|me', 5)
    expect(dm).toHaveLength(1)
    expect(dm[0]?.text).toContain(task.id)
    expect(dm[0]?.text).toContain('which db?')
    // back to working, then gamma cannot cancel but alpha can
    ok('gamma', { type: 'task_update', task_id: task.id, state: 'working' })
    expect(call('gamma', { type: 'task_cancel', task_id: task.id })).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    })
    expect(
      ok<{ task: Task }>('alpha', { type: 'task_cancel', task_id: task.id, reason: 'moot' }).task
        .state,
    ).toBe('canceled')
    expect(store.taskEvents(task.id).at(-1)).toMatchObject({
      to_state: 'canceled',
      by: 'alpha',
      summary: 'moot',
    })
  })

  it('a human dispatcher is not escalated; tasks in a named room require membership', () => {
    const { store, mk, ok, call } = setup()
    mk('me', 'human')
    mk('gamma')
    mk('delta')
    ok('gamma', { type: 'join', room: 'work' })
    expect(
      call('me', { type: 'task_create', to: 'delta', description: 'x', room: 'work' }),
    ).toMatchObject({ ok: false, error: { code: 'not_member' } })
    const { task } = ok<{ task: Task }>('me', {
      type: 'task_create',
      to: 'gamma',
      description: 'x',
      room: 'work',
    })
    expect(task.room).toBe('work')
    ok('gamma', { type: 'task_update', task_id: task.id, state: 'working' })
    const upd = ok<{ task: Task }>('gamma', {
      type: 'task_update',
      task_id: task.id,
      state: 'input-required',
    })
    expect(upd.task.escalated).toBe(false)
    expect(store.listRooms().some((r) => r.name === 'dm:gamma|me')).toBe(false)
  })
})
