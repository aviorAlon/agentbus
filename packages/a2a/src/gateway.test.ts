import { TaskState as SdkState } from '@a2a-js/sdk'
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client'
import { Bus, generateToken, hashToken, loadConfig, Store, WsServer } from '@agentbus/core'
import type { ServerFrame } from '@agentbus/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { A2AGateway } from './gateway.js'

/** In-process: external A2A client ↔ gateway ↔ bus ↔ a fake executor connection. */
/** The client returns the Task (or Message) directly; older shapes wrap it in `payload`. */
function asTask(r: unknown): {
  id: string
  status?: { state?: number }
  metadata?: Record<string, unknown>
} {
  const p = (r as { payload?: { value?: unknown } }).payload
  return (p?.value ?? r) as {
    id: string
    status?: { state?: number }
    metadata?: Record<string, unknown>
  }
}

describe('A2A gateway', () => {
  let store: Store
  let bus: Bus
  let server: WsServer
  let base: string
  let gammaToken: string

  beforeEach(async () => {
    store = new Store(':memory:')
    gammaToken = generateToken()
    store.createAgent({ name: 'gamma', token_hash: hashToken(gammaToken), backend: 'codex' })
    bus = new Bus(store, loadConfig({ guard: { min_interval_ms: 0 }, tasks: { max_turns: 10 } }))
    const gateway = new A2AGateway(bus, { publicBase: () => base, version: 'test' })
    server = new WsServer(bus, {
      bind: '127.0.0.1',
      port: 0,
      tickMs: 1000,
      routes: [gateway.route()],
    })
    const { port } = await server.listen()
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await server.close()
    store.close()
  })

  it('serves cards and an index; unknown agents are 404', async () => {
    const idx = (await (await fetch(`${base}/.well-known/agentbus-agents.json`)).json()) as {
      agents: { name: string; url: string }[]
    }
    expect(idx.agents.map((a) => a.name)).toEqual(['gamma'])
    const card = (await (
      await fetch(`${base}/a2a/agents/gamma/.well-known/agent-card.json`)
    ).json()) as { name: string; supportedInterfaces: { url: string; protocolBinding: string }[] }
    expect(card.name).toBe('gamma')
    expect(card.supportedInterfaces[0]).toMatchObject({
      url: `${base}/a2a/agents/gamma`,
      protocolBinding: 'JSONRPC',
    })
    expect((await fetch(`${base}/a2a/agents/nobody/.well-known/agent-card.json`)).status).toBe(404)
  })

  it('message/send creates a bus task; executor progress flows back through tasks/get', async () => {
    // gamma "executor": a raw bus connection that completes whatever task it receives
    const frames: ServerFrame[] = []
    const conn = {
      send: (f: ServerFrame) => {
        frames.push(f)
      },
      close: () => undefined,
    }
    let seq = 0
    const call = (frame: Record<string, unknown>) =>
      bus.handleRaw(conn, { id: String(++seq), ...frame })
    expect(
      call({
        type: 'register',
        name: 'gamma',
        token: gammaToken,
        role: 'control',
        capabilities: { inbox: true, push: false, driver: { kind: 'acp' } },
      }).ok,
    ).toBe(true)

    const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()] })
    const client = await factory.createFromUrl(
      base,
      '/a2a/agents/gamma/.well-known/agent-card.json',
    )

    const sent = await client.sendMessage({
      tenant: '',
      message: {
        messageId: 'ext-m1',
        contextId: '',
        taskId: '',
        role: 1,
        parts: [
          {
            content: { $case: 'text', value: 'review PR 12' },
            metadata: undefined,
            filename: '',
            mediaType: 'text/plain',
          },
        ],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: {
        acceptedOutputModes: [],
        taskPushNotificationConfig: undefined,
        historyLength: 10,
        returnImmediately: true,
      } as never,
      metadata: undefined,
    })
    const extTask = asTask(sent)
    expect(extTask.status?.state).toBe(SdkState.TASK_STATE_SUBMITTED)
    const busTaskId = extTask.metadata?.agentbus_task_id as string
    expect(store.getTask(busTaskId)).toMatchObject({
      from: 'a2a',
      to: 'gamma',
      state: 'submitted',
      description: 'review PR 12',
    })
    // gamma received the task message on the bus
    expect(
      frames.some(
        (f) =>
          f.type === 'event' &&
          f.event === 'message' &&
          (f as { message: { task_id?: string } }).message.task_id === busTaskId,
      ),
    ).toBe(true)

    // the executor works and completes with an artifact
    const sha = 'c'.repeat(64)
    store.registerBlob(sha, 3, 'text/plain')
    expect(
      call({ type: 'task_update', task_id: busTaskId, state: 'working', summary: 'reading' }).ok,
    ).toBe(true)
    expect(
      call({
        type: 'task_update',
        task_id: busTaskId,
        state: 'completed',
        summary: '2 findings',
        blobs: [{ id: sha, name: 'findings.md' }],
      }).ok,
    ).toBe(true)

    const got = await client.getTask({ tenant: '', id: extTask.id, historyLength: 50 } as never)
    expect(got.status?.state).toBe(SdkState.TASK_STATE_COMPLETED)
    expect(got.status?.message?.parts[0]?.content).toEqual({ $case: 'text', value: '2 findings' })
    expect(got.artifacts).toHaveLength(1)
    expect(got.artifacts[0]?.parts[0]?.content).toEqual({
      $case: 'url',
      value: `${base}/api/blobs/${sha}`,
    })
  })

  it('tasks/cancel cancels on the bus', async () => {
    const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()] })
    const client = await factory.createFromUrl(
      base,
      '/a2a/agents/gamma/.well-known/agent-card.json',
    )
    const sent = await client.sendMessage({
      tenant: '',
      message: {
        messageId: 'ext-m2',
        contextId: '',
        taskId: '',
        role: 1,
        parts: [
          {
            content: { $case: 'text', value: 'slow job' },
            metadata: undefined,
            filename: '',
            mediaType: 'text/plain',
          },
        ],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: {
        acceptedOutputModes: [],
        taskPushNotificationConfig: undefined,
        returnImmediately: true,
      } as never,
      metadata: undefined,
    })
    const ext = asTask(sent)
    const canceled = await client.cancelTask({ tenant: '', id: ext.id, metadata: undefined })
    expect(canceled.status?.state).toBe(SdkState.TASK_STATE_CANCELED)
    expect(store.getTask(ext.metadata?.agentbus_task_id as string)?.state).toBe('canceled')
  })
})
