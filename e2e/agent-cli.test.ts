import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Task } from '@agentbus/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * "Say it in the session": an agent joins and talks from its own shell, without MCP.
 * Uses a fake host (no claude/codex): join is exercised through the token API + notes only,
 * by calling the pieces the real `join` uses, so this runs on machines without the CLIs.
 */
const execFileP = promisify(execFile)
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const CLI_BIN = here('../packages/cli/dist/bin.js')

describe('agent-side cli + skill', () => {
  let up: ChildProcess
  let root: string
  let port = 0
  let env: Record<string, string>
  let log = ''

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'agentbus-agentcli-'))
    for (const d of ['data', 'home', 'claude-cfg', 'codex-home', 'proj-a', 'proj-b'])
      mkdirSync(join(root, d))
    env = {
      ...(process.env as Record<string, string>),
      AGENTBUS_HOME: join(root, 'home'),
      CLAUDE_CONFIG_DIR: join(root, 'claude-cfg'),
      CODEX_HOME: join(root, 'codex-home'),
    }
    up = spawn(
      process.execPath,
      [
        CLI_BIN,
        'up',
        '-d',
        join(root, 'none.yaml'),
        '--port',
        '0',
        '--data-dir',
        join(root, 'data'),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env },
    )
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`up did not start:\n${log}`)), 30_000)
      up.stderr?.on('data', (d) => {
        log += d.toString()
        const m = /listening on ws:\/\/127\.0\.0\.1:(\d+)\/ws/.exec(log)
        if (m) port = Number(m[1])
        if (port && log.includes('[up] ready')) {
          clearTimeout(t)
          resolve()
        }
      })
    })
  }, 40_000)

  afterAll(async () => {
    up?.kill()
    await new Promise((r) => setTimeout(r, 800))
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // sqlite handle may linger on Windows
    }
  })

  const bus = () => `ws://127.0.0.1:${port}/ws`
  const run = (args: string[], cwd: string) =>
    execFileP(process.execPath, [CLI_BIN, ...args], { env, cwd })

  /** Mint identities the way `join` does, without touching a host CLI. */
  async function mint(name: string): Promise<void> {
    const owner = readFileSync(join(root, 'data', 'owner.token'), 'utf8').trim()
    const r = await fetch(`http://127.0.0.1:${port}/api/console/agents`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${owner}`,
        'x-agentbus-name': 'owner',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, authority: 'relayer', rotate: true }),
    })
    const { token } = (await r.json()) as { token: string }
    mkdirSync(join(root, 'home', 'agents'), { recursive: true })
    writeFileSync(join(root, 'home', 'agents', `${name}.token`), `${token}\n`)
    writeFileSync(join(root, 'home', 'agents', `${name}.bus`), `${bus()}\n`)
  }

  it('whoami explains when a directory is not joined', async () => {
    const r = await run(['whoami', '--bus', bus()], join(root, 'proj-a')).catch(
      (e: { stdout: string; code: number }) => e,
    )
    expect(r.stdout).toContain('not joined')
    expect(r.stdout).toContain('agentbus join')
  })

  it('two joined directories talk through the shell: send, inbox, rooms, wait', async () => {
    await mint('proj-a')
    await mint('proj-b')
    const a = join(root, 'proj-a')
    const b = join(root, 'proj-b')

    // no --bus: the directory remembers which bus it joined (the live bus is not 7777 here)
    const remembered = await run(['whoami'], a)
    expect(remembered.stdout).toContain(`online · bus ${bus()}`)
    const who = await run(['whoami', '--bus', bus()], a)
    expect(who.stdout).toMatch(/^proj-a \(relayer\) · online/)
    expect(who.stdout).toContain('proj-b (offline)')

    const sent = await run(['send', '--to', 'proj-b', 'hello from a', '--bus', bus()], a)
    expect(sent.stdout).toMatch(/sent #\d+ to dm:proj-a\|proj-b → proj-b:mailbox\/written/)

    const inbox = await run(['inbox', '--bus', bus()], b)
    expect(inbox.stdout).toContain('hello from a')
    expect(inbox.stdout).toContain('|proj-a|relayer|')
    const again = await run(['inbox', '--bus', bus()], b)
    expect(again.stdout).toContain('no new messages')

    // rooms: join, send, leave
    await run(['join-room', 'design', '--bus', bus()], a)
    const joined = await run(['join-room', 'design', '--bus', bus()], b)
    expect(joined.stdout).toContain('joined design (members: proj-a, proj-b)')
    await run(['send', '--room', 'design', 'room hello', '--bus', bus()], a)
    const bRooms = await run(['rooms', '--bus', bus()], b)
    expect(bRooms.stdout).toContain('design|room|false|proj-a,proj-b')
    expect((await run(['inbox', '--bus', bus()], b)).stdout).toContain('room hello')
    const left = await run(['leave-room', 'design', '--bus', bus()], b)
    expect(left.stdout).toContain('left design')
    await run(['send', '--room', 'design', 'after leave', '--bus', bus()], a)
    expect((await run(['inbox', '--bus', bus()], b)).stdout).toContain('no new messages')

    // wait blocks until the other side sends
    const waiting = run(['wait', '--timeout', '10', '--bus', bus()], b)
    await new Promise((r) => setTimeout(r, 800))
    await run(['send', '--to', 'proj-b', 'wake', '--bus', bus()], a)
    expect((await waiting).stdout).toContain('wake')
  }, 60_000)

  it('wait --from returns only that sender; others stay in the inbox; timeout is not a failure', async () => {
    mkdirSync(join(root, 'proj-c'))
    await mint('proj-c')
    const a = join(root, 'proj-a')
    const b = join(root, 'proj-b')
    const c = join(root, 'proj-c')

    // b asks a something and waits for a only; c's message must not wake it
    const waiting = run(['wait', '--from', 'proj-a', '--timeout', '15', '--bus', bus()], b)
    await new Promise((r) => setTimeout(r, 800))
    await run(['send', '--to', 'proj-b', 'noise from c', '--bus', bus()], c)
    await new Promise((r) => setTimeout(r, 800))
    await run(['send', '--to', 'proj-b', 'answer from a', '--bus', bus()], a)
    const got = await waiting
    expect(got.stdout).toContain('answer from a')
    expect(got.stdout).not.toContain('noise from c')
    // c's row was neither shown nor swallowed: it is still unread
    const inbox = await run(['inbox', '--bus', bus()], b)
    expect(inbox.stdout).toContain('noise from c')
    expect(inbox.stdout).not.toContain('answer from a')

    // already pending from both: only a's row is taken now, c's at the next inbox
    await run(['send', '--to', 'proj-b', 'noise 2', '--bus', bus()], c)
    await run(['send', '--to', 'proj-b', 'answer 2', '--bus', bus()], a)
    const now = await run(['wait', '--from', 'proj-a', '--timeout', '5', '--bus', bus()], b)
    expect(now.stdout).toContain('answer 2')
    expect(now.stdout).not.toContain('noise 2')
    expect((await run(['inbox', '--bus', bus()], b)).stdout).toContain('noise 2')

    // a timed-out wait says the message is in the other side's mailbox, not that it failed
    const out = await run(['wait', '--from', 'proj-a', '--timeout', '1', '--bus', bus()], b)
    expect(out.stdout).toContain('no reply from proj-a within 1s')
    expect(out.stdout).toContain('proj-a还没回，消息已在它信箱里')
    expect(out.stdout).toContain('结果会自动带回来')
    const plain = await run(['wait', '--timeout', '1', '--bus', bus()], b)
    expect(plain.stdout).toContain('对方还没回，消息已在它信箱里')
  }, 60_000)

  it('tasks from the shell: create → inbox shows the task → update → list; console lists it', async () => {
    const a = join(root, 'proj-a')
    const b = join(root, 'proj-b')

    const created = await run(
      [
        'task',
        'create',
        '--to',
        'proj-b',
        'implement /users',
        '--desc',
        'fields per FINAL',
        '--max-turns',
        '10',
        '--bus',
        bus(),
      ],
      a,
    )
    const taskId = /^created task (t_[a-z0-9]+) \[submitted\] proj-a → proj-b in /.exec(
      created.stdout,
    )?.[1] as string
    expect(taskId).toBeTruthy()
    expect(created.stdout).toContain('turns 0/10')

    // the executor sees it in its inbox, with the task column filled
    const inbox = await run(['inbox', '--bus', bus()], b)
    const [header, ...rows] = inbox.stdout
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('^'))
    expect(header).toBe('id|from|authority|room|ts|text|attachments|task')
    expect(rows.some((r) => r.includes(`[task ${taskId}]`) && r.endsWith(`|${taskId}`))).toBe(true)

    // executor reports; an unknown state is refused locally, an illegal transition by the bus
    const bad = await run(['task', 'update', taskId, '--state', 'done', '--bus', bus()], b).catch(
      (e: { stderr: string }) => e,
    )
    expect(bad.stderr).toContain('--state must be one of')
    const skip = await run(
      ['task', 'update', taskId, '--state', 'completed', '--bus', bus()],
      b,
    ).catch((e: { stderr: string }) => e)
    expect(skip.stderr).toMatch(/submitted/)
    const working = await run(['task', 'update', taskId, '--state', 'working', '--bus', bus()], b)
    expect(working.stdout).toContain(`updated task ${taskId} [working]`)
    const done = await run(
      ['task', 'update', taskId, '--state', 'completed', '--note', 'done, see PR', '--bus', bus()],
      b,
    )
    expect(done.stdout).toContain(`updated task ${taskId} [completed]`)

    // the dispatcher's inbox carries the thread, every row tagged with the task
    const aInbox = await run(['inbox', '--bus', bus()], a)
    const aRows = aInbox.stdout
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('^'))
      .slice(1)
    expect(aRows.length).toBeGreaterThanOrEqual(2)
    expect(aRows.every((r) => r.endsWith(`|${taskId}`))).toBe(true)
    expect(aInbox.stdout).toContain('completed')

    // list: closed by default hidden, --all shows it
    expect((await run(['task', 'list', '--bus', bus()], a)).stdout).toContain('no tasks')
    const all = await run(['task', 'list', '--all', '--bus', bus()], a)
    expect(all.stdout.split('\n')[0]).toBe('id|state|from|to|room|turns|deadline|description')
    expect(all.stdout).toContain(`${taskId}|completed|proj-a|proj-b|`)
    expect(all.stdout).toContain('|implement /users')
    const byState = await run(['task', 'list', '--state', 'completed', '--bus', bus()], b)
    expect(byState.stdout).toContain(taskId)

    // cancel is the dispatcher's; a terminal task cannot be canceled
    const cancel = await run(['task', 'cancel', taskId, '--bus', bus()], a).catch(
      (e: { stderr: string }) => e,
    )
    expect(cancel.stderr).toMatch(/completed/)

    // the console lists tasks (human only)
    const owner = readFileSync(join(root, 'data', 'owner.token'), 'utf8').trim()
    const headers = { authorization: `Bearer ${owner}`, 'x-agentbus-name': 'owner' }
    const http = `http://127.0.0.1:${port}`
    const open = (await (await fetch(`${http}/api/console/tasks`, { headers })).json()) as {
      tasks: Task[]
    }
    expect(open.tasks.map((t) => t.id)).not.toContain(taskId)
    const listed = (await (await fetch(`${http}/api/console/tasks?all=1`, { headers })).json()) as {
      tasks: Task[]
    }
    const mine = listed.tasks.find((t) => t.id === taskId)
    expect(mine?.state).toBe('completed')
    expect(mine?.summary).toBe('done, see PR')
    const completed = (await (
      await fetch(`${http}/api/console/tasks?state=completed`, { headers })
    ).json()) as { tasks: Task[] }
    expect(completed.tasks.map((t) => t.id)).toContain(taskId)
    const anon = await fetch(`${http}/api/console/tasks`)
    expect(anon.status).toBeGreaterThanOrEqual(400)
  }, 60_000)

  it('install-skill writes the same skill for Claude Code and Codex', async () => {
    const r = await run(['install-skill'], root)
    expect(r.stdout).toContain('skill installed')
    for (const f of [
      join(root, 'claude-cfg', 'skills', 'agentbus', 'SKILL.md'),
      join(root, 'codex-home', 'skills', 'agentbus', 'SKILL.md'),
    ]) {
      expect(existsSync(f)).toBe(true)
      const md = readFileSync(f, 'utf8')
      expect(md).toMatch(/^---\nname: agentbus\ndescription: .*加入 agentbus/)
      expect(md).toContain('whoami')
      expect(md).toContain('join --claude')
      expect(md).toMatch(/^description: .*值班.*on duty/m)
      expect(md).toContain('## Every turn')
      expect(md).toContain('## On duty')
      expect(md).toContain('wait --timeout 300')
      expect(md).toContain('task create --to')
      expect(md).toContain('task update <id> --state working\\|input-required\\|completed\\|failed')
      expect(md).toContain('task list')
      // a question and a piece of work wait differently; a timed-out wait is not a failure
      expect(md).toContain('## Ask a question vs hand out work')
      expect(md).toContain('wait --from tita --timeout 120')
      expect(md).toContain('wait --from tita\n  --timeout 1800')
      expect(md).toContain('还没回，消息已在它信箱里')
      expect(md).toContain('When you are the receiver')
    }
  })
})
