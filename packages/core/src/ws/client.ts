import { EventEmitter } from 'node:events'
import type { ClientRequest, EventFrame, ResponseFrame, ServerFrame } from '@agentbus/protocol'
import { ServerFrame as ServerFrameSchema } from '@agentbus/protocol'
import { WebSocket } from 'ws'

type Req = ClientRequest

export class BusClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryInMs?: number,
  ) {
    super(message)
    this.name = 'BusClientError'
  }
}

/**
 * Minimal typed client for `WS /ws`, shared by the adapter, driver and CLI.
 * Correlates responses by `id`; emits `event` for server-initiated frames.
 */
export class BusClient extends EventEmitter<{ event: [EventFrame]; close: [] }> {
  private ws: WebSocket | null = null
  private seq = 0
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(readonly url: string) {
    super()
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.once('open', () => resolve())
      ws.once('error', (e) => reject(e))
      ws.on('message', (data) => this.onMessage(data.toString()))
      ws.on('close', () => {
        for (const p of this.pending.values())
          p.reject(new BusClientError('closed', 'connection closed'))
        this.pending.clear()
        this.emit('close')
      })
    })
  }

  private onMessage(text: string): void {
    let frame: ServerFrame
    try {
      frame = ServerFrameSchema.parse(JSON.parse(text))
    } catch {
      return
    }
    if (frame.type === 'event') {
      this.emit('event', frame)
      return
    }
    const p = this.pending.get(frame.id)
    if (!p) return
    this.pending.delete(frame.id)
    if (frame.ok) p.resolve(frame.result)
    else
      p.reject(new BusClientError(frame.error.code, frame.error.message, frame.error.retry_in_ms))
  }

  request<T = unknown>(req: Req): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new BusClientError('closed', 'not connected'))
    const id = String(++this.seq)
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      ws.send(JSON.stringify({ id, ...req }))
    })
  }

  close(): void {
    this.ws?.close()
  }
}

export type { ResponseFrame }
