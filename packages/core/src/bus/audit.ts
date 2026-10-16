import type { Store } from '../store/store.js'

export interface AuditOptions {
  room?: string
  /** Unix ms; only records at or after this time. */
  since?: number
  limit?: number
}

/**
 * Audit export (PRODUCT_DESIGN F-O3): one JSON object per line, interleaving messages
 * (with their deliveries), system events and task events, ordered by time. Everything
 * comes from the durable store, so the export is the record, not a log of it.
 */
export function* auditRecords(
  store: Store,
  opts: AuditOptions = {},
): Generator<Record<string, unknown>> {
  const since = opts.since ?? 0
  const limit = opts.limit ?? 10_000
  const rows: { at: number; rec: Record<string, unknown> }[] = []

  const msgSql = `SELECT id FROM messages WHERE created_at >= ? ${opts.room ? 'AND room = ?' : ''} ORDER BY id ASC LIMIT ?`
  const msgArgs = opts.room ? [since, opts.room, limit] : [since, limit]
  for (const r of store.db.prepare(msgSql).all(...msgArgs) as { id: number }[]) {
    const m = store.getMessage(r.id)
    if (!m) continue
    rows.push({
      at: m.created_at,
      rec: { record: 'message', ...m, deliveries: store.deliveriesOf(m.id) },
    })
  }
  for (const e of store.events({ since, limit, ...(opts.room ? { room: opts.room } : {}) })) {
    rows.push({ at: e.at, rec: { record: 'event', ...e } })
  }
  const taskSql = `SELECT id FROM tasks WHERE updated_at >= ? ${opts.room ? 'AND room = ?' : ''} ORDER BY created_at ASC LIMIT ?`
  for (const t of store.db.prepare(taskSql).all(...msgArgs) as { id: string }[]) {
    const task = store.getTask(t.id)
    if (!task) continue
    rows.push({ at: task.created_at, rec: { record: 'task', ...task } })
    for (const ev of store.taskEvents(task.id))
      if (ev.at >= since) rows.push({ at: ev.at, rec: { record: 'task_event', ...ev } })
  }
  for (const t of store.recentTurns(limit)) {
    if (t.started_at < since) continue
    if (opts.room) continue // turns are per agent, not per room
    rows.push({ at: t.started_at, rec: { record: 'driver_turn', ...t } })
  }
  rows.sort((a, b) => a.at - b.at)
  for (const r of rows) yield r.rec
}

export function auditJsonl(store: Store, opts: AuditOptions = {}): string {
  const out: string[] = []
  for (const rec of auditRecords(store, opts)) out.push(JSON.stringify(rec))
  return out.length ? `${out.join('\n')}\n` : ''
}

/** Parse `1h`, `30m`, `2d`, `45s` or an ISO date into a unix ms "since". */
export function parseSince(s: string, now = Date.now()): number {
  const m = /^(\d+)([smhd])$/.exec(s.trim())
  if (m) {
    const n = Number(m[1])
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd']
    return now - n * unit
  }
  const t = Date.parse(s)
  if (Number.isNaN(t))
    throw new Error(`cannot parse --since ${s}; use 1h / 30m / 2d or an ISO date`)
  return t
}
