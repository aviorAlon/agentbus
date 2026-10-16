import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { TaskState } from '@agentbus/protocol'
import { z } from 'zod'
import {
  generateInviteCode,
  generateToken,
  hashInviteCode,
  hashToken,
  verifyToken,
} from '../auth/token.js'
import type { BlobStore } from '../blobs/blob-store.js'
import type { Bus } from '../bus/bus.js'
import { BusError } from '../bus/errors.js'
import { renderMetrics } from '../bus/metrics.js'
import type { AgentRow } from '../store/store.js'

/**
 * HTTP side of the bus (PRODUCT_DESIGN §5.5):
 *   GET  /healthz
 *   PUT  /api/blobs?name=<n>           body = bytes       → { id, size }      (F-B1–B3)
 *   GET  /api/blobs/<sha>                                 → bytes
 *   POST /api/participants/send        JSON SendInput      → SendResult        (F-X1)
 *   GET  /api/participants/inbox                          → { messages }
 *   GET  /api/participants/receive?timeout_s=30            long-poll inbox
 *   POST /api/participants/ack         { message_ids }     → { deliveries }
 * Every /api route authenticates with `Authorization: Bearer <token>` + `X-Agentbus-Name`.
 */

const SendBody = z.object({
  room: z.string().optional(),
  to: z.string().optional(),
  text: z.string(),
  payload: z.unknown().optional(),
  task_id: z.string().optional(),
  blobs: z.array(z.object({ id: z.string().length(64), name: z.string().min(1) })).optional(),
})
const AckBody = z.object({ message_ids: z.array(z.number().int()).min(1) })

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/** Extra HTTP route: return true when handled. Used by the A2A gateway (packages/a2a). */
export type HttpRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>

export interface HttpOptions {
  /** Directory with the built web console; served under /console/. */
  staticDir?: string
  routes?: HttpRoute[]
  /** For the metrics endpoint. */
  consoleClients?: () => number
  /** Expose GET /metrics (Prometheus text). Default on. */
  metrics?: boolean
}

export function createHttpHandler(bus: Bus, blobs: BlobStore | null, opts: HttpOptions = {}) {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const fail = (res: ServerResponse, e: unknown) => {
    if (e instanceof BusError) {
      const status =
        e.code === 'unauthorized'
          ? 401
          : e.code === 'too_large'
            ? 413
            : e.code === 'unknown_room' || e.code === 'unknown_agent'
              ? 404
              : 400
      json(res, status, { error: { code: e.code, message: e.message } })
    } else json(res, 500, { error: { code: 'internal', message: (e as Error).message } })
  }

  const authenticate = (req: IncomingMessage): AgentRow => {
    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const name = String(req.headers['x-agentbus-name'] ?? '')
    const agent = name ? bus.store.getAgent(name) : null
    if (!token || !agent || !verifyToken(token, agent.token_hash))
      throw new BusError('unauthorized', 'bad token or name')
    return agent
  }

  const readJson = (req: IncomingMessage, limit = 1 << 20): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > limit) {
          req.destroy()
          reject(new BusError('too_large', 'body too large'))
        } else chunks.push(c)
      })
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
        } catch {
          reject(new BusError('bad_request', 'invalid JSON'))
        }
      })
      req.on('error', reject)
    })

  const requireHuman = (req: IncomingMessage): AgentRow => {
    const a = authenticate(req)
    if (a.authority === 'bot') throw new BusError('unauthorized', 'console is for humans')
    return a
  }

  const serveStatic = (res: ServerResponse, rel: string): boolean => {
    if (!opts.staticDir) return false
    const root = resolve(opts.staticDir)
    const clean = rel.replace(/^[\\/]+/, '')
    let file = clean && clean !== '.' ? resolve(root, clean) : join(root, 'index.html')
    if (file !== root && !file.startsWith(root + sep)) return false
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html')
    if (!existsSync(file)) return false
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
    return true
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://local')
    const path = url.pathname
    try {
      if (path === '/healthz') return json(res, 200, { ok: true })
      for (const route of opts.routes ?? []) if (await route(req, res, url)) return

      if (path === '/metrics' && req.method === 'GET' && opts.metrics !== false) {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
        res.end(
          renderMetrics(bus.store, {
            consoleClients: opts.consoleClients?.() ?? 0,
            online: bus.agents().filter((a) => a.online).length,
          }),
        )
        return
      }

      // ---- invites: a human issues a one-time code; another machine redeems it for a token
      if (path === '/api/console/invites' && req.method === 'POST') {
        const human = requireHuman(req)
        const body = z
          .object({
            name: z
              .string()
              .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
              .optional(),
            authority: z.enum(['bot', 'relayer']).default('relayer'),
            backend: z.string().optional(),
            ttl_hours: z
              .number()
              .positive()
              .max(24 * 30)
              .default(24),
          })
          .parse(await readJson(req))
        const code = generateInviteCode()
        const { expires_at } = bus.store.createInvite({
          code_hash: hashInviteCode(code),
          name: body.name ?? null,
          authority: body.authority,
          backend: body.backend ?? null,
          created_by: human.name,
          ttl_ms: body.ttl_hours * 3_600_000,
        })
        bus.store.appendEvent(
          'invite_created',
          { by: human.name, name: body.name ?? null },
          body.name,
        )
        return json(res, 200, { code, name: body.name ?? null, expires_at })
      }
      if (path === '/api/console/invites' && req.method === 'GET') {
        requireHuman(req)
        return json(res, 200, { invites: bus.store.openInvites() })
      }
      if (path === '/api/invites/redeem' && req.method === 'POST') {
        const body = z
          .object({
            code: z.string().min(8),
            name: z
              .string()
              .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
              .optional(),
            backend: z.string().optional(),
          })
          .parse(await readJson(req))
        const name = body.name
        const hash = hashInviteCode(body.code)
        // Validate everything before consuming the code: a bad request must not burn it.
        const peek = bus.store.peekInvite(hash)
        if (!peek?.usable)
          throw new BusError('unauthorized', 'invite unknown, expired or already used')
        const finalName = peek.name ?? name
        if (!finalName)
          throw new BusError('bad_request', 'this invite is not bound to a name; send one')
        const existing = bus.store.getAgent(finalName)
        if (existing?.authority === 'human')
          throw new BusError('bad_request', `${finalName} is a human participant`)
        if (existing && !peek.name)
          throw new BusError('bad_request', `${finalName} already exists; pick another name`)
        const inv = bus.store.redeemInvite(hash, finalName)
        if (!inv) throw new BusError('unauthorized', 'invite unknown, expired or already used')
        const token = generateToken()
        if (existing) bus.store.setTokenHash(finalName, hashToken(token))
        else
          bus.store.createAgent({
            name: finalName,
            token_hash: hashToken(token),
            authority: inv.authority,
            ...((body.backend ?? inv.backend)
              ? { backend: (body.backend ?? inv.backend) as string }
              : {}),
          })
        bus.store.appendEvent('invite_redeemed', { name: finalName }, finalName)
        return json(res, 200, {
          name: finalName,
          token,
          authority: existing?.authority ?? inv.authority,
          created: !existing,
        })
      }

      // ---- agent provisioning (join): a human mints or rotates an agent token
      if (path === '/api/console/agents' && req.method === 'POST') {
        const human = requireHuman(req)
        const body = z
          .object({
            name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
            backend: z.string().optional(),
            authority: z.enum(['bot', 'relayer']).default('bot'),
            rotate: z.boolean().default(false),
          })
          .parse(await readJson(req))
        if (body.name === human.name) throw new BusError('bad_request', 'that is you')
        const existing = bus.store.getAgent(body.name)
        if (existing && existing.authority === 'human')
          throw new BusError('bad_request', `${body.name} is a human participant`)
        const token = generateToken()
        if (existing) {
          if (!body.rotate) throw new BusError('bad_request', `${body.name} exists; pass rotate`)
          bus.store.setTokenHash(body.name, hashToken(token))
        } else {
          bus.store.createAgent({
            name: body.name,
            token_hash: hashToken(token),
            authority: body.authority,
            ...(body.backend ? { backend: body.backend } : {}),
          })
        }
        bus.store.appendEvent(
          existing ? 'token_rotated' : 'agent_created',
          { by: human.name },
          body.name,
        )
        return json(res, 200, { name: body.name, token, created: !existing })
      }

      // ---- console actions (F-H5): pause / resume a room, cancel a task, reply as the human
      const roomAction = /^\/api\/console\/rooms\/(.+)\/(pause|resume|send)$/.exec(path)
      if (roomAction && req.method === 'POST') {
        const human = requireHuman(req)
        const room = decodeURIComponent(roomAction[1] as string)
        const action = roomAction[2]
        if (action === 'pause') return json(res, 200, { paused: bus.pause(room, human.name) })
        if (action === 'resume') return json(res, 200, { resumed: bus.resume(room, human.name) })
        const body = z
          .object({ text: z.string().min(1), task_id: z.string().optional() })
          .parse(await readJson(req))
        return json(
          res,
          200,
          bus.send(
            { name: human.name },
            { room, text: body.text, ...(body.task_id ? { task_id: body.task_id } : {}) },
          ),
        )
      }
      const taskCancel = /^\/api\/console\/tasks\/([^/]+)\/cancel$/.exec(path)
      if (taskCancel && req.method === 'POST') {
        const human = requireHuman(req)
        const body = z.object({ reason: z.string().optional() }).parse(await readJson(req))
        return json(res, 200, {
          task: bus.tasks.cancel(human.name, taskCancel[1] as string, body.reason),
        })
      }

      // ---- web console (read-only)
      if (path === '/' && opts.staticDir) {
        res.writeHead(302, { location: '/console/' })
        res.end()
        return
      }
      if (path === '/console' || path.startsWith('/console/')) {
        if (serveStatic(res, path.replace(/^\/console\/?/, ''))) return
        res.writeHead(404)
        res.end('console not built')
        return
      }
      if (path === '/api/console/snapshot' && req.method === 'GET') {
        requireHuman(req)
        const rooms = bus.store.listRooms().map((r) => ({
          name: r.name,
          kind: r.kind,
          paused: r.paused,
          members: bus.store.members(r.name),
          last: bus.store.history(r.name, 1)[0] ?? null,
        }))
        return json(res, 200, {
          now: Date.now(),
          agents: bus.agents(),
          rooms,
          tasks: bus.store.listTasks({ openOnly: false, limit: 200 }),
          turns: bus.store.recentTurns(50),
          events: bus.store.events({ limit: 200 }),
        })
      }
      const roomHist = /^\/api\/console\/rooms\/(.+)\/messages$/.exec(path)
      if (roomHist && req.method === 'GET') {
        requireHuman(req)
        const room = decodeURIComponent(roomHist[1] as string)
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '100') || 100, 500)
        const before = url.searchParams.get('before')
        const messages = bus.store.history(room, limit, before ? Number(before) : undefined)
        const deliveries = Object.fromEntries(
          messages.map((m) => [m.id, bus.store.deliveriesOf(m.id)]),
        )
        return json(res, 200, { messages, deliveries })
      }
      if (path === '/api/console/tasks' && req.method === 'GET') {
        requireHuman(req)
        const state = url.searchParams.get('state')
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '200') || 200, 500)
        return json(res, 200, {
          tasks: bus.store.listTasks({
            openOnly: url.searchParams.get('all') !== '1',
            ...(state ? { state: TaskState.parse(state) } : {}),
            limit,
          }),
        })
      }
      const taskGet = /^\/api\/console\/tasks\/([^/]+)$/.exec(path)
      if (taskGet && req.method === 'GET') {
        requireHuman(req)
        const task = bus.store.getTask(taskGet[1] as string)
        if (!task) throw new BusError('bad_request', 'no such task')
        return json(res, 200, { task, events: bus.store.taskEvents(task.id) })
      }

      if (path === '/api/blobs' && req.method === 'PUT') {
        const agent = authenticate(req)
        if (!blobs) throw new BusError('not_implemented', 'blob store disabled')
        const mime = req.headers['content-type']
        const r = await blobs.put(req, typeof mime === 'string' ? mime : undefined)
        bus.store.touchActivity(agent.name)
        return json(res, 200, { id: r.id, size: r.size, existed: r.existed })
      }

      const blobGet = /^\/api\/blobs\/([0-9a-f]{64})$/.exec(path)
      if (blobGet && req.method === 'GET') {
        authenticate(req)
        if (!blobs) throw new BusError('not_implemented', 'blob store disabled')
        const { stream, size } = blobs.open(blobGet[1] as string)
        const meta = bus.store.getBlob(blobGet[1] as string)
        res.writeHead(200, {
          'content-type': meta?.mime ?? 'application/octet-stream',
          'content-length': String(size),
        })
        stream.pipe(res)
        return
      }

      if (path === '/api/participants/send' && req.method === 'POST') {
        const agent = authenticate(req)
        const body = SendBody.parse(await readJson(req))
        if ((body.room ? 1 : 0) + (body.to ? 1 : 0) !== 1)
          throw new BusError('bad_request', 'exactly one of room/to')
        return json(res, 200, bus.send({ name: agent.name }, body))
      }

      if (path === '/api/participants/inbox' && req.method === 'GET') {
        const agent = authenticate(req)
        return json(res, 200, { messages: bus.inbox(agent.name) })
      }

      if (path === '/api/participants/receive' && req.method === 'GET') {
        const agent = authenticate(req)
        const timeoutS = Math.min(Number(url.searchParams.get('timeout_s') ?? '30') || 30, 300)
        const deadline = Date.now() + timeoutS * 1000
        for (;;) {
          const messages = bus.inbox(agent.name)
          if (messages.length || Date.now() >= deadline || req.destroyed)
            return json(res, 200, { messages, timed_out: !messages.length })
          await new Promise((r) => setTimeout(r, 250))
        }
      }

      if (path === '/api/participants/ack' && req.method === 'POST') {
        const agent = authenticate(req)
        const body = AckBody.parse(await readJson(req))
        return json(res, 200, { deliveries: bus.ack(agent.name, body.message_ids) })
      }

      res.writeHead(404)
      res.end()
    } catch (e) {
      if (e instanceof z.ZodError) return fail(res, new BusError('bad_request', e.message))
      fail(res, e)
    }
  }
}
