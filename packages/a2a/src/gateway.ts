import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentCard, TaskState as SdkState, Task as SdkTask } from '@a2a-js/sdk'
import {
  AgentEvent,
  type AgentExecutor,
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  type ExecutionEventBus,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  type RequestContext,
  ServerCallContext,
  UnauthenticatedUser,
} from '@a2a-js/sdk/server'
import { type Bus, generateToken, hashToken } from '@agentbus/core'
import type { Task } from '@agentbus/protocol'
import { TERMINAL_TASK_STATES } from '@agentbus/protocol'
import { fromSdkMessage, toSdkArtifacts, toSdkState, toSdkStatus, toSdkTask } from './map.js'

export interface GatewayOptions {
  /** Base URL other machines use to reach this bus, e.g. http://10.0.0.5:7777 (A2A cards, blob URLs). */
  publicBase: () => string
  version?: string
  /** Bus participant that acts as dispatcher for external tasks. */
  dispatcher?: string
}

interface AgentEndpoint {
  card: AgentCard
  handler: DefaultRequestHandler
  rpc: JsonRpcTransportHandler
  buses: DefaultExecutionEventBusManager
}

/**
 * A2A 1.0 gateway (PRODUCT_DESIGN F-X3, §5 协议选择): every bus agent is exposed as an
 * A2A remote agent at `/a2a/agents/<name>` (JSON-RPC). An external `message/send`
 * becomes a bus Task dispatched by the `a2a` participant; the task's progress on the
 * bus is streamed back as A2A status/artifact updates; `tasks/get` and `tasks/cancel`
 * map one-to-one. The bus core never imports the SDK.
 */
export class A2AGateway {
  private readonly endpoints = new Map<string, AgentEndpoint>()
  /** A2A task id ↔ bus task id. */
  private readonly extToInt = new Map<string, string>()
  private readonly intToExt = new Map<string, { ext: string; agent: string; artifacts: number }>()
  private readonly dispatcher: string
  private readonly version: string

  constructor(
    private readonly bus: Bus,
    private readonly opts: GatewayOptions,
  ) {
    this.dispatcher = opts.dispatcher ?? 'a2a'
    this.version = opts.version ?? '0.0.0'
    bus.on('task', (t) => this.onBusTask(t))
  }

  /** HTTP route for WsServer: agent cards, index and JSON-RPC endpoints. */
  route(): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
    return async (req, res, url) => {
      const path = url.pathname
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
        return true
      }
      if (path === '/.well-known/agentbus-agents.json' && req.method === 'GET') {
        const base = this.opts.publicBase()
        return json(200, {
          agents: this.agentNames().map((name) => ({
            name,
            card: `${base}/a2a/agents/${name}/.well-known/agent-card.json`,
            url: `${base}/a2a/agents/${name}`,
          })),
        })
      }
      const m =
        /^\/a2a\/agents\/([a-z0-9][a-z0-9-]{0,63})(\/\.well-known\/agent-card\.json)?$/.exec(path)
      if (!m) return false
      const name = m[1] as string
      if (this.bus.store.getAgent(name)?.authority !== 'bot')
        return json(404, { error: `no agent ${name}` })
      const ep = this.endpoint(name)
      if (m[2]) return json(200, await ep.handler.getAgentCard())
      if (req.method !== 'POST') return json(405, { error: 'POST JSON-RPC here' })
      const body = await readBody(req)
      const ctx = new ServerCallContext({ user: new UnauthenticatedUser() })
      const out = await ep.rpc.handle(body, ctx)
      if (isAsyncGenerator(out)) {
        // Streaming is not advertised; drain to the last response and return it.
        let last: unknown = null
        for await (const r of out) last = r
        return json(
          200,
          last ?? { jsonrpc: '2.0', error: { code: -32603, message: 'empty stream' } },
        )
      }
      return json(200, out)
    }
  }

  agentNames(): string[] {
    return this.bus.store
      .listAgents()
      .filter((a) => a.authority === 'bot' && a.name !== this.dispatcher)
      .map((a) => a.name)
  }

  // ------------------------------------------------------------- endpoints

  private endpoint(name: string): AgentEndpoint {
    let ep = this.endpoints.get(name)
    if (ep) return ep
    const card = this.card(name)
    const buses = new DefaultExecutionEventBusManager()
    const executor = this.executorFor(name)
    const handler = new DefaultRequestHandler(
      card,
      new InMemoryTaskStore(),
      executor,
      buses,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        // Our executor returns right after creating the bus task; later bus events are
        // published through the kept-alive event bus until the task closes.
        keepBusAliveStates: [
          toSdkState('submitted'),
          toSdkState('working'),
          toSdkState('input-required'),
        ],
        validateInputModes: false,
      },
    )
    ep = { card, handler, rpc: new JsonRpcTransportHandler(handler), buses }
    this.endpoints.set(name, ep)
    return ep
  }

  private card(name: string): AgentCard {
    const a = this.bus.store.getAgent(name)
    const base = this.opts.publicBase()
    return {
      name,
      description: `agentbus agent "${name}"${a?.backend ? ` (${a.backend})` : ''}. Send a message to hand it a task; it answers through the agentbus task thread.`,
      supportedInterfaces: [
        { url: `${base}/a2a/agents/${name}`, protocolBinding: 'JSONRPC', tenant: '' },
      ],
      provider: undefined,
      version: this.version,
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extensions: [],
        extendedAgentCard: false,
      },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: [
        {
          id: 'task',
          name: 'Delegated task',
          description:
            'Hand this agent a unit of work; it reports working / input-required / completed / failed and attaches artifacts.',
          tags: ['agentbus', a?.backend ?? 'agent'],
          examples: ['Review the diff in PR 12 and list the findings.'],
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
          securityRequirements: [],
        },
      ],
      signatures: [],
    } as unknown as AgentCard
  }

  private ensureDispatcher(): void {
    if (this.bus.store.getAgent(this.dispatcher)) return
    // Never connects, so its token is thrown away; it exists to give external tasks an author.
    this.bus.store.createAgent({
      name: this.dispatcher,
      token_hash: hashToken(generateToken()),
      authority: 'bot',
      backend: 'a2a',
    })
  }

  private executorFor(agent: string): AgentExecutor {
    return {
      execute: async (ctx: RequestContext, eventBus: ExecutionEventBus) => {
        this.ensureDispatcher()
        const { text, context } = fromSdkMessage(ctx.userMessage)
        const existing = this.extToInt.get(ctx.taskId)
        if (!existing) {
          const task = this.bus.tasks.create(
            { name: this.dispatcher },
            {
              to: agent,
              description: text,
              ...(context ? { context } : {}),
            },
          )
          this.extToInt.set(ctx.taskId, task.id)
          this.intToExt.set(task.id, { ext: ctx.taskId, agent, artifacts: 0 })
          eventBus.publish(AgentEvent.task(this.sdkTask(task, ctx.taskId)))
          return
        }
        const task = this.bus.store.getTask(existing)
        if (!task) throw new Error(`bus task ${existing} vanished`)
        if (TERMINAL_TASK_STATES.includes(task.state)) {
          eventBus.publish(
            AgentEvent.statusUpdate({
              taskId: ctx.taskId,
              contextId: task.room,
              status: toSdkStatus(task),
              metadata: undefined,
            }),
          )
          eventBus.finished()
          return
        }
        // Follow-up from the external client: a thread message (answers input-required too).
        this.bus.send({ name: this.dispatcher }, { room: task.room, text, task_id: task.id })
        const after = this.bus.store.getTask(existing) ?? task
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId: ctx.taskId,
            contextId: after.room,
            status: toSdkStatus(after),
            metadata: undefined,
          }),
        )
        if (TERMINAL_TASK_STATES.includes(after.state)) eventBus.finished()
      },
      cancelTask: async (extId: string, eventBus: ExecutionEventBus) => {
        const internal = this.extToInt.get(extId)
        if (!internal) throw new Error(`unknown task ${extId}`)
        const task = this.bus.tasks.cancel(
          { name: this.dispatcher },
          internal,
          'canceled by A2A client',
        )
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId: extId,
            contextId: task.room,
            status: toSdkStatus(task),
            metadata: undefined,
          }),
        )
        eventBus.finished()
      },
    }
  }

  private sdkTask(task: Task, extId: string): SdkTask {
    const thread = this.bus.store.history(task.room, 200).filter((m) => m.task_id === task.id)
    return toSdkTask(task, thread, { blobBase: this.opts.publicBase() }, extId)
  }

  /** Bus task changed: forward to the A2A side if it is one of ours. */
  private onBusTask(task: Task): void {
    const link = this.intToExt.get(task.id)
    if (!link) return
    const ep = this.endpoints.get(link.agent)
    if (!ep) return
    const eventBus = ep.buses.createOrGetByTaskId(link.ext)
    const o = { blobBase: this.opts.publicBase() }
    const artifacts = toSdkArtifacts(task, o)
    for (const artifact of artifacts.slice(link.artifacts)) {
      eventBus.publish(
        AgentEvent.artifactUpdate({
          taskId: link.ext,
          contextId: task.room,
          artifact,
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      )
    }
    link.artifacts = artifacts.length
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId: link.ext,
        contextId: task.room,
        status: toSdkStatus(task),
        metadata: undefined,
      }),
    )
    if (TERMINAL_TASK_STATES.includes(task.state)) {
      eventBus.finished()
      this.intToExt.delete(task.id)
    }
  }
}

export type { SdkState }

function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        reject(new Error('body too large'))
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function isAsyncGenerator(x: unknown): x is AsyncGenerator<unknown, void, undefined> {
  return (
    !!x &&
    typeof (x as AsyncGenerator).next === 'function' &&
    typeof (x as AsyncGenerator)[Symbol.asyncIterator] === 'function'
  )
}
