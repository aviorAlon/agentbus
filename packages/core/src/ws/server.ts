import { createServer, type Server as HttpServer } from 'node:http'
import type { ServerFrame } from '@agentbus/protocol'
import { WebSocket, WebSocketServer } from 'ws'
import type { BlobStore } from '../blobs/blob-store.js'
import { type Bus, isPendingResponse } from '../bus/bus.js'
import type { Connection } from '../bus/registry.js'
import { ConsoleStream } from './console.js'
import { createHttpHandler, type HttpRoute } from './http.js'

export interface WsServerOptions {
  bind: string
  port: number
  /** Housekeeping interval (ms). */
  tickMs?: number
  /** Enables PUT/GET /api/blobs. */
  blobs?: BlobStore
  /** Built web console directory, served at /console/. */
  staticDir?: string
  /** Extra HTTP routes (A2A gateway). */
  routes?: HttpRoute[]
  /** Unregistered sockets are closed after this many ms (LAN hardening, F-X2). */
  registerTimeoutMs?: number
}

/**
 * `WS /ws` transport (PRODUCT_DESIGN §5.5). One JSON frame per message; every
 * request gets exactly one response, except `wait`, whose response the bus sends
 * later through the same connection.
 */
export class WsServer {
  readonly http: HttpServer
  readonly wss: WebSocketServer
  readonly console: ConsoleStream
  private ticker: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly bus: Bus,
    private readonly opts: WsServerOptions,
  ) {
    const handler = createHttpHandler(bus, opts.blobs ?? null, {
      ...(opts.staticDir ? { staticDir: opts.staticDir } : {}),
      ...(opts.routes ? { routes: opts.routes } : {}),
      consoleClients: () => this.console.size,
    })
    this.http = createServer((req, res) => {
      void handler(req, res)
    })
    this.console = new ConsoleStream(bus)
    this.wss = new WebSocketServer({ noServer: true })
    this.http.on('upgrade', (req, socket, head) => {
      if (this.console.handleUpgrade(req, socket, head)) return
      const url = new URL(req.url ?? '/', 'http://local')
      if (url.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req))
    })
    this.wss.on('connection', (socket) => this.onConnection(socket))
  }

  private onConnection(socket: WebSocket): void {
    const conn: Connection = {
      send: (frame: ServerFrame) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
      },
      close: (code, reason) => socket.close(code, reason),
    }
    // A socket that never registers holds a slot for nothing; drop it (default 10s).
    const registerTimer = setTimeout(() => {
      if (!this.bus.registry.session(conn)) socket.close(4001, 'register timeout')
    }, this.opts.registerTimeoutMs ?? 10_000)
    socket.on('message', (data) => {
      let raw: unknown
      try {
        raw = JSON.parse(data.toString())
      } catch {
        conn.send({
          type: 'response',
          id: '?',
          ok: false,
          error: { code: 'bad_request', message: 'invalid JSON' },
        })
        return
      }
      const res = this.bus.handleRaw(conn, raw)
      if (!isPendingResponse(res)) conn.send(res)
    })
    socket.on('pong', () => this.bus.registry.touch(conn))
    socket.on('close', () => {
      clearTimeout(registerTimer)
      this.bus.disconnect(conn)
    })
    socket.on('error', () => this.bus.disconnect(conn))
  }

  listen(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject)
      this.http.listen(this.opts.port, this.opts.bind, () => {
        const addr = this.http.address()
        const port = typeof addr === 'object' && addr ? addr.port : this.opts.port
        const tickMs = this.opts.tickMs ?? 10_000
        this.ticker = setInterval(() => {
          for (const client of this.wss.clients)
            if (client.readyState === WebSocket.OPEN) client.ping()
          this.bus.tick()
        }, tickMs)
        resolve({ host: this.opts.bind, port })
      })
    })
  }

  async close(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker)
    this.console.close()
    for (const c of this.wss.clients) c.terminate()
    await new Promise<void>((r) => this.wss.close(() => r()))
    await new Promise<void>((r) => this.http.close(() => r()))
  }
}
