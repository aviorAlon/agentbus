import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { verifyToken } from '../auth/token.js'
import type { Bus } from '../bus/bus.js'

/**
 * `WS /console?name=<human>&token=<t>`: a read-only stream of bus events for the web
 * console (PRODUCT_DESIGN F-H4). Only participants with human authority may subscribe;
 * nothing can be sent back on this socket.
 */
export class ConsoleStream {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly clients = new Set<WebSocket>()
  private readonly unsubscribe: () => void

  constructor(private readonly bus: Bus) {
    const onMessage = (message: unknown, deliveries: unknown) =>
      this.broadcast({ type: 'event', event: 'message', message, deliveries })
    const onDelivery = (delivery: unknown) =>
      this.broadcast({ type: 'event', event: 'delivery', delivery })
    const onSystem = (e: unknown) =>
      this.broadcast({ type: 'event', event: 'system', ...(e as object) })
    const onTask = (task: unknown) => this.broadcast({ type: 'event', event: 'task', task })
    const onPresence = () =>
      this.broadcast({ type: 'event', event: 'presence', agents: bus.agents() })
    bus.on('message', onMessage)
    bus.on('delivery', onDelivery)
    bus.on('system', onSystem)
    bus.on('task', onTask)
    bus.on('presence', onPresence)
    this.unsubscribe = () => {
      bus.off('message', onMessage)
      bus.off('delivery', onDelivery)
      bus.off('system', onSystem)
      bus.off('task', onTask)
      bus.off('presence', onPresence)
    }
  }

  /** Returns true when the request was for /console (handled here), false otherwise. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', 'http://local')
    if (url.pathname !== '/console') return false
    const name = url.searchParams.get('name') ?? ''
    const token = url.searchParams.get('token') ?? ''
    const agent = name ? this.bus.store.getAgent(name) : null
    if (!agent || agent.authority === 'bot' || !verifyToken(token, agent.token_hash)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return true
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.clients.add(ws)
      ws.on('close', () => this.clients.delete(ws))
      ws.on('message', () => undefined) // read-only: ignore anything sent
      ws.send(JSON.stringify({ type: 'hello', agents: this.bus.agents(), now: Date.now() }))
    })
    return true
  }

  get size(): number {
    return this.clients.size
  }

  private broadcast(frame: Record<string, unknown>): void {
    if (!this.clients.size) return
    const text = JSON.stringify(frame)
    for (const c of this.clients) if (c.readyState === WebSocket.OPEN) c.send(text)
  }

  close(): void {
    this.unsubscribe()
    for (const c of this.clients) c.terminate()
    this.wss.close()
  }
}
