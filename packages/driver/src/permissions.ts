import type { BusClient } from '@agentbus/core'
import type { AgentInfo, Message } from '@agentbus/protocol'
import { dmRoom } from '@agentbus/protocol'
import type { PermissionAsk, PermissionDecision } from './backend.js'

export interface PermissionBrokerOptions {
  client: BusClient
  agent: string
  timeoutMs: number
  log: (line: string) => void
  /** Hook for the driver to park unrelated messages that arrived while a question was open. */
  onUnrelated: (m: Message) => void
}

interface Pending {
  id: string
  human: string
  room: string
  ask: PermissionAsk
  resolve: (d: PermissionDecision) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * `autonomy: ask` (PRODUCT_DESIGN §4.6, F-D10). A backend permission request becomes a
 * dm to a human with human authority; their reply is mapped back to a permission option.
 * Until Task lands (M2) this is the input-required path: the dm carries
 * `payload.kind = "permission_request"` so consoles can render it as such.
 */
export class PermissionBroker {
  private pending: Pending[] = []
  private seq = 0

  constructor(private readonly o: PermissionBrokerOptions) {}

  get open(): number {
    return this.pending.length
  }

  /** Called by the backend while a prompt is in flight. */
  async ask(ask: PermissionAsk, contextRoom: string | null): Promise<PermissionDecision> {
    const human = await this.pickHuman(contextRoom)
    if (!human) {
      this.o.log(`[permissions ${this.o.agent}] no human reachable; cancelling ${ask.title}`)
      return { optionId: null }
    }
    const id = `perm-${++this.seq}`
    const room = dmRoom(this.o.agent, human)
    const lines = [
      `[permission request ${id}] ${ask.title}`,
      ask.kind ? `kind: ${ask.kind}` : '',
      ask.rawInput !== undefined ? `input: ${JSON.stringify(ask.rawInput).slice(0, 400)}` : '',
      'Options:',
      ...ask.options.map((op, i) => `  ${i + 1}. ${op.name} (${op.kind})`),
      `Reply with a number, the option name, "allow" or "deny" within ${Math.round(this.o.timeoutMs / 1000)}s.`,
    ].filter(Boolean)
    await this.o.client.request({
      type: 'send',
      to: human,
      text: lines.join('\n'),
      payload: { kind: 'permission_request', id, options: ask.options, tool: ask.title },
    })
    await this.o.client
      .request({ type: 'status', state: 'blocked', text: `waiting for ${human}: ${ask.title}` })
      .catch(() => undefined)
    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.remove(id)
        this.o.log(`[permissions ${this.o.agent}] ${id} timed out`)
        void this.o.client
          .request({
            type: 'send',
            to: human,
            text: `[permission request ${id}] timed out; cancelled.`,
          })
          .catch(() => undefined)
        resolve({ optionId: null })
      }, this.o.timeoutMs)
      this.pending.push({ id, human, room, ask, resolve, timer })
    })
  }

  /** Feed every message pulled from inbox while questions are open. Unrelated ones go back to the driver. */
  consume(messages: Message[]): void {
    for (const m of messages) {
      const p = this.pending.find(
        (x) => x.room === m.room && x.human === m.from && m.authority !== 'bot',
      )
      if (!p) {
        this.o.onUnrelated(m)
        continue
      }
      const option = this.parse(p.ask, m.text)
      if (!option) {
        // Not an answer to the open question: it is a normal message for the agent, which
        // gets it in its next turn. The question stays open until answered or timed out.
        this.o.onUnrelated(m)
        continue
      }
      clearTimeout(p.timer)
      this.remove(p.id)
      this.o.log(`[permissions ${this.o.agent}] ${p.id} → ${option.name} by ${p.human}`)
      p.resolve({ optionId: option.optionId })
    }
  }

  private parse(ask: PermissionAsk, raw: string): PermissionAsk['options'][number] | null {
    const t = raw.trim().toLowerCase()
    const n = Number.parseInt(t, 10)
    if (!Number.isNaN(n) && n >= 1 && n <= ask.options.length) return ask.options[n - 1] ?? null
    const byId = ask.options.find(
      (o) => o.optionId.toLowerCase() === t || o.name.toLowerCase() === t,
    )
    if (byId) return byId
    if (/^(allow|yes|y|ok|approve|approved|go)\b/.test(t))
      return (
        ask.options.find((o) => o.kind === 'allow_once') ??
        ask.options.find((o) => o.kind === 'allow_always') ??
        null
      )
    if (/^(deny|no|n|reject|rejected|stop)\b/.test(t))
      return (
        ask.options.find((o) => o.kind === 'reject_once') ??
        ask.options.find((o) => o.kind === 'reject_always') ??
        null
      )
    return null
  }

  /** Prefer a human in the room the work came from, then any online human, then `owner`. */
  private async pickHuman(contextRoom: string | null): Promise<string | null> {
    const agents = (await this.o.client.request<{ agents: AgentInfo[] }>({ type: 'agents' })).agents
    const humans = agents.filter((a) => a.authority === 'human' || a.authority === 'relayer')
    if (!humans.length) return null
    if (contextRoom) {
      const rooms = (
        await this.o.client.request<{ rooms: { name: string; members: string[] }[] }>({
          type: 'rooms',
        })
      ).rooms
      const members = rooms.find((r) => r.name === contextRoom)?.members ?? []
      const inRoom = humans.filter((h) => members.includes(h.name))
      const pick = inRoom.find((h) => h.online) ?? inRoom[0]
      if (pick) return pick.name
    }
    return (
      (humans.find((h) => h.online) ?? humans.find((h) => h.name === 'owner') ?? humans[0])?.name ??
      null
    )
  }

  private remove(id: string): void {
    this.pending = this.pending.filter((p) => p.id !== id)
  }
}
