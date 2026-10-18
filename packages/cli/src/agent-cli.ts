import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { BusClient, BusClientError } from '@agentbus/core'
import type { AgentInfo, InboxResult, Message, Task, WaitResult } from '@agentbus/protocol'
import {
  encodeRecords,
  MESSAGE_TABLE_FIELDS,
  messageToRow,
  TASK_TABLE_FIELDS,
  taskToRow,
} from '@agentbus/protocol'
import type { Command } from 'commander'
import { cliBin, nameFromDir, readAgentBus, readAgentToken, tokenFileFor } from './join.js'
import { skillMarkdown } from './skill.js'

/**
 * Commands an agent runs from inside its own session (PRODUCT_DESIGN addendum 2026-10-16):
 * the shell is always there, the MCP tools only after the session restarts. Identity comes
 * from the directory: `~/.agentbus/agents/<dirname>.token`.
 */

export interface AgentCtx {
  name: string
  token: string
}

export function agentIdentity(cwd: string, nameOpt?: string): AgentCtx | null {
  const name = nameOpt ?? process.env.AGENTBUS_NAME ?? nameFromDir(cwd)
  const token = process.env.AGENTBUS_TOKEN ?? readAgentToken(name)
  return token ? { name, token } : null
}

export const DEFAULT_BUS = 'ws://127.0.0.1:7777/ws'

/** `--bus` if given, else env, else the bus this directory joined, else the local default. */
export function busFor(explicit: string | undefined, name: string): string {
  return explicit ?? process.env.AGENTBUS_BUS ?? readAgentBus(name) ?? DEFAULT_BUS
}

export function notJoined(cwd: string): Error {
  return new Error(
    `this directory is not on the bus (no ${tokenFileFor(nameFromDir(cwd))}). Run: agentbus join --claude | --codex`,
  )
}

/** Connect as the agent; fall back to the `tool` role when something else holds `control`. */
export async function agentClient(bus: string, id: AgentCtx): Promise<BusClient> {
  const c = new BusClient(bus)
  await c.connect()
  const register = (role: 'control' | 'tool') =>
    c.request({
      type: 'register',
      name: id.name,
      token: id.token,
      role,
      capabilities: { inbox: true, push: false },
      version: 'agentbus-cli/agent',
    })
  try {
    await register('control')
  } catch (e) {
    if (e instanceof BusClientError && e.code === 'name_taken') {
      // The session's own adapter (or a driver) holds control; a one-shot tool connection is fine.
      c.close()
      const c2 = new BusClient(bus)
      await c2.connect()
      await c2.request({
        type: 'register',
        name: id.name,
        token: id.token,
        role: 'tool',
        capabilities: { inbox: true, push: false },
        version: 'agentbus-cli/agent',
      })
      return c2
    }
    c.close()
    throw e
  }
  return c
}

/** Message table plus a `task` column, so a session can tell which thread a row belongs to. */
const INBOX_FIELDS = [...MESSAGE_TABLE_FIELDS, 'task'] as const
const table = (msgs: Message[]) =>
  `${encodeRecords(
    INBOX_FIELDS,
    msgs.map((m) => ({ ...messageToRow(m), task: m.task_id ?? '' })),
  )}\n`

const taskLine = (t: Task) =>
  `task ${t.id} [${t.state}] ${t.from} → ${t.to} in ${t.room}; turns ${t.turns_used}/${t.max_turns ?? '∞'}` +
  (t.deadline ? `; deadline ${new Date(t.deadline).toISOString()}` : '')
const taskTable = (tasks: Task[]) =>
  `${tasks.length ? encodeRecords(TASK_TABLE_FIELDS, tasks.map(taskToRow)) : 'no tasks'}\n`

/**
 * A wait that ran out is not a failure: the message is in the other side's mailbox and comes
 * back through the hook / inbox later. Printed in the words the model should pass on.
 */
export function waitTimedOut(timeoutS: number, from?: string): string {
  const who = from ?? '对方'
  return (
    `no reply from ${who} within ${timeoutS}s — not a failure. Tell the user: ` +
    `${who}还没回，消息已在它信箱里；它那边的人下次输入或它值班时会处理，结果会自动带回来` +
    `（下次你输入时 hook 会把回复带进来；想继续等就说"等 ${who}"）。\n`
  )
}

/** Printed after inbox / wait rows so the model treats them as requests to it, not to its user. */
const INBOX_FOOTER =
  '^ messages TO you from other participants. Answer each yourself with `send --to <from> "..."`; a question about this machine or project is yours to run and report, not to forward.\n'

/**
 * Rows the standby (the hosted session for this directory) already handled while nobody read
 * them here. Shown once; the replies are in the room history.
 */
const STANDBY_HEADER =
  '--- already handled by your standby session while you were away (replies are in `history <room>`): just know, do NOT answer again ---\n'

function renderInbox(r: InboxResult, empty: string): string {
  const parts: string[] = []
  parts.push(r.messages.length ? table(r.messages) + INBOX_FOOTER : empty)
  if (r.standby?.length) parts.push(STANDBY_HEADER + table(r.standby))
  return parts.join('')
}

export function registerAgentCommands(
  program: Command,
  busOpt: (cmd: Command) => Command,
  log: (l: string) => void,
): void {
  type O = { bus?: string; as?: string }

  busOpt(program.command('whoami').description('am I on the bus, and who else is')).action(
    async (o: O) => {
      const id = agentIdentity(process.cwd(), o.as)
      if (!id) {
        process.stdout.write(
          `not joined (directory ${resolve(process.cwd())}); run: agentbus join --claude | --codex\n`,
        )
        process.exitCode = 1
        return
      }
      let c: BusClient
      try {
        c = await agentClient(busFor(o.bus, id.name), id)
      } catch (e) {
        process.stdout.write(
          `${id.name}: token stored but the bus refused it (${(e as Error).message}); run agentbus join again or start the bus (agentbus up)\n`,
        )
        process.exitCode = 1
        return
      }
      const { agents } = await c.request<{ agents: AgentInfo[] }>({ type: 'agents' })
      const me = agents.find((a) => a.name === id.name)
      const others = agents.filter((a) => a.name !== id.name && a.authority !== 'human')
      process.stdout.write(
        `${id.name} (${me?.authority ?? '?'}) · online · bus ${busFor(o.bus, id.name)}\n`,
      )
      process.stdout.write(
        others.length
          ? `others: ${others.map((a) => `${a.name}${a.online ? '' : ' (offline)'}${a.capabilities.driver ? ' [hosted]' : a.standby ? ' [standby]' : ''}`).join(', ')}\n`
          : 'no other agents yet\n',
      )
      if (me?.standby)
        process.stdout.write(
          'standby: on (a hosted session answers for you when you do not read within the delay)\n',
        )
      c.close()
    },
  )

  busOpt(
    program
      .command('inbox')
      .description('messages that arrived since my last look (marks them seen)'),
  ).action(async (o: O) => {
    const id = agentIdentity(process.cwd(), o.as)
    if (!id) throw notJoined(process.cwd())
    const c = await agentClient(busFor(o.bus, id.name), id)
    const r = await c.request<InboxResult>({ type: 'inbox' })
    process.stdout.write(renderInbox(r, 'no new messages\n'))
    c.close()
  })

  busOpt(program.command('wait').description('block until a message arrives or the timeout passes'))
    .option('--timeout <s>', 'seconds (max 3600)', (v: string) => Number.parseInt(v, 10), 60)
    .option(
      '--from <agent>',
      'return only when this agent writes; everyone else stays unread in the inbox',
    )
    .action(async (o: O & { timeout: number; from?: string }) => {
      const id = agentIdentity(process.cwd(), o.as)
      if (!id) throw notJoined(process.cwd())
      const c = await agentClient(busFor(o.bus, id.name), id)
      const r = await c.request<WaitResult>({
        type: 'wait',
        timeout_s: o.timeout,
        ...(o.from ? { from: o.from } : {}),
      })
      process.stdout.write(
        r.timed_out
          ? waitTimedOut(o.timeout, o.from)
          : renderInbox(
              r,
              // Only happens when two waits of yours were parked at once: the other one took the row.
              'nothing for this wait: another wait of yours was running at the same time and received the message — read its output; do not treat this as "no reply".\n',
            ),
      )
      c.close()
    })

  busOpt(program.command('send').description("send a message as this directory's agent"))
    .argument('<text>')
    .option('--to <agent>')
    .option('--room <room>')
    .option('--task <task_id>')
    .action(async (text: string, o: O & { to?: string; room?: string; task?: string }) => {
      if ((o.to ? 1 : 0) + (o.room ? 1 : 0) !== 1)
        throw new Error('give exactly one of --to <agent> or --room <room>')
      const id = agentIdentity(process.cwd(), o.as)
      if (!id) throw notJoined(process.cwd())
      const c = await agentClient(busFor(o.bus, id.name), id)
      const r = await c.request<{
        message: Message
        deliveries: { recipient: string; via: string; state: string }[]
      }>({
        type: 'send',
        text,
        ...(o.to ? { to: o.to } : {}),
        ...(o.room ? { room: o.room } : {}),
        ...(o.task ? { task_id: o.task } : {}),
      })
      process.stdout.write(
        `sent #${r.message.id} to ${r.message.room} → ${r.deliveries.map((d) => `${d.recipient}:${d.via}/${d.state}`).join(', ') || '(no other members yet)'}\n`,
      )
      c.close()
    })

  busOpt(program.command('rooms').description('rooms I am in')).action(async (o: O) => {
    const id = agentIdentity(process.cwd(), o.as)
    if (!id) throw notJoined(process.cwd())
    const c = await agentClient(busFor(o.bus, id.name), id)
    const r = await c.request<{
      rooms: { name: string; kind: string; paused: boolean; members: string[] }[]
    }>({ type: 'rooms' })
    process.stdout.write(
      `${encodeRecords(
        ['name', 'kind', 'paused', 'members'],
        r.rooms.map((x) => ({ ...x, members: x.members.join(',') })),
      )}\n`,
    )
    c.close()
  })

  busOpt(program.command('join-room').description('enter (creating if needed) a named room'))
    .argument('<room>')
    .action(async (room: string, o: O) => {
      const id = agentIdentity(process.cwd(), o.as)
      if (!id) throw notJoined(process.cwd())
      const c = await agentClient(busFor(o.bus, id.name), id)
      const r = await c.request<{ room: string; joined: boolean; members: string[] }>({
        type: 'join',
        room,
      })
      process.stdout.write(
        `${r.joined ? 'joined' : 'already in'} ${r.room} (members: ${r.members.join(', ')})\n`,
      )
      c.close()
    })

  busOpt(program.command('leave-room').description('leave a named room'))
    .argument('<room>')
    .action(async (room: string, o: O) => {
      const id = agentIdentity(process.cwd(), o.as)
      if (!id) throw notJoined(process.cwd())
      const c = await agentClient(busFor(o.bus, id.name), id)
      const r = await c.request<{ room: string; left: boolean }>({ type: 'leave', room })
      process.stdout.write(r.left ? `left ${r.room}\n` : `you were not in ${r.room}\n`)
      c.close()
    })

  // ---- tasks: the same frames the MCP tools task_create / task_update / task_cancel / tasks use
  const task = program
    .command('task')
    .description('hand work to another agent and track it (create | update | cancel | list)')

  busOpt(
    task.command('create').description('hand a task to another agent (you are the dispatcher)'),
  )
    .argument('<title>', 'what to do, one line')
    .requiredOption('--to <agent>', 'executor')
    .option('--desc <text>', 'details / context for the executor')
    .option('--room <room>', 'run it in this room instead of your dm with the executor')
    .option('--deadline <s>', 'seconds from now (default from bus config)', (v: string) =>
      Number.parseInt(v, 10),
    )
    .option('--max-turns <n>', 'bot messages allowed in the thread', (v: string) =>
      Number.parseInt(v, 10),
    )
    .action(
      async (
        title: string,
        o: O & { to: string; desc?: string; room?: string; deadline?: number; maxTurns?: number },
      ) => {
        const id = agentIdentity(process.cwd(), o.as)
        if (!id) throw notJoined(process.cwd())
        const c = await agentClient(busFor(o.bus, id.name), id)
        const r = await c.request<{ task: Task }>({
          type: 'task_create',
          to: o.to,
          description: title,
          ...(o.desc ? { context: o.desc } : {}),
          ...(o.room ? { room: o.room } : {}),
          ...(o.deadline !== undefined ? { deadline_s: o.deadline } : {}),
          ...(o.maxTurns !== undefined ? { max_turns: o.maxTurns } : {}),
        })
        process.stdout.write(`created ${taskLine(r.task)}\n`)
        c.close()
      },
    )

  busOpt(task.command('update').description('executor reports progress on a task'))
    .argument('<task_id>')
    .requiredOption('--state <s>', 'working | input-required | completed | failed')
    .option('--note <text>', 'summary of what was done, or the question (input-required)')
    .option('--escalate', 'input-required: also alert a human now', false)
    .action(async (taskId: string, o: O & { state: string; note?: string; escalate: boolean }) => {
      const states = ['working', 'input-required', 'completed', 'failed'] as const
      type S = (typeof states)[number]
      if (!states.includes(o.state as S))
        throw new Error(`--state must be one of ${states.join(' | ')}`)
      const id = agentIdentity(process.cwd(), o.as)
      if (!id) throw notJoined(process.cwd())
      const c = await agentClient(busFor(o.bus, id.name), id)
      const r = await c.request<{ task: Task }>({
        type: 'task_update',
        task_id: taskId,
        state: o.state as S,
        ...(o.note ? { summary: o.note } : {}),
        ...(o.escalate ? { escalate: true } : {}),
      })
      process.stdout.write(`updated ${taskLine(r.task)}\n`)
      c.close()
    })

  busOpt(task.command('cancel').description('dispatcher cancels a task'))
    .argument('<task_id>')
    .option('--reason <text>')
    .action(async (taskId: string, o: O & { reason?: string }) => {
      const id = agentIdentity(process.cwd(), o.as)
      if (!id) throw notJoined(process.cwd())
      const c = await agentClient(busFor(o.bus, id.name), id)
      const r = await c.request<{ task: Task }>({
        type: 'task_cancel',
        task_id: taskId,
        ...(o.reason ? { reason: o.reason } : {}),
      })
      process.stdout.write(`canceled ${taskLine(r.task)}\n`)
      c.close()
    })

  busOpt(task.command('list').description('tasks I dispatched or execute (open ones by default)'))
    .option('--all', 'include completed / failed / canceled', false)
    .option('--state <s>', 'submitted | working | input-required | completed | failed | canceled')
    .action(async (o: O & { all: boolean; state?: string }) => {
      const id = agentIdentity(process.cwd(), o.as)
      if (!id) throw notJoined(process.cwd())
      const c = await agentClient(busFor(o.bus, id.name), id)
      const r = await c.request<{ tasks: Task[] }>({
        type: 'tasks',
        open_only: !o.all,
        ...(o.state ? { state: o.state as Task['state'] } : {}),
      })
      process.stdout.write(taskTable(r.tasks))
      c.close()
    })

  program
    .command('install-skill')
    .description('teach Claude Code and Codex how to join and use agentbus from inside a session')
    .option('--claude-dir <dir>', 'Claude config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude)')
    .option('--codex-dir <dir>', 'Codex home (default: $CODEX_HOME or ~/.codex)')
    .action((o: { claudeDir?: string; codexDir?: string }) => {
      const md = skillMarkdown(launcher())
      const targets = [
        join(
          o.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
          'skills',
          'agentbus',
          'SKILL.md',
        ),
        join(
          o.codexDir ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
          'skills',
          'agentbus',
          'SKILL.md',
        ),
      ]
      for (const f of targets) {
        mkdirSync(dirname(f), { recursive: true })
        writeFileSync(f, md)
        log(`wrote ${f}`)
      }
      process.stdout.write(
        'skill installed. In any Claude Code / Codex session you can now say: 加入 agentbus / join agentbus\n',
      )
    })
}

/** How a session should invoke this CLI: the repo launcher when present, else node + bin.js. */
export function launcher(): string {
  const bin = cliBin()
  const cmd = resolve(
    dirname(bin),
    '..',
    '..',
    '..',
    'bin',
    process.platform === 'win32' ? 'agentbus.cmd' : 'agentbus',
  )
  if (existsSync(cmd)) return cmd.includes(' ') ? `"${cmd}"` : cmd
  return `node "${bin}"`
}
